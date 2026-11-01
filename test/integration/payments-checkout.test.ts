import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CartNotReadyError, InvalidStateError, NotFoundError, ValidationError } from "../../src/lib/errors.ts";
import { createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { quoteProviders } from "../../src/modules/carts/quote.ts";
import { carts } from "../../src/modules/carts/tables.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { createCartPaymentSession, placeOrder } from "../../src/modules/checkout/service.ts";
import { listAvailablePaymentMethods, createPaymentMethod } from "../../src/modules/payments/service.ts";
import { paymentMethods } from "../../src/modules/payments/tables.ts";
import { definePlugin, PLUGIN_API_VERSION, type CheckoutValidateInput } from "../../src/plugins/sdk.ts";
import { createTestApp } from "../helpers/app.ts";
import { createScriptedPsp, type ScriptedPsp } from "../helpers/scripted-psp.ts";

const ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const guest = { customerId: null };

/** Refuses checkouts by blocked customers, the way a fraud or address check would. */
const seen: CheckoutValidateInput[] = [];
const gatekeeper = definePlugin({
  name: "gatekeeper",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  title: "Gatekeeper",
  hooks: {
    checkoutValidate: (input) => {
      seen.push(input);
      return input.email?.startsWith("blocked@") ? [{ code: "CUSTOMER_BLOCKED", message: "This customer cannot order", field: ["email"] }] : [];
    },
  },
});

let t: Awaited<ReturnType<typeof createTestApp>>;
let psp: ScriptedPsp;

beforeAll(async () => {
  psp = createScriptedPsp();
  t = await createTestApp({ plugins: [gatekeeper], paymentProviders: [psp.provider] });
  await createPaymentMethod(t.platform.db, t.platform.payments, { code: "scripted_card", name: { "en-US": "Card" }, provider: "scripted", config: { captureMode: "authorize" }, position: -1 });
});
afterAll(() => t.close());

const cartWith = async (method: string | null, options: { email?: string; sku?: string } = {}) => {
  const db = t.platform.db;
  const cart = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { email: options.email ?? "sam@example.test", lines: [{ sku: options.sku ?? "TOTE-BLACK", quantity: 1 }] });
  await setCartShippingAddress(db, cart.id, { address: ADDRESS }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  await setCartShippingMethod(db, cart.id, "us_standard", guest, quoteProviders(t.platform));
  if (method) await setCartPaymentMethod(db, cart.id, method, guest, quoteProviders(t.platform));
  return cart.id;
};
const storedSession = async (cartId: string) => (await t.platform.db.query.carts.findFirst({ where: eq(carts.id, cartId) }))!.paymentSession;

describe("payment methods at checkout", () => {
  it("offers only methods whose provider is installed and available", async () => {
    await t.platform.db.insert(paymentMethods).values({ code: "uninstalled", name: { "en-US": "Gone" }, provider: "gone_psp" });
    const input = { channelId: (await resolveScope(t.platform.db, { channel: "us" })).channel.id, countryCode: "US", currency: "USD", grandTotal: 5000, locale: "en-US" };
    const offered = await listAvailablePaymentMethods(t.platform.db, input, t.platform.payments);
    expect(offered.map((m) => m.code)).not.toContain("uninstalled");
    expect(offered.find((m) => m.code === "scripted_card")).toEqual({ code: "scripted_card", name: "Card", instructions: null, provider: "scripted", sessionRequired: true });
    expect(offered.find((m) => m.code === "card")).toMatchObject({ provider: "test_gateway", sessionRequired: false });
    expect(psp.callsOf("isAvailable").at(-1)).toEqual({ currency: "USD", countryCode: "US", amount: 5000 });

    psp.setAvailable(false);
    expect((await listAvailablePaymentMethods(t.platform.db, input, t.platform.payments)).map((m) => m.code)).not.toContain("scripted_card");
    const cartId = await cartWith(null);
    await expect(setCartPaymentMethod(t.platform.db, cartId, "scripted_card", guest, quoteProviders(t.platform))).rejects.toBeInstanceOf(ValidationError);
    // A failing check hides the provider's methods, not the cart.
    psp.setAvailable("throw");
    expect((await listAvailablePaymentMethods(t.platform.db, input, t.platform.payments)).map((m) => m.code)).toEqual(expect.arrayContaining(["card", "checkmo"]));
    expect((await listAvailablePaymentMethods(t.platform.db, input, t.platform.payments)).map((m) => m.code)).not.toContain("scripted_card");
    psp.setAvailable(true);
  });
});

describe("payment sessions", () => {
  it("needs a selected payment method, and an open cart of the caller's", async () => {
    await expect(createCartPaymentSession(t.platform, await cartWith(null), guest)).rejects.toMatchObject({ constructor: CartNotReadyError, missing: ["payment_method"] });
    const theirs = await cartWith("scripted_card");
    await t.platform.db.update(carts).set({ customerId: (await t.platform.db.query.customers.findFirst())!.id }).where(eq(carts.id, theirs));
    await expect(createCartPaymentSession(t.platform, theirs, guest)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("is empty for providers without sessions", async () => {
    const cartId = await cartWith("card");
    const session = await createCartPaymentSession(t.platform, cartId, guest);
    expect(session).toEqual({ provider: "test_gateway", methodCode: "card", amount: expect.any(Number), currency: "USD", clientData: {} });
    expect(await storedSession(cartId)).toBeNull();
  });

  it("starts the provider's session for the cart total, then updates it", async () => {
    const cartId = await cartWith("scripted_card");
    const first = await createCartPaymentSession(t.platform, cartId, guest);
    const ref = (await storedSession(cartId))!.data.ref as string;
    expect(first).toEqual({ provider: "scripted", methodCode: "scripted_card", amount: psp.payments.get(ref)!.amount, currency: "USD", clientData: { token: `tok_${ref}` } });
    expect(psp.callsOf("createSession").at(-1)).toMatchObject({
      cartId,
      methodCode: "scripted_card",
      currency: "USD",
      locale: "en-US",
      email: "sam@example.test",
      captureImmediately: false,
      previous: null,
      shippingAddress: expect.objectContaining({ postalCode: "94105" }),
      lines: [expect.objectContaining({ sku: "TOTE-BLACK", quantity: 1 })],
    });
    expect(await storedSession(cartId)).toMatchObject({ provider: "scripted", methodCode: "scripted_card", amount: first.amount, currency: "USD", data: { ref } });

    const again = await createCartPaymentSession(t.platform, cartId, guest);
    expect(psp.callsOf("createSession").at(-1)).toMatchObject({ previous: { ref } });
    expect(again.clientData).toEqual(first.clientData);
  });

  it("is refused once the cart became an order", async () => {
    const cartId = await cartWith("scripted_card");
    await createCartPaymentSession(t.platform, cartId, guest);
    psp.pay((await storedSession(cartId))!.data.ref as string);
    await placeOrder(t.platform, { cartId, idempotencyKey: "session-closed" }, guest);
    await expect(createCartPaymentSession(t.platform, cartId, guest)).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("placing orders with sessions", () => {
  it("authorizes with the cart's session, and returns the order the cart became to any later attempt", async () => {
    const cartId = await cartWith("scripted_card");
    await createCartPaymentSession(t.platform, cartId, guest);
    const ref = (await storedSession(cartId))!.data.ref as string;
    psp.pay(ref);
    const order = await placeOrder(t.platform, { cartId, idempotencyKey: "with-session-1" }, guest);
    expect(order).toMatchObject({ paymentStatus: "authorized", cartId });
    expect(psp.callsOf("authorize").at(-1)).toMatchObject({ orderId: order.id, orderNumber: order.number, cartId, session: { ref }, paymentData: {}, amount: order.grandTotal });
    expect((await placeOrder(t.platform, { cartId, idempotencyKey: "with-session-2" }, guest)).id).toBe(order.id);
    const viaApi = await t.storefront(`mutation($id: ID!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: "with-session-3", payment: {}) { __typename ... on CheckoutPayload { order { number } } } }`, {
      id: `gid://ecom/Cart/${cartId}`,
    });
    expect(viaApi.data.checkoutPlaceOrder).toEqual({ __typename: "CheckoutPayload", order: { number: order.number } });
  });

  it("asks plugins first: a refusal comes back as field errors, and the payment is given back", async () => {
    const cartId = await cartWith("scripted_card", { email: "blocked@example.test" });
    await createCartPaymentSession(t.platform, cartId, guest);
    const ref = (await storedSession(cartId))!.data.ref as string;
    psp.pay(ref);
    await expect(placeOrder(t.platform, { cartId, idempotencyKey: "blocked-1" }, guest)).rejects.toMatchObject({
      constructor: ValidationError,
      message: "This customer cannot order",
      fieldErrors: [{ path: ["email"], message: "This customer cannot order" }],
    });
    expect(seen.at(-1)).toMatchObject({
      cartId,
      email: "blocked@example.test",
      currency: "USD",
      grandTotal: psp.payments.get(ref)!.amount,
      shippingMethodCode: "us_standard",
      paymentMethodCode: "scripted_card",
      shippingAddress: expect.objectContaining({ countryCode: "US" }),
      lines: [expect.objectContaining({ sku: "TOTE-BLACK", quantity: 1, unitPrice: expect.any(Number) })],
    });
    expect(psp.callsOf("void").at(-1)).toEqual({ orderId: "", pspReference: null, session: { ref } });
    expect(psp.payments.get(ref)!.released).toBe(true);
    expect((await t.platform.db.query.carts.findFirst({ where: eq(carts.id, cartId) }))!.status).toBe("active");

    const viaApi = await t.storefront(`mutation($id: ID!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: "blocked-2", payment: {}) { __typename ... on ValidationError { message fieldErrors { path message } } } }`, {
      id: `gid://ecom/Cart/${cartId}`,
    });
    expect(viaApi.data.checkoutPlaceOrder).toEqual({ __typename: "ValidationError", message: "This customer cannot order", fieldErrors: [{ path: ["email"], message: "This customer cannot order" }] });
  });

  it("declines a payment that does not match the order, reopening the cart and giving the payment back", async () => {
    const cartId = await cartWith("scripted_card");
    await createCartPaymentSession(t.platform, cartId, guest);
    const ref = (await storedSession(cartId))!.data.ref as string;
    psp.pay(ref, "captured");
    psp.payments.get(ref)!.amount -= 1;
    await expect(placeOrder(t.platform, { cartId, idempotencyKey: "mismatch-1" }, guest)).rejects.toMatchObject({ declineCode: "amount_mismatch" });
    expect(psp.payments.get(ref)!.released).toBe(true);
    expect((await t.platform.db.query.carts.findFirst({ where: eq(carts.id, cartId) }))!).toMatchObject({ status: "active", convertedOrderId: null });
  });
});
