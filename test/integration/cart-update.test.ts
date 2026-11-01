import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShippingMethod, listShippingZones } from "../../src/modules/shipping/service.ts";
import { createTestApp } from "../helpers/app.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const CART = `id version email missing billingSameAsShipping
  lines { id }
  shippingAddress { firstName line1 postalCode countryCode }
  billingAddress { firstName postalCode countryCode }
  availableShippingMethods { code }
  selectedShippingMethod { code }
  cost { shipping { amount } tax { amount } total { amount } }`;

const UPDATE = `mutation($id: ID!, $input: CartUpdateInput!) {
  cartUpdate(cartId: $id, input: $input) {
    __typename
    ... on CartPayload { cart { ${CART} } }
    ... on ValidationError { message fieldErrors { path message } }
  }
}`;

/** Five tees: $110.00, enough for free shipping in the US. */
const newCart = async () => {
  const { data } = await t.storefront(`mutation { cartCreate(input: { lines: [{ sku: "TEE-BLACK-M", quantity: 5 }] }) { ... on CartPayload { cart { id } } } }`);
  return data.cartCreate.cart.id as string;
};
const update = async (id: string, input: Record<string, unknown>) => (await t.storefront(UPDATE, { id, input })).data.cartUpdate;

const sam = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };

describe("cartUpdate", () => {
  it("prices shipping and tax while the address is still being typed", async () => {
    const id = await newCart();
    const country = await update(id, { shippingAddress: { address: { countryCode: "US" } } });
    expect(country.cart).toMatchObject({ availableShippingMethods: [], selectedShippingMethod: null, missing: ["EMAIL", "SHIPPING_ADDRESS", "SHIPPING_METHOD", "PAYMENT_METHOD"] });

    // A state and ZIP code are enough for rates and tax, and the cheapest rate is selected.
    const zip = await update(id, { shippingAddress: { address: { countryCode: "US", regionCode: "CA", postalCode: "94105", firstName: " Sam ", line1: "" } } });
    expect(zip.cart).toMatchObject({
      shippingAddress: { firstName: "Sam", line1: null, postalCode: "94105", countryCode: "US" },
      availableShippingMethods: [{ code: "us_free" }, { code: "us_standard" }, { code: "us_express" }],
      selectedShippingMethod: { code: "us_free" },
      cost: { shipping: { amount: "0.00" }, tax: { amount: "7.98" }, total: { amount: "117.98" } },
      // The billing address follows the shipping address.
      billingSameAsShipping: true,
      billingAddress: { firstName: "Sam", postalCode: "94105", countryCode: "US" },
      missing: ["EMAIL", "SHIPPING_ADDRESS", "PAYMENT_METHOD"],
    });
  });

  it("reports every invalid field at once and saves none of them", async () => {
    const id = await newCart();
    const before = await update(id, { email: "keep@example.test" });
    const result = await update(id, {
      email: "changed@example.test",
      shippingAddress: { address: { countryCode: "US", line1: "x".repeat(201) } },
      billingAddress: { address: { countryCode: "US", postalCode: "9".repeat(21) } },
    });
    expect(result.__typename).toBe("ValidationError");
    expect(result.fieldErrors.map((e: { path: string[] }) => e.path)).toEqual([
      ["input", "shippingAddress", "address", "line1"],
      ["input", "billingAddress", "address", "postalCode"],
    ]);
    const after = await t.storefront(`query($id: ID!) { cart(id: $id) { version email } }`, { id });
    expect(after.data.cart).toEqual({ version: before.cart.version, email: "keep@example.test" });

    const abroad = await update(id, { shippingAddress: { address: { countryCode: "JP" } } });
    expect(abroad).toMatchObject({ message: "We do not ship to this country", fieldErrors: [{ path: ["input", "shippingAddress", "address", "countryCode"] }] });
  });

  it("keeps a chosen shipping method until the address cannot use it", async () => {
    const id = await newCart();
    const express = await update(id, { shippingAddress: { address: sam }, shippingMethodCode: "us_express" });
    expect(express.cart.selectedShippingMethod).toEqual({ code: "us_express" });
    const moved = await update(id, { shippingAddress: { address: { ...sam, line1: "1 Market St" } } });
    expect(moved.cart.selectedShippingMethod).toEqual({ code: "us_express" });

    // Canada has its own rates: the choice goes, and the cheapest Canadian rate is selected.
    const canada = await update(id, { shippingAddress: { address: { ...sam, city: "Toronto", regionCode: "ON", postalCode: "M5V 2T6", countryCode: "CA" } } });
    expect(canada.cart).toMatchObject({ availableShippingMethods: [{ code: "ca_standard" }], selectedShippingMethod: { code: "ca_standard" } });
    const unavailable = await update(id, { shippingMethodCode: "us_express" });
    expect(unavailable).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "shippingMethodCode"], message: "Available: ca_standard" }] });
  });

  it("never swaps a chosen rate for another", async () => {
    const id = await newCart();
    const free = await update(id, { shippingAddress: { address: sam }, shippingMethodCode: "us_free" });
    // One tee is under the free shipping minimum.
    const fewer = await t.storefront(`mutation($id: ID!, $line: ID!) { cartLinesUpdate(cartId: $id, lines: [{ lineId: $line, quantity: 1 }]) { ... on CartPayload { cart { selectedShippingMethod { code } missing } } } }`, {
      id,
      line: free.cart.lines[0].id,
    });
    expect(fewer.data.cartLinesUpdate.cart).toEqual({ selectedShippingMethod: null, missing: ["EMAIL", "SHIPPING_METHOD", "PAYMENT_METHOD"] });
    // Null goes back to the cheapest rate.
    const automatic = await update(id, { shippingMethodCode: null });
    expect(automatic.cart.selectedShippingMethod).toEqual({ code: "us_standard" });
  });

  it("bills to the shipping address unless the cart has its own", async () => {
    const id = await newCart();
    const own = await update(id, { shippingAddress: { address: sam }, billingAddress: { address: { countryCode: "CA", firstName: "Sam" } } });
    expect(own.cart).toMatchObject({ billingSameAsShipping: false, billingAddress: { firstName: "Sam", postalCode: null, countryCode: "CA" } });
    expect(own.cart.missing).toContain("BILLING_ADDRESS");
    const same = await update(id, { billingAddress: { sameAsShipping: true } });
    expect(same.cart).toMatchObject({ billingSameAsShipping: true, billingAddress: { postalCode: "94105", countryCode: "US" } });
    expect(same.cart.missing).not.toContain("BILLING_ADDRESS");
  });
});

describe("checkoutPlaceOrder with input", () => {
  it("takes every detail in one call and places the order with them", async () => {
    const id = await newCart();
    const { data } = await t.storefront(`mutation($id: ID!, $input: CartUpdateInput!) {
      checkoutPlaceOrder(cartId: $id, idempotencyKey: "one-call-1", input: $input, payment: { token: "tok_visa" }) {
        __typename
        ... on CheckoutPayload { order { email paymentStatus shippingMethod { code } shippingAddress { line1 } billingAddress { line1 } totals { total { amount } } } }
      }
    }`, { id, input: { email: "Sam@Example.test", shippingAddress: { address: sam }, paymentMethodCode: "card" } });
    expect(data.checkoutPlaceOrder).toEqual({
      __typename: "CheckoutPayload",
      order: {
        email: "sam@example.test",
        paymentStatus: "AUTHORIZED",
        shippingMethod: { code: "us_free" },
        shippingAddress: { line1: "500 Howard St" },
        billingAddress: { line1: "500 Howard St" },
        totals: { total: { amount: "117.98" } },
      },
    });
  });

  it("says field by field what checkout still needs", async () => {
    const id = await newCart();
    const { data } = await t.storefront(`mutation($id: ID!, $input: CartUpdateInput!) {
      checkoutPlaceOrder(cartId: $id, idempotencyKey: "not-ready-1", input: $input) { __typename ... on CartNotReadyError { missing fieldErrors { path message } } }
    }`, { id, input: { email: "sam@example.test", shippingAddress: { address: { countryCode: "US", firstName: "Sam", postalCode: "94105" } } } });
    expect(data.checkoutPlaceOrder).toEqual({
      __typename: "CartNotReadyError",
      missing: ["SHIPPING_ADDRESS", "PAYMENT_METHOD"],
      fieldErrors: [
        { path: ["shippingAddress", "address", "lastName"], message: "Required" },
        { path: ["shippingAddress", "address", "line1"], message: "Required" },
        { path: ["shippingAddress", "address", "city"], message: "Required" },
        { path: ["paymentMethodCode"], message: "Required" },
      ],
    });
    // The details stay on the cart.
    const cart = await t.storefront(`query($id: ID!) { cart(id: $id) { email shippingAddress { firstName } } }`, { id });
    expect(cart.data.cart).toEqual({ email: "sam@example.test", shippingAddress: { firstName: "Sam" } });
  });
});

describe("moving a cart to another of its channel's currencies and languages", () => {
  const EU = { "x-channel": "eu", "x-locale": "en-GB", "x-currency": "EUR" };
  const MOVE = `mutation($id: ID!, $input: CartUpdateInput!) {
    cartUpdate(cartId: $id, input: $input) {
      __typename
      ... on CartPayload { cart { currencyCode locale lines { name unitPrice { amount currencyCode } } availableShippingMethods { code } selectedShippingMethod { code price { amount currencyCode } } } }
      ... on ValidationError { message fieldErrors { path message } }
    }
  }`;
  const euCart = async (sku: string) => {
    const { data } = await t.storefront(`mutation($sku: String!) { cartCreate(input: { lines: [{ sku: $sku, quantity: 1 }] }) { ... on CartPayload { cart { id } } } }`, { sku }, EU);
    return data.cartCreate.cart.id as string;
  };
  const move = async (id: string, input: Record<string, unknown>) => (await t.storefront(MOVE, { id, input }, EU)).data.cartUpdate;

  it("re-prices the lines in the new currency and names them in the new language", async () => {
    // €139.00, or £125.00 of its own.
    const runner = await euCart("TRL-BLACK-41");
    expect((await move(runner, { currencyCode: "GBP" })).cart).toMatchObject({ currencyCode: "GBP", locale: "en-GB", lines: [{ unitPrice: { amount: "125.00", currencyCode: "GBP" } }] });
    const shirt = await euCart("OXF-WHITE-S");
    const german = (await move(shirt, { locale: "de-DE" })).cart;
    expect(german).toMatchObject({ currencyCode: "EUR", locale: "de-DE" });
    expect(german.lines[0].name).toContain("Oxford-Hemd");
  });

  it("refuses a currency or language the channel does not offer", async () => {
    const id = await euCart("OXF-WHITE-S");
    const result = await move(id, { currencyCode: "USD", locale: "en-US" });
    expect(result).toMatchObject({
      __typename: "ValidationError",
      fieldErrors: [
        { path: ["input", "currencyCode"], message: "Available: EUR, GBP" },
        { path: ["input", "locale"], message: "Available: de-DE, en-GB, fr-FR" },
      ],
    });
  });

  it("keeps a chosen shipping rate the new currency offers, at its price there", async () => {
    // €59.00 (£50.74): under the free delivery threshold in both currencies.
    const id = await euCart("OXF-WHITE-S");
    const chosen = await move(id, { shippingAddress: { address: { countryCode: "DE", postalCode: "10115" } }, shippingMethodCode: "eu_standard" });
    expect(chosen.cart.selectedShippingMethod).toEqual({ code: "eu_standard", price: { amount: "4.90", currencyCode: "EUR" } });
    expect((await move(id, { currencyCode: "GBP" })).cart.selectedShippingMethod).toEqual({ code: "eu_standard", price: { amount: "4.25", currencyCode: "GBP" } });
  });

  it("drops a chosen shipping rate the new currency does not offer", async () => {
    const zone = (await listShippingZones(t.platform.db)).find((z) => z.countries.includes("DE"))!;
    await createShippingMethod(t.platform.db, { code: "eu_courier", name: { "en-GB": "Courier" }, zoneId: zone.id, channelIds: [t.seed.channels.eu.id], config: { kind: "flat_rate", amounts: { EUR: 990 }, per: "order" }, position: 3 });
    const id = await euCart("OXF-WHITE-S");
    const chosen = await move(id, { shippingAddress: { address: { countryCode: "DE", postalCode: "10115" } }, shippingMethodCode: "eu_courier" });
    expect(chosen.cart.selectedShippingMethod).toMatchObject({ code: "eu_courier" });
    // The courier has no pound price: the cart falls back to the cheapest rate it has.
    const moved = (await move(id, { currencyCode: "GBP" })).cart;
    expect(moved.availableShippingMethods).toEqual([{ code: "eu_standard" }]);
    expect(moved.selectedShippingMethod).toMatchObject({ code: "eu_standard" });
  });
});
