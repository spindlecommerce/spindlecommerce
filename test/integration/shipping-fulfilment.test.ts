import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InvalidStateError } from "../../src/lib/errors.ts";
import { quoteProviders } from "../../src/modules/carts/quote.ts";
import { createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { placeOrder } from "../../src/modules/checkout/service.ts";
import { getVariantsBySkus } from "../../src/modules/catalog/read.ts";
import { getSalableQuantities } from "../../src/modules/inventory/stock.ts";
import { getEventsByOrderIds, getFulfillmentsByOrderIds, getLinesByOrderIds, getOrder } from "../../src/modules/orders/read.ts";
import { fulfillOrder, shipOrder } from "../../src/modules/orders/service.ts";
import { createTestPlatform, type TestPlatform } from "../helpers/platform.ts";
import { addLiveMethod, createFakeCarrier } from "../helpers/shipping.ts";

const ADDRESS = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };
const guest = { customerId: null };
const staff = { type: "staff" as const, id: null };

let t: TestPlatform;
let carrier: ReturnType<typeof createFakeCarrier>;
beforeAll(async () => {
  t = await createTestPlatform();
  carrier = createFakeCarrier();
  await addLiveMethod(t.platform, [carrier.provider]);
});
afterAll(() => t.close());
beforeEach(() => {
  carrier.state.active = true;
  carrier.state.shipmentError = null;
  carrier.state.duringShipment = null;
});

let orders = 0;
const order = async (shipping: string, lines = [{ sku: "TOTE-BLACK", quantity: 2 }]) => {
  const db = t.platform.db;
  const providers = quoteProviders(t.platform);
  const cart = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { email: "ana@example.test", lines });
  await setCartShippingAddress(db, cart.id, { address: ADDRESS }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  await setCartShippingMethod(db, cart.id, shipping, guest, providers);
  await setCartPaymentMethod(db, cart.id, "card", guest, providers);
  return placeOrder(t.platform, { cartId: cart.id, idempotencyKey: `fulfil-${++orders}` }, guest);
};

const fulfillmentsOf = async (orderId: string) => (await getFulfillmentsByOrderIds(t.platform.db, [orderId])).get(orderId) ?? [];
const timelineOf = async (orderId: string) => (await getEventsByOrderIds(t.platform.db, [orderId])).get(orderId) ?? [];

