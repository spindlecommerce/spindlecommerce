import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { quoteProviders } from "../../src/modules/carts/quote.ts";
import { carts } from "../../src/modules/carts/tables.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { createCartPaymentSession, placeOrder } from "../../src/modules/checkout/service.ts";
import { orderEvents, orders } from "../../src/modules/orders/tables.ts";
import { createPaymentMethod } from "../../src/modules/payments/service.ts";
import { paymentTransactions } from "../../src/modules/payments/tables.ts";
import type { PaymentWebhookEvent } from "../../src/plugins/sdk.ts";
import { createTestApp } from "../helpers/app.ts";
import { createScriptedPsp, type ScriptedPsp } from "../helpers/scripted-psp.ts";

const ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const guest = { customerId: null };

let t: Awaited<ReturnType<typeof createTestApp>>;
let psp: ScriptedPsp;
let sequence = 0;

beforeAll(async () => {
  psp = createScriptedPsp();
  t = await createTestApp({ paymentProviders: [psp.provider] });
  await createPaymentMethod(t.platform.db, t.platform.payments, { code: "scripted_card", name: { "en-US": "Card" }, provider: "scripted", config: { captureMode: "authorize" }, position: -1 });
});
afterAll(() => t.close());

const send = async (events: PaymentWebhookEvent[], signature?: string) => t.app.fetch(psp.webhook(events, signature));
const event = (patch: Partial<PaymentWebhookEvent> & Pick<PaymentWebhookEvent, "type" | "pspReference">): PaymentWebhookEvent => ({ id: `evt_${++sequence}`, currency: "USD", ...patch });

/** A ready cart paying with the scripted PSP, its session started. */
const sessionCart = async () => {
  const db = t.platform.db;
  const cart = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { email: "sam@example.test", lines: [{ sku: "TOTE-BLACK", quantity: 1 }] });
  await setCartShippingAddress(db, cart.id, { address: ADDRESS }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  await setCartShippingMethod(db, cart.id, "us_standard", guest, quoteProviders(t.platform));
  await setCartPaymentMethod(db, cart.id, "scripted_card", guest, quoteProviders(t.platform));
  const session = await createCartPaymentSession(t.platform, cart.id, guest);
  const ref = (await db.query.carts.findFirst({ where: eq(carts.id, cart.id) }))!.paymentSession!.data.ref as string;
  return { cartId: cart.id, ref, amount: session.amount };
};
const transactions = (orderId: string) => t.platform.db.select().from(paymentTransactions).where(eq(paymentTransactions.orderId, orderId)).orderBy(paymentTransactions.id);
const reload = async (orderId: string) => (await t.platform.db.query.orders.findFirst({ where: eq(orders.id, orderId) }))!;

