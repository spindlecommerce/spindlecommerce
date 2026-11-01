import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShippingRegistry } from "../../src/modules/shipping/providers.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";
import { createFakeCarrier } from "../helpers/shipping.ts";

const ADDRESS = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;
let carrier: ReturnType<typeof createFakeCarrier>;
let zoneId: string;

beforeAll(async () => {
  t = await createTestApp();
  carrier = createFakeCarrier();
  t.platform.shipping = createShippingRegistry(carrier.provider);
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  auth = bearer(login.data.staffLogin.session.accessToken);
  const zones = await t.admin(`{ shippingZones { id countries } }`, {}, auth);
  zoneId = zones.data.shippingZones.find((z: { countries: string[] }) => z.countries.includes("US")).id;
});
afterAll(() => t.close());

const METHOD = `id code kind provider providerOptions config isActive`;
const createMethod = (code: string, rate: Record<string, unknown>) =>
  t.admin(
    `mutation($input: ShippingMethodInput!) { shippingMethodCreate(input: $input) { __typename ... on ShippingMethodPayload { shippingMethod { ${METHOD} } } ... on ValidationError { fieldErrors { path message } } } }`,
    { input: { code, names: [{ locale: "en-US", value: "Live rates" }], zoneId, rate, position: 5 } },
    auth,
  );