describe("labels at fulfilment", () => {
  it("books the shipment with the order's provider, then stores its tracking and label", async () => {
    const placed = await order("us_live:ground");
    const shipped = await shipOrder(t.platform, placed.id, { createShipment: true }, staff);
    expect(shipped.fulfillmentStatus).toBe("fulfilled");

    const request = carrier.state.shipmentCalls.at(-1)!;
    expect(request).toMatchObject({
      order: { id: placed.id, number: placed.number, email: "ana@example.test", currency: "USD", shippingAddress: ADDRESS, lines: [{ sku: "TOTE-BLACK", quantity: 2, weightGrams: 400 }] },
      lines: [{ sku: "TOTE-BLACK", quantity: 2, weightGrams: 400 }],
      origin: { city: "Newark", countryCode: "US" },
      method: { code: "us_live", options: { account: "ACME-1", markupPercent: 0, service: "all" } },
      rate: { provider: "fakeship", method: "us_live", rate: "ground", data: { rateId: expect.any(String) } },
    });
    const [fulfillment] = await fulfillmentsOf(placed.id);
    const number = `FS${String(carrier.state.shipmentCalls.length).padStart(4, "0")}`;
    expect(fulfillment).toMatchObject({
      tracking: [{ carrier: "FakeShip", number, url: `https://fakeship.test/track/${number}` }],
      shipment: { provider: "fakeship", labelUrl: expect.stringMatching(/^https:\/\/labels\.fakeship\.test\//), cost: { amount: 640, currency: "USD" }, data: { transactionId: expect.any(String) } },
    });
    expect((await timelineOf(placed.id)).find((e) => e.type === "fulfilled")?.data).toMatchObject({ shipment: { provider: "fakeship" } });
  });

  it("writes nothing when the provider fails", async () => {
    const placed = await order("us_live:express");
    const tote = (await getVariantsBySkus(t.platform.db, ["TOTE-BLACK"]))[0]!.id;
    const stockId = t.seed.stocks.usStock.id;
    const salable = (await getSalableQuantities(t.platform.db, stockId, [tote])).get(tote);
    carrier.state.shipmentError = new Error("address not deliverable");
    await expect(shipOrder(t.platform, placed.id, { createShipment: true }, staff)).rejects.toMatchObject({
      constructor: InvalidStateError,
      message: "FakeShip could not book the shipment: address not deliverable",
    });
    expect(await fulfillmentsOf(placed.id)).toEqual([]);
    expect((await getOrder(t.platform.db, placed.id)).fulfillmentStatus).toBe("unfulfilled");
    expect(((await getLinesByOrderIds(t.platform.db, [placed.id])).get(placed.id) ?? []).map((l) => l.quantityFulfilled)).toEqual([0]);
    expect((await getSalableQuantities(t.platform.db, stockId, [tote])).get(tote)).toBe(salable);
  });

  it("keeps what is valid of an odd answer, since the label is paid for", async () => {
    const placed = await order("us_live:ground");
    const original = carrier.provider.createShipment;
    carrier.provider.createShipment = async () => ({ tracking: [{ carrier: "FakeShip", number: "OK1" }, { carrier: "", number: 5 }], labelUrl: "https://labels.fakeship.test/odd.pdf", cost: { amount: 6.4, currency: "USD" } }) as never;
    try {
      await shipOrder(t.platform, placed.id, { createShipment: true }, staff);
    } finally {
      carrier.provider.createShipment = original;
    }
    expect((await fulfillmentsOf(placed.id))[0]).toMatchObject({
      tracking: [{ carrier: "FakeShip", number: "OK1", url: "https://fakeship.test/track/OK1" }],
      shipment: { provider: "fakeship", labelUrl: "https://labels.fakeship.test/odd.pdf", cost: null, data: {} },
    });
  });

  it("notes a bought label that could not be recorded", async () => {
    const placed = await order("us_live:ground");
    // Someone ships everything while the label is being bought.
    carrier.state.duringShipment = async () => {
      await fulfillOrder(t.platform.db, placed.id, {}, staff);
    };
    await expect(shipOrder(t.platform, placed.id, { createShipment: true }, staff)).rejects.toThrow("Invalid fulfillment");
    const note = (await timelineOf(placed.id)).find((e) => e.type === "note");
    expect(note?.message).toMatch(
      /^A FakeShip label was bought \(FakeShip FS\d+, https:\/\/labels\.fakeship\.test\/\d+\.pdf\) but the shipment could not be recorded: Invalid fulfillment \(Only 0 left to fulfill\)\. Void the label with FakeShip/,
    );
    expect(await fulfillmentsOf(placed.id)).toHaveLength(1);
  });

  it("books with a chosen provider, checks it first, and fills tracking links", async () => {
    const placed = await order("us_standard", [{ sku: "SOCK-BLUE", quantity: 4 }]);
    const [line] = (await getLinesByOrderIds(t.platform.db, [placed.id])).get(placed.id)!;
    // Built-in rates name their provider too, and built-in providers buy no labels.
    await expect(shipOrder(t.platform, placed.id, { createShipment: true }, staff)).rejects.toThrow("Flat rate cannot book shipments: choose a provider that can");
    await expect(shipOrder(t.platform, placed.id, { createShipment: true, shipmentProvider: "nope" }, staff)).rejects.toThrow("The shipping provider nope is not installed");
    carrier.state.active = false;
    await expect(shipOrder(t.platform, placed.id, { createShipment: true, shipmentProvider: "fakeship" }, staff)).rejects.toThrow("FakeShip is not set up");
    carrier.state.active = true;
    await expect(shipOrder(t.platform, placed.id, { createShipment: true, shipmentProvider: "fakeship", lines: [{ orderLineId: line!.id, quantity: 9 }] }, staff)).rejects.toThrow("Invalid fulfillment");
    const calls = carrier.state.shipmentCalls.length;

    await shipOrder(t.platform, placed.id, { createShipment: true, shipmentProvider: "fakeship", lines: [{ orderLineId: line!.id, quantity: 1 }] }, staff);
    expect(carrier.state.shipmentCalls).toHaveLength(calls + 1);
    expect(carrier.state.shipmentCalls.at(-1)).toMatchObject({ method: null, rate: null, lines: [{ orderLineId: line!.id, quantity: 1 }] });

    // Without a label: tracking typed in by staff gets the carrier's link from a provider that knows it.
    const shipped = await shipOrder(t.platform, placed.id, { tracking: [{ carrier: "FakeShip", number: "MANUAL1" }, { carrier: "Pigeon", number: "P1" }] }, staff);
    expect(shipped.fulfillmentStatus).toBe("fulfilled");
    expect((await fulfillmentsOf(placed.id)).at(-1)).toMatchObject({
      shipment: null,
      tracking: [
        { carrier: "FakeShip", number: "MANUAL1", url: "https://fakeship.test/track/MANUAL1" },
        { carrier: "Pigeon", number: "P1", url: null },
      ],
    });
  });
});