describe("payment webhooks", () => {
  it("answers 404 without webhooks, 400 when unverified, 200 for events about nothing", async () => {
    expect((await t.app.fetch(new Request("http://ecom.test/payments/webhooks/offline", { method: "POST", body: "{}" }))).status).toBe(404);
    const unverified = await send([], "forged");
    expect(unverified.status).toBe(400);
    expect(JSON.stringify(await unverified.json())).not.toMatch(/signature/i);
    const unrelated = await send([event({ type: "captured", pspReference: "elsewhere_1", amount: 100 })]);
    expect(unrelated.status).toBe(200);
    expect(await unrelated.json()).toEqual({ received: true });
  });

  it("applies each event once: a pending payment authorized, then captured", async () => {
    const { cartId, ref, amount } = await sessionCart();
    // Still processing at checkout: the order waits for the webhook.
    psp.pay(ref, "pending");
    const order = await placeOrder(t.platform, { cartId, idempotencyKey: "pending-1" }, guest);
    expect(order.paymentStatus).toBe("pending");

    const authorized = event({ type: "authorized", pspReference: ref, amount });
    expect((await send([authorized])).status).toBe(200);
    expect((await send([authorized])).status).toBe(200);
    expect(await reload(order.id)).toMatchObject({ paymentStatus: "authorized", amountAuthorized: amount });
    const captured = event({ type: "captured", pspReference: ref, amount });
    await Promise.all([send([captured]), send([captured])]);
    expect(await reload(order.id)).toMatchObject({ paymentStatus: "paid", amountCaptured: amount });
    expect((await transactions(order.id)).map((x) => [x.kind, x.status, x.referenceKey])).toEqual([
      ["authorization", "pending", null],
      ["authorization", "succeeded", `scripted:${authorized.id}`],
      ["capture", "succeeded", `scripted:${captured.id}`],
    ]);
  });

  it("places the order of a paid cart, unless the cart now pays another way", async () => {
    const paid = await sessionCart();
    psp.pay(paid.ref);
    const authorized = event({ type: "authorized", pspReference: paid.ref, amount: paid.amount, cartId: paid.cartId });
    await send([authorized]);
    const [order] = await t.platform.db.select().from(orders).where(eq(orders.cartId, paid.cartId));
    expect(order).toMatchObject({ paymentStatus: "authorized", idempotencyKey: `${paid.cartId}:scripted:${paid.ref}` });
    expect(psp.callsOf("authorize").at(-1)).toMatchObject({ paymentData: { pspReference: paid.ref }, session: { ref: paid.ref } });
    await send([authorized]);
    expect(await t.platform.db.select().from(orders).where(eq(orders.cartId, paid.cartId))).toHaveLength(1);

    const switched = await sessionCart();
    psp.pay(switched.ref);
    await setCartPaymentMethod(t.platform.db, switched.cartId, "checkmo", guest, quoteProviders(t.platform));
    await send([event({ type: "captured", pspReference: switched.ref, amount: switched.amount, cartId: switched.cartId })]);
    expect(await t.platform.db.select().from(orders).where(eq(orders.cartId, switched.cartId))).toEqual([]);
    expect(psp.callsOf("void").at(-1)).toEqual({ orderId: "", pspReference: switched.ref, session: null });
    expect(psp.payments.get(switched.ref)!.released).toBe(true);
  });

  it("gives back a second payment for a cart whose order paid with another", async () => {
    const { cartId, ref } = await sessionCart();
    psp.pay(ref);
    const order = await placeOrder(t.platform, { cartId, idempotencyKey: "first-payment" }, guest);
    const second = psp.payment(cartId, order.grandTotal, "USD");
    await send([event({ type: "captured", pspReference: second.ref, amount: order.grandTotal, cartId })]);
    expect(second.released).toBe(true);
    expect(await reload(order.id)).toMatchObject({ paymentStatus: "authorized", amountCaptured: 0 });
  });

  it("ignores amounts in another currency, and records cancellations and failures", async () => {
    const { cartId, ref } = await sessionCart();
    psp.pay(ref);
    const order = await placeOrder(t.platform, { cartId, idempotencyKey: "cancel-later" }, guest);
    await send([event({ type: "captured", pspReference: ref, amount: order.grandTotal, currency: "EUR" })]);
    expect((await reload(order.id)).amountCaptured).toBe(0);
    // Failures matter only while payment is awaited.
    await send([event({ type: "failed", pspReference: ref, reason: "Card declined" })]);
    expect((await transactions(order.id)).filter((x) => x.status === "failed")).toEqual([]);
    await send([event({ type: "canceled", pspReference: ref, reason: "expired" })]);
    expect(await reload(order.id)).toMatchObject({ status: "open", paymentStatus: "voided" });
    expect((await transactions(order.id)).at(-1)).toMatchObject({ kind: "void", status: "succeeded", amount: order.grandTotal });
    const history = await t.platform.db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id)).orderBy(orderEvents.id);
    expect(history.at(-1)).toMatchObject({ type: "payment_voided", message: "The payment was canceled at the PSP (expired) (reported by scripted)" });
  });

  it("records a refund by its own reference, once, whichever event reports it", async () => {
    const { cartId, ref } = await sessionCart();
    psp.pay(ref, "captured");
    const order = await placeOrder(t.platform, { cartId, idempotencyKey: "refunds-1" }, guest);
    expect(order.paymentStatus).toBe("paid");
    const refund = (id: string, refundReference: string, amount: number) => event({ id, type: "refunded", pspReference: ref, refundReference, amount });
    await send([refund("evt_r1", "rf_1", 300)]);
    await send([refund("evt_r2", "rf_1", 300), refund("evt_r2", "rf_2", 200)]);
    expect(await reload(order.id)).toMatchObject({ amountRefunded: 500, paymentStatus: "partially_refunded" });
    expect((await transactions(order.id)).filter((x) => x.kind === "refund").map((x) => x.referenceKey)).toEqual(["scripted:refund:rf_1", "scripted:refund:rf_2"]);
    // A refund recorded in the admin carries the PSP's reference: its event changes nothing.
    await t.platform.db.insert(paymentTransactions).values({ orderId: order.id, paymentMethodCode: "scripted_card", provider: "scripted", kind: "refund", status: "succeeded", amount: 100, currency: "USD", pspReference: "rf_admin" });
    await send([refund("evt_r3", "rf_admin", 100)]);
    expect((await reload(order.id)).amountRefunded).toBe(500);
  });
});