describe("shipping providers in the admin API", () => {
  it("lists providers with the options their methods take", async () => {
    const result = await t.admin(
      `{ shippingProviders { code title plugin builtIn active live canCreateShipment methodOptions { key label type required options { value label } placeholder min max integer defaultValue } } }`,
      {},
      auth,
    );
    const providers = result.data.shippingProviders;
    expect(providers.map((p: { code: string }) => p.code)).toEqual(["flat_rate", "table_rate", "free", "fakeship"]);
    expect(providers[0]).toEqual({ code: "flat_rate", title: "Flat rate", plugin: null, builtIn: true, active: true, live: false, canCreateShipment: false, methodOptions: [] });
    expect(providers[3]).toMatchObject({ code: "fakeship", plugin: "fakeship", builtIn: false, active: true, live: true, canCreateShipment: true });
    expect(providers[3].methodOptions).toEqual([
      { key: "markupPercent", label: "Markup (%)", type: "NUMBER", required: false, options: null, placeholder: null, min: 0, max: 100, integer: false, defaultValue: 0 },
      { key: "service", label: "Services", type: "SELECT", required: false, options: [{ value: "all", label: "All" }, { value: "ground", label: "Ground only" }], placeholder: null, min: null, max: null, integer: null, defaultValue: "all" },
      { key: "account", label: "Account", type: "STRING", required: true, options: null, placeholder: "ACME-1", min: null, max: null, integer: null, defaultValue: null },
    ]);
    carrier.state.active = false;
    const inactive = await t.admin(`{ shippingProviders { code active } }`, {}, auth);
    expect(inactive.data.shippingProviders.find((p: { code: string }) => p.code === "fakeship").active).toBe(false);
    carrier.state.active = true;
  });

  it("creates and edits methods for a plugin provider, checking their options", async () => {
    const invalid = await createMethod("us_live_bad", { provider: { code: "fakeship", options: { markupPercent: 500, service: "rocket" } } });
    expect(invalid.data.shippingMethodCreate).toEqual({
      __typename: "ValidationError",
      fieldErrors: [
        { path: ["input", "config", "options", "markupPercent"], message: "At most 100" },
        { path: ["input", "config", "options", "service"], message: "One of all, ground" },
        { path: ["input", "config", "options", "account"], message: "Required" },
      ],
    });
    const unknown = await createMethod("us_live_bad", { provider: { code: "teleport", options: {} } });
    expect(unknown.data.shippingMethodCreate.fieldErrors).toEqual([{ path: ["input", "config", "kind"], message: "Not one of flat_rate, table_rate, free, fakeship" }]);

    const created = await createMethod("us_live", { provider: { code: "fakeship", options: { markupPercent: "10", account: "ACME-9", stray: true } } });
    const method = created.data.shippingMethodCreate.shippingMethod;
    expect(method).toMatchObject({ code: "us_live", kind: null, provider: "fakeship", providerOptions: { markupPercent: 10, service: "all", account: "ACME-9" }, isActive: true });

    // Changing something else keeps the options; new options are checked again.
    const update = (input: Record<string, unknown>) =>
      t.admin(`mutation($id: ID!, $input: ShippingMethodUpdateInput!) { shippingMethodUpdate(id: $id, input: $input) { __typename ... on ShippingMethodPayload { shippingMethod { ${METHOD} } } } }`, { id: method.id, input }, auth);
    expect((await update({ position: 6 })).data.shippingMethodUpdate.shippingMethod.providerOptions).toEqual({ markupPercent: 10, service: "all", account: "ACME-9" });
    expect((await update({ rate: { provider: { code: "fakeship", options: { account: "ACME-9" } } } })).data.shippingMethodUpdate.shippingMethod.providerOptions).toEqual({ markupPercent: 0, service: "all", account: "ACME-9" });

    const builtIns = await t.admin(`{ shippingMethods { code kind provider providerOptions } }`, {}, auth);
    expect(builtIns.data.shippingMethods.find((m: { code: string }) => m.code === "us_standard")).toEqual({ code: "us_standard", kind: "FLAT_RATE", provider: "flat_rate", providerOptions: null });
  });

  it("offers live rates at checkout and buys a label when staff fulfil", async () => {
    const cart = await t.storefront(`mutation { cartCreate(input: { email: "ana@example.test", lines: [{ sku: "TOTE-GREEN", quantity: 1 }] }) { ... on CartPayload { cart { id } } } }`);
    const id = cart.data.cartCreate.cart.id;
    const set = await t.storefront(
      `mutation($id: ID!, $a: AddressInput!) {
        a: cartShippingAddressSet(cartId: $id, address: { address: $a }) { __typename }
        b: cartBillingAddressSet(cartId: $id, address: { sameAsShipping: true }) { __typename }
        c: cartShippingMethodSet(cartId: $id, shippingMethodCode: "us_live:express") { __typename ... on CartPayload { cart { selectedShippingMethod { code name carrier price { amount } minDeliveryDays maxDeliveryDays } availableShippingMethods { code } } } }
        d: cartPaymentMethodSet(cartId: $id, paymentMethodCode: "card") { __typename }
      }`,
      { id, a: ADDRESS },
    );
    expect(set.data.c.cart).toEqual({
      selectedShippingMethod: { code: "us_live:express", name: "FakeShip Express", carrier: "FakeShip", price: { amount: "15.00" }, minDeliveryDays: 1, maxDeliveryDays: 1 },
      availableShippingMethods: [{ code: "us_standard" }, { code: "us_express" }, { code: "us_live:ground" }, { code: "us_live:express" }],
    });
    const placed = await t.storefront(`mutation($id: ID!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: "admin-live-0001") { __typename ... on CheckoutPayload { order { id number shippingMethod { code carrier } } } } }`, { id });
    const order = placed.data.checkoutPlaceOrder.order;
    expect(order.shippingMethod).toEqual({ code: "us_live:express", carrier: "FakeShip" });

    const detail = await t.admin(`query($n: String!) { order(number: $n) { shippingMethod { provider } shipmentProviders { code title } } }`, { n: order.number }, auth);
    expect(detail.data.order).toEqual({ shippingMethod: { provider: "fakeship" }, shipmentProviders: [{ code: "fakeship", title: "FakeShip" }] });

    const fulfil = (input: Record<string, unknown>) =>
      t.admin(
        `mutation($id: ID!, $input: OrderFulfillInput) { orderFulfill(orderId: $id, input: $input) { __typename ... on InvalidStateError { message } ... on OrderPayload { order { fulfillmentStatus fulfillments { tracking { carrier number url } shipment { provider providerTitle labelUrl cost { amount currencyCode } } } } } } }`,
        { id: order.id, input },
        auth,
      );
    carrier.state.shipmentError = new Error("no pickup today");
    expect((await fulfil({ createShipment: true })).data.orderFulfill).toEqual({ __typename: "InvalidStateError", message: "FakeShip could not book the shipment: no pickup today" });
    carrier.state.shipmentError = null;

    const shipped = (await fulfil({ createShipment: true })).data.orderFulfill.order;
    expect(shipped.fulfillmentStatus).toBe("FULFILLED");
    expect(shipped.fulfillments).toEqual([
      {
        tracking: [{ carrier: "FakeShip", number: "FS0002", url: "https://fakeship.test/track/FS0002" }],
        shipment: { provider: "fakeship", providerTitle: "FakeShip", labelUrl: "https://labels.fakeship.test/2.pdf", cost: { amount: "6.40", currencyCode: "USD" } },
      },
    ]);
  });
});
