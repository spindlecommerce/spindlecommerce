/** The npm Shippo plugin in the platform. Its own tests are in spindlecommerce/plugin-shippo. */
import { shippo } from "@spindlecommerce/plugin-shippo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quoteProviders, buildQuote } from "../../src/modules/carts/quote.ts";
import { createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { placeOrder } from "../../src/modules/checkout/service.ts";
import { getFulfillmentsByOrderIds } from "../../src/modules/orders/read.ts";
import { shipOrder } from "../../src/modules/orders/service.ts";
import { createShippingMethod, listShippingZones } from "../../src/modules/shipping/service.ts";
import { createTestPlatform, type TestPlatform } from "../helpers/platform.ts";

const TOKEN = "shippo_test_abc123";
const ADDRESS = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };

const RATES = [
  { object_id: "rate_prio", amount: "7.58", currency: "USD", provider: "USPS", servicelevel: { name: "Priority Mail", token: "usps_priority" }, estimated_days: 2 },
  { object_id: "rate_ground_adv", amount: "5.20", currency: "USD", provider: "USPS", servicelevel: { name: "Ground Advantage", token: "usps_ground_advantage" }, estimated_days: 5 },
  { object_id: "rate_ups_1", amount: "9.99", currency: "USD", provider: "UPS", servicelevel: { name: "UPS Ground", token: "ups_ground" }, estimated_days: 3 },
];

type Call = { method: string; url: string; body: any };

/** Shippo's API as far as the plugin uses it at checkout and fulfilment. */
const fakeShippo = () => {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (new Headers(init?.headers).get("authorization") !== `ShippoToken ${TOKEN}`) return json(401, { detail: "Invalid token." });
    if (method === "POST" && url === "https://api.goshippo.com/shipments/") return json(201, { object_id: `shp_${calls.length}`, status: "SUCCESS", rates: RATES, messages: [] });
    if (method === "POST" && url === "https://api.goshippo.com/transactions/") {
      return json(201, { object_id: `tx_${body.rate}`, status: "SUCCESS", tracking_number: "9400111899223197428490", label_url: `https://deliver.goshippo.com/${body.rate}.pdf`, test: true });
    }
    return json(404, { detail: "Not found." });
  };
  return { fetch, calls };
};

describe("Shippo through the platform", () => {
  let t: TestPlatform;
  const api = fakeShippo();
  const guest = { customerId: null };

  beforeAll(async () => {
    t = await createTestPlatform({ plugins: [shippo()], fetch: api.fetch });
    const zone = (await listShippingZones(t.platform.db)).find((z) => z.countries.includes("US"))!;
    await createShippingMethod(t.platform.db, { code: "us_shippo", name: { "en-US": "Carrier rates" }, zoneId: zone.id, config: { kind: "shippo", options: { carriers: "USPS" } }, position: 5 }, t.platform.shipping);
  });
  afterAll(() => t.close());

  const cart = async () => {
    const db = t.platform.db;
    const created = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { email: "ana@example.test", lines: [{ sku: "TOTE-BLACK", quantity: 2 }] });
    await setCartShippingAddress(db, created.id, { address: ADDRESS }, guest);
    await setCartBillingAddress(db, created.id, { sameAsShipping: true }, guest);
    return created;
  };

  it("offers no rates until the plugin is set up", async () => {
    const quote = await buildQuote(t.platform.db, (await cart()).id, quoteProviders(t.platform));
    expect(quote.shippingRates.map((r) => r.code)).toEqual(["us_standard", "us_express"]);
    expect(api.calls).toEqual([]);
  });

  it("quotes at checkout, places the order from the cache and buys the label at fulfilment", async () => {
    await t.platform.plugins.update("shippo", { settings: { apiToken: TOKEN } });
    const db = t.platform.db;
    const providers = quoteProviders(t.platform);
    const { id } = await cart();
    const quote = await buildQuote(db, id, providers);
    expect(quote.shippingRates.filter((r) => r.carrier === "USPS").map((r) => [r.code, r.amount])).toEqual([
      ["us_shippo:usps:usps_ground_advantage", 520],
      ["us_shippo:usps:usps_priority", 758],
    ]);
    // The seeded location has no street: fine for rates; labels need the settings' ship-from address.
    expect(api.calls.at(-1)!.body.address_from).toEqual({ city: "Newark", state: "NJ", zip: "07102", country: "US" });

    await setCartShippingMethod(db, id, "us_shippo:usps:usps_priority", guest, providers);
    await setCartPaymentMethod(db, id, "card", guest, providers);
    const quotes = api.calls.length;
    const placed = await placeOrder(t.platform, { cartId: id, idempotencyKey: "shippo-0001" }, guest);
    expect(api.calls.length).toBe(quotes);
    expect(placed.shippingMethod).toMatchObject({ code: "us_shippo:usps:usps_priority", carrier: "USPS", amount: 758, details: { provider: "shippo", data: { servicelevel: "usps_priority" } } });

    await shipOrder(t.platform, placed.id, { createShipment: true }, { type: "staff", id: null });
    expect(api.calls.at(-1)!.body).toEqual({ rate: "rate_prio", label_file_type: "PDF_4x6", async: false });
    const [fulfillment] = (await getFulfillmentsByOrderIds(db, [placed.id])).get(placed.id)!;
    expect(fulfillment).toMatchObject({
      tracking: [{ carrier: "USPS", number: "9400111899223197428490" }],
      shipment: { provider: "shippo", labelUrl: "https://deliver.goshippo.com/rate_prio.pdf", cost: { amount: 758, currency: "USD" } },
    });
  });
});
