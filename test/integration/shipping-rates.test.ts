import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CartNotReadyError } from "../../src/lib/errors.ts";
import { buildQuote, quoteProviders } from "../../src/modules/carts/quote.ts";
import { addCartLines, applyCartCoupon, createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { placeOrder } from "../../src/modules/checkout/service.ts";
import { placeDraftOrder, quoteDraftOrder } from "../../src/modules/orders/draft.ts";
import type { PaymentProvider } from "../../src/modules/payments/providers.ts";
import { createPaymentMethod } from "../../src/modules/payments/service.ts";
import { createPromotion } from "../../src/modules/promotions/service.ts";
import { createShippingRegistry, type ShippingProvider } from "../../src/modules/shipping/providers.ts";
import { CHECKOUT_RATE_GRACE_SECONDS } from "../../src/modules/shipping/rates.ts";
import { createShippingMethod, listShippingZones } from "../../src/modules/shipping/service.ts";
import { shippingRateCache } from "../../src/modules/shipping/tables.ts";
import { createTestPlatform, type TestPlatform } from "../helpers/platform.ts";
import { addLiveMethod, createFakeCarrier, recordingLogger } from "../helpers/shipping.ts";

const CA_ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const guest = { customerId: null };
const staff = { type: "staff" as const, id: null };

let t: TestPlatform;
let carrier: ReturnType<typeof createFakeCarrier>;
/**
 * Available below 100.00 and, like a plugin's provider reading its settings, asks the database on
 * the platform's own connection: inside a transaction on PGlite, that would never return.
 */
const picky: PaymentProvider = {
  code: "picky",
  isAvailable: async ({ amount }) => (await t.platform.db.query.paymentMethods.findMany()).length > 0 && amount < 10_000,
  authorize: async () => ({ status: "pending", pspReference: null }),
  capture: async () => ({ pspReference: null }),
  refund: async () => ({ pspReference: null }),
  void: async () => ({ pspReference: null }),
};
beforeAll(async () => {
  t = await createTestPlatform({ paymentProviders: [picky] });
  carrier = createFakeCarrier();
  await addLiveMethod(t.platform, [carrier.provider]);
});
afterAll(() => t.close());
beforeEach(() => {
  carrier.state.active = true;
  carrier.state.fail = false;
});

const live = () => quoteProviders(t.platform);
const calls = () => carrier.state.rateCalls.length;
const expireCache = (secondsAgo: number) => t.platform.db.update(shippingRateCache).set({ expiresAt: new Date(Date.now() - secondsAgo * 1000) });

/** A US guest cart with an address; distinct contents give distinct cache keys. */
const cartWith = async (lines: { sku: string; quantity: number }[], address = CA_ADDRESS) => {
  const db = t.platform.db;
  const cart = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { email: "sam@example.test", lines });
  await setCartShippingAddress(db, cart.id, { address }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  return cart;
};

describe("shipping rates through providers", () => {
  it("keeps built-in methods' codes, amounts and order", async () => {
    const cart = await cartWith([{ sku: "TOTE-BLACK", quantity: 1 }]);
    const rates = (await buildQuote(t.platform.db, cart.id, live())).shippingRates;
    expect(rates.map((r) => [r.code, r.amount, r.carrier, r.name])).toEqual([
      ["us_standard", 599, "flat_rate", "Standard (5–7 days)"],
      ["us_express", 1499, "table_rate", "Express (1–2 days)"],
      ["us_live:ground", 900, "FakeShip", "FakeShip Ground"],
      ["us_live:express", 1500, "FakeShip", "FakeShip Express"],
    ]);
    expect(rates[0]).toMatchObject({ minDeliveryDays: 5, maxDeliveryDays: 7, details: { provider: "flat_rate", method: "us_standard", rate: "us_standard", data: {} } });
    // Without the plugin's provider (e.g. the plugin removed), its method offers nothing.
    const builtInOnly = (await buildQuote(t.platform.db, cart.id)).shippingRates;
    expect(builtInOnly.map((r) => r.code)).toEqual(["us_standard", "us_express"]);
  });

  it("asks the provider with the method's options, the cart and both addresses", async () => {
    const before = calls();
    const cart = await cartWith([{ sku: "SOCK-BLUE", quantity: 3 }]);
    const rates = (await buildQuote(t.platform.db, cart.id, live())).shippingRates;
    expect(calls()).toBe(before + 1);
    const request = carrier.state.rateCalls.at(-1)!;
    expect(request).toMatchObject({
      method: { code: "us_live", name: "Live carrier rates", options: { account: "ACME-1", markupPercent: 0, service: "all" } },
      currency: "USD",
      locale: "en-US",
      weightGrams: 240,
      quantity: 3,
      destination: CA_ADDRESS,
      origin: { city: "Newark", regionCode: "NJ", postalCode: "07102", countryCode: "US" },
      lines: [{ sku: "SOCK-BLUE", quantity: 3, weightGrams: 80 }],
    });
    expect(request.lines[0]!.unitPrice).toBeGreaterThan(0);
    expect(rates.find((r) => r.code === "us_live:ground")).toEqual({
      code: "us_live:ground",
      name: "FakeShip Ground",
      description: null,
      carrier: "FakeShip",
      amount: 740,
      minDeliveryDays: 3,
      maxDeliveryDays: 5,
      taxClassId: null,
      details: { provider: "fakeship", method: "us_live", rate: "ground", data: { rateId: expect.stringMatching(/^ground_/) } },
    });
  });

  it("serves repeated reads from the cache and asks again when the cart changes or the rates expire", async () => {
    const db = t.platform.db;
    const cart = await cartWith([{ sku: "TOTE-GREEN", quantity: 1 }]);
    const before = calls();
    await buildQuote(db, cart.id, live());
    await buildQuote(db, cart.id, live());
    expect(calls()).toBe(before + 1);
    // Rates are cached by what they depend on, not by cart: an identical cart is a hit.
    const twin = await cartWith([{ sku: "TOTE-GREEN", quantity: 1 }]);
    await buildQuote(db, twin.id, live());
    expect(calls()).toBe(before + 1);

    await addCartLines(db, cart.id, [{ sku: "SOCK-BLACK", quantity: 1 }], guest);
    const changed = await buildQuote(db, cart.id, live());
    expect(calls()).toBe(before + 2);
    expect(changed.shippingRates.find((r) => r.code === "us_live:ground")?.amount).toBe(500 + 400 + 80);

    await expireCache(1);
    await buildQuote(db, cart.id, live());
    expect(calls()).toBe(before + 3);
  });

  it("prices checkout from cached rates only, up to an hour past their expiry", async () => {
    const db = t.platform.db;
    const ready = async (sku: string) => {
      const cart = await cartWith([{ sku, quantity: 2 }]);
      await setCartShippingMethod(db, cart.id, "us_live:ground", guest, live());
      await setCartPaymentMethod(db, cart.id, "card", guest, live());
      return cart;
    };

    const fresh = await ready("TEE-BLACK-S");
    const before = calls();
    const order = await placeOrder(t.platform, { cartId: fresh.id, idempotencyKey: "live-rates-1" }, guest);
    expect(calls()).toBe(before);
    expect(order.shippingTotal).toBe(500 + 500);
    expect(order.shippingMethod).toEqual({
      code: "us_live:ground",
      name: "FakeShip Ground",
      carrier: "FakeShip",
      amount: 1000,
      details: { provider: "fakeship", method: "us_live", rate: "ground", data: { rateId: expect.stringMatching(/^ground_/) } },
    });

    const stale = await ready("TEE-BLACK-M");
    await expireCache(CHECKOUT_RATE_GRACE_SECONDS - 600);
    await expect(placeOrder(t.platform, { cartId: stale.id, idempotencyKey: "live-rates-2" }, guest)).resolves.toMatchObject({ shippingTotal: 1000 });

    const tooStale = await ready("TEE-BLACK-L");
    await expireCache(CHECKOUT_RATE_GRACE_SECONDS + 60);
    const callsBefore = calls();
    await expect(placeOrder(t.platform, { cartId: tooStale.id, idempotencyKey: "live-rates-3" }, guest)).rejects.toMatchObject({ constructor: CartNotReadyError, missing: ["shipping_method"] });
    expect(calls()).toBe(callsBefore);
    // Reading the cart fetches fresh rates under the same code, so the customer's choice holds.
    expect((await buildQuote(db, tooStale.id, live())).selectedShippingRate?.code).toBe("us_live:ground");
    await expect(placeOrder(t.platform, { cartId: tooStale.id, idempotencyKey: "live-rates-4" }, guest)).resolves.toMatchObject({ shippingTotal: 1000 });
  });

  it("drops cached rates that checkout can no longer use when it writes new ones", async () => {
    const db = t.platform.db;
    const { logger, warnings } = recordingLogger();
    const old = new Date(Date.now() - (CHECKOUT_RATE_GRACE_SECONDS + 60) * 1000);
    const recent = new Date(Date.now() - 60_000);
    await db.insert(shippingRateCache).values([
      { key: "unusable", rates: [], expiresAt: old },
      { key: "still-usable", rates: [], expiresAt: recent },
    ]);
    const cart = await cartWith([{ sku: "TEE-BLACK-XL", quantity: 1 }]);
    await buildQuote(db, cart.id, { ...live(), logger });
    const keys = (await db.select({ key: shippingRateCache.key }).from(shippingRateCache)).map((r) => r.key);
    expect(keys).not.toContain("unusable");
    expect(keys).toContain("still-usable");
    expect(warnings).toEqual([]);
  });

  it("gives a failing or inactive provider's methods no rates and logs failures", async () => {
    const { logger, warnings } = recordingLogger();
    const cart = await cartWith([{ sku: "BOOK-TRAIL-GUIDE", quantity: 1 }]);
    carrier.state.fail = true;
    const failed = await buildQuote(t.platform.db, cart.id, { ...live(), logger });
    expect(failed.shippingRates.map((r) => r.code)).toEqual(["us_standard", "us_express"]);
    expect(warnings).toEqual([expect.objectContaining({ message: expect.stringContaining("Live shipping rates failed"), data: expect.objectContaining({ provider: "fakeship", method: "us_live" }) })]);

    // A failure caches nothing: the next read asks again.
    carrier.state.fail = false;
    expect((await buildQuote(t.platform.db, cart.id, live())).shippingRates.map((r) => r.code)).toContain("us_live:ground");
    carrier.state.active = false;
    const before = calls();
    expect((await buildQuote(t.platform.db, cart.id, live())).shippingRates.map((r) => r.code)).toEqual(["us_standard", "us_express"]);
    expect(calls()).toBe(before);
  });

  it("keeps valid quotes with unique codes from a sloppy provider", async () => {
    const { logger, warnings } = recordingLogger();
    const sloppy: ShippingProvider = {
      code: "sloppy",
      title: "Sloppy",
      plugin: "sloppy",
      rates: async () => [
        { code: "half", name: "Half a cent", amount: 5.5 },
        { code: "ok", name: "Fine", amount: 300, data: { at: new Date(0) } },
        { code: "ok", name: "Duplicate", amount: 200 },
      ],
    };
    const registry = t.platform.shipping;
    t.platform.shipping = createShippingRegistry(carrier.provider, sloppy);
    try {
      const zone = (await listShippingZones(t.platform.db)).find((z) => z.countries.includes("US"))!;
      await createShippingMethod(t.platform.db, { code: "us_sloppy", name: { "en-US": "Sloppy" }, zoneId: zone.id, config: { kind: "sloppy", options: {} }, position: 9 }, t.platform.shipping);
      const cart = await cartWith([{ sku: "SOCK-BLACK", quantity: 7 }]);
      const rates = (await buildQuote(t.platform.db, cart.id, { ...live(), logger })).shippingRates.filter((r) => r.code.startsWith("us_sloppy"));
      expect(rates).toMatchObject([{ code: "us_sloppy:ok", name: "Fine", amount: 300, carrier: "sloppy", details: { data: { at: "1970-01-01T00:00:00.000Z" } } }]);
      expect(warnings.map((w) => w.message)).toEqual(["Dropped an invalid shipping rate"]);
    } finally {
      t.platform.shipping = registry;
    }
  });

  it("prices staff drafts with live rates fetched outside the draft's transaction", async () => {
    const db = t.platform.db;
    const channelId = t.seed.channels.us.id;
    const variant = await db.query.productVariants.findFirst({ where: (v, { eq }) => eq(v.sku, "SOCK-BLUE") });
    const draft = { channelId, email: "phone@example.test", lines: [{ variantId: variant!.id, quantity: 5 }], shippingAddress: CA_ADDRESS, billingSameAsShipping: true, paymentMethodCode: "checkmo", shippingMethodCode: "us_live:express" };
    const before = calls();
    const quote = await quoteDraftOrder(db, draft, live());
    expect(calls()).toBe(before + 1);
    expect(quote.shippingRates.map((r) => r.code)).toEqual(["us_standard", "us_express", "us_live:ground", "us_live:express"]);
    expect(quote).toMatchObject({ selectedShippingMethodCode: "us_live:express", shippingTotal: 1500, missing: [] });
    await quoteDraftOrder(db, draft, live());
    expect(calls()).toBe(before + 1);

    const order = await placeDraftOrder(t.platform, draft, staff, "Test Staff");
    expect(order.shippingMethod).toMatchObject({ code: "us_live:express", amount: 1500, details: { provider: "fakeship", rate: "express" } });
    expect(calls()).toBe(before + 1);
  });

  it("checks a draft's payment methods with their providers after its transaction", async () => {
    const db = t.platform.db;
    await createPaymentMethod(db, t.platform.payments, { code: "picky_pay", name: { "en-US": "Picky pay" }, provider: "picky", position: 9 });
    const variant = await db.query.productVariants.findFirst({ where: (v, { eq }) => eq(v.sku, "SOCK-BLACK") });
    const draft = (quantity: number) => ({
      channelId: t.seed.channels.us.id,
      email: "phone@example.test",
      lines: [{ variantId: variant!.id, quantity }],
      shippingAddress: CA_ADDRESS,
      billingSameAsShipping: true,
      shippingMethodCode: "us_standard",
      paymentMethodCode: "picky_pay",
    });
    const small = await quoteDraftOrder(db, draft(1), live());
    expect(small.paymentMethods.map((m) => m.code)).toContain("picky_pay");
    expect(small.missing).toEqual([]);
    const large = await quoteDraftOrder(db, draft(10), live());
    expect(large.grandTotal).toBeGreaterThan(10_000);
    expect(large.paymentMethods.map((m) => m.code)).not.toContain("picky_pay");
    expect(large.missing).toEqual(["payment_method"]);
  });

  it("matches shipping promotions on the method, whichever of its rates is chosen", async () => {
    const db = t.platform.db;
    await createPromotion(db, { name: "Free live shipping", priority: 60, requiresCoupon: true, couponCodes: ["LIVEFREE"], action: { type: "shipping_off", percent: 100, methodCodes: ["us_live"] } });
    const cart = await cartWith([{ sku: "TOTE-BLACK", quantity: 3 }]);
    await setCartShippingMethod(db, cart.id, "us_live:express", guest, live());
    await applyCartCoupon(db, cart.id, "LIVEFREE", guest, live());
    const quote = await buildQuote(db, cart.id, live());
    expect(quote.coupons).toEqual([{ code: "LIVEFREE", applied: true, reason: null }]);
    expect(quote.totals).toMatchObject({ shippingAmount: 1500, shippingDiscount: 1500, shippingTotal: 0 });
  });
});
