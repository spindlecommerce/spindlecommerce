import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCartLines, applyCartCoupon, assignCartToCustomer, createCart, setCartBillingAddress, setCartEmail, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { buildQuote } from "../../src/modules/carts/quote.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { placeOrder } from "../../src/modules/checkout/service.ts";
import { getVariantsBySkus } from "../../src/modules/catalog/read.ts";
import { getSalableQuantities } from "../../src/modules/inventory/stock.ts";
import { getLinesByOrderIds } from "../../src/modules/orders/read.ts";
import { cancelOrder, capturePayment, fulfillOrder, refundOrder } from "../../src/modules/orders/service.ts";
import { CartNotReadyError, CouponNotApplicableError, InsufficientStockError, PaymentDeclinedError, ValidationError } from "../../src/lib/errors.ts";
import { createTestPlatform, type TestPlatform } from "../helpers/platform.ts";

const CA_ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const BERLIN = { firstName: "Mia", lastName: "Schmidt", line1: "Unter den Linden 1", city: "Berlin", postalCode: "10117", countryCode: "DE" };
const guest = { customerId: null };
const staff = { type: "staff" as const, id: null };

let t: TestPlatform;
beforeAll(async () => {
  t = await createTestPlatform();
});
afterAll(() => t.close());

const usScope = () => resolveScope(t.platform.db, { channel: "us" });
const variantId = async (sku: string) => (await getVariantsBySkus(t.platform.db, [sku]))[0]!.id;

const readyCart = async (lines: { sku: string; quantity: number }[], opts: { payment?: string; shipping?: string } = {}) => {
  const db = t.platform.db;
  const cart = await createCart(db, await usScope(), guest, { email: "sam@example.test", lines });
  await setCartShippingAddress(db, cart.id, { address: CA_ADDRESS }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  await setCartShippingMethod(db, cart.id, opts.shipping ?? "us_standard", guest);
  await setCartPaymentMethod(db, cart.id, opts.payment ?? "card", guest);
  return cart;
};

describe("order lifecycle", () => {
  it("prices a US cart: tier price, California tax on goods, untaxed shipping", async () => {
    const cart = await readyCart([{ sku: "TEE-BLACK-M", quantity: 5 }]);
    const quote = await buildQuote(t.platform.db, cart.id);
    expect(quote.missing).toEqual([]);
    // Tier price 22.00 applies at 5 units; list price 25.00 is the compare-at.
    expect(quote.lines[0]!.unitPrice).toBe(2200);
    expect(quote.lines[0]!.compareAtUnitPrice).toBe(2500);
    expect(quote.totals.subtotal).toBe(11000);
    expect(quote.totals.shippingTotal).toBe(599);
    // 7.25% of 110.00 = 7.975 → 7.98; shipping has no tax class in the US channel.
    expect(quote.totals.taxTotal).toBe(798);
    expect(quote.totals.grandTotal).toBe(11000 + 599 + 798);
    expect(quote.totals.taxLines).toEqual([{ name: "California sales tax", rate: 7.25, amount: 798 }]);
  });

  it("refuses checkout until the cart is complete", async () => {
    const db = t.platform.db;
    const cart = await createCart(db, await usScope(), guest, { lines: [{ sku: "TOTE-BLACK", quantity: 1 }] });
    await expect(placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "k1" }, guest)).rejects.toMatchObject({
      constructor: CartNotReadyError,
      // The billing address follows the shipping address, so only the shipping address is asked for.
      missing: ["email", "shipping_address", "shipping_method", "payment_method"],
      fieldErrors: [
        { path: ["email"], message: "Required" },
        { path: ["shippingAddress"], message: "Required" },
        { path: ["paymentMethodCode"], message: "Required" },
      ],
    });
  });

  it("places, captures, fulfills and partially refunds an order while keeping stock consistent", async () => {
    const db = t.platform.db;
    const usStock = t.seed.stocks.usStock.id;
    const tote = await variantId("TOTE-BLACK");
    const before = (await getSalableQuantities(db, usStock, [tote])).get(tote)!;

    const cart = await readyCart([{ sku: "TOTE-BLACK", quantity: 2 }]);
    const order = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "lifecycle-1" }, guest);
    expect(order.number).toMatch(/^US-\d{6}$/);
    expect(order.paymentStatus).toBe("authorized");
    expect((await getSalableQuantities(db, usStock, [tote])).get(tote)).toBe(before - 2);

    // Same key → same order, no second reservation.
    const replay = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "lifecycle-1" }, guest);
    expect(replay.id).toBe(order.id);
    expect((await getSalableQuantities(db, usStock, [tote])).get(tote)).toBe(before - 2);

    const captured = await capturePayment(t.platform, order.id, {}, staff);
    expect(captured.paymentStatus).toBe("paid");
    expect(captured.amountCaptured).toBe(order.grandTotal);

    const shipped = await fulfillOrder(db, order.id, { tracking: [{ carrier: "UPS", number: "1Z999" }] }, staff);
    expect(shipped.fulfillmentStatus).toBe("fulfilled");
    expect(shipped.status).toBe("completed");
    // Shipping deducts on-hand stock and compensates the reservation: salable is unchanged.
    expect((await getSalableQuantities(db, usStock, [tote])).get(tote)).toBe(before - 2);

    const [line] = (await getLinesByOrderIds(db, [order.id])).get(order.id)!;
    const refunded = await refundOrder(t.platform, order.id, { lines: [{ orderLineId: line!.id, quantity: 1, restock: true }], reason: "damaged" }, staff);
    expect(refunded.paymentStatus).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(Math.round(line!.total / 2));
    // The restocked unit is salable again.
    expect((await getSalableQuantities(db, usStock, [tote])).get(tote)).toBe(before - 1);
    await expect(refundOrder(t.platform, order.id, { shippingAmount: "1000.00" }, staff)).rejects.toThrow(/shipping/i);
  });

  it("refuses a line listed twice when fulfilling or refunding", async () => {
    const db = t.platform.db;
    const cart = await readyCart([{ sku: "TOTE-BLACK", quantity: 2 }]);
    const order = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "repeated-lines" }, guest);
    await capturePayment(t.platform, order.id, {}, staff);
    const [line] = (await getLinesByOrderIds(db, [order.id])).get(order.id)!;
    const twice = [{ orderLineId: line!.id, quantity: 2 }, { orderLineId: line!.id, quantity: 2 }];
    const listedTwice = { constructor: ValidationError, fieldErrors: [{ path: ["input", "lines", "1", "orderLineId"], message: "Listed more than once" }] };
    await expect(fulfillOrder(db, order.id, { lines: twice }, staff)).rejects.toMatchObject(listedTwice);
    await expect(refundOrder(t.platform, order.id, { lines: twice }, staff)).rejects.toMatchObject(listedTwice);
    const [after] = (await getLinesByOrderIds(db, [order.id])).get(order.id)!;
    expect([after!.quantityFulfilled, after!.quantityRefunded]).toEqual([0, 0]);
  });

  it("releases stock and reopens the cart when the card is declined", async () => {
    const db = t.platform.db;
    const usStock = t.seed.stocks.usStock.id;
    const oxford = await variantId("OXF-BLUE-M");
    const before = (await getSalableQuantities(db, usStock, [oxford])).get(oxford)!;
    const cart = await readyCart([{ sku: "OXF-BLUE-M", quantity: 1 }]);
    await expect(placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "decline-1", paymentData: { token: "tok_declined" } }, guest)).rejects.toBeInstanceOf(PaymentDeclinedError);
    expect((await getSalableQuantities(db, usStock, [oxford])).get(oxford)).toBe(before);
    // The same cart can be retried with a working card and the same idempotency key.
    const order = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "decline-1", paymentData: { token: "tok_visa" } }, guest);
    expect(order.status).toBe("open");
    expect((await getSalableQuantities(db, usStock, [oxford])).get(oxford)).toBe(before - 1);
  });

  it("never oversells: reservations count against salable quantity", async () => {
    const db = t.platform.db;
    // TRL-GREEN-44 has 6 units in the US warehouse.
    const first = await readyCart([{ sku: "TRL-GREEN-44", quantity: 4 }], { shipping: "us_free" });
    const second = await readyCart([{ sku: "TRL-GREEN-44", quantity: 3 }], { shipping: "us_free" });
    await placeOrder(t.platform, { cartId: first.id, idempotencyKey: "a" }, guest);
    await expect(placeOrder(t.platform, { cartId: second.id, idempotencyKey: "b" }, guest)).rejects.toSatisfy(
      (e) => e instanceof CartNotReadyError || e instanceof InsufficientStockError,
    );
    await expect(addCartLines(db, (await createCart(db, await usScope(), guest)).id, [{ sku: "TRL-GREEN-44", quantity: 3 }])).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("cancels an authorized order and releases its reservation", async () => {
    const db = t.platform.db;
    const usStock = t.seed.stocks.usStock.id;
    const guideId = await variantId("BOOK-TRAIL-GUIDE");
    const before = (await getSalableQuantities(db, usStock, [guideId])).get(guideId)!;
    const order = await placeOrder(t.platform, { cartId: (await readyCart([{ sku: "BOOK-TRAIL-GUIDE", quantity: 2 }])).id, idempotencyKey: "cancel-1" }, guest);
    const canceled = await cancelOrder(t.platform, order.id, { reason: "customer request" }, staff);
    expect(canceled.status).toBe("canceled");
    expect(canceled.paymentStatus).toBe("voided");
    expect((await getSalableQuantities(db, usStock, [guideId])).get(guideId)).toBe(before);
  });

  it("applies coupons only when their conditions hold, and automatic rules by subtotal", async () => {
    const db = t.platform.db;
    const cart = await createCart(db, await usScope(), guest, { lines: [{ sku: "TOTE-GREEN", quantity: 1 }] });
    await expect(applyCartCoupon(db, cart.id, "summer20", guest)).rejects.toBeInstanceOf(CouponNotApplicableError);
    await expect(applyCartCoupon(db, cart.id, "NOPE", guest)).rejects.toMatchObject({ reason: "unknown coupon" });
    await addCartLines(db, cart.id, [{ sku: "OXF-WHITE-L", quantity: 3 }], guest);
    await applyCartCoupon(db, cart.id, "summer20", guest);
    const quote = await buildQuote(db, cart.id);
    // 3 × 59.00 = 177.00 shirts get 20% (35.40); then 10% over $150 applies to what remains on every line.
    const shirts = quote.lines.find((l) => l.variant.sku === "OXF-WHITE-L")!;
    const tote = quote.lines.find((l) => l.variant.sku === "TOTE-GREEN")!;
    expect(shirts.totals!.discount).toBe(3540 + 1416);
    expect(tote.totals!.discount).toBe(350);
    expect(quote.totals.discounts.map((d) => d.name)).toEqual(["Summer sale: 20% off shirts", "10% off orders over $150 / €150"]);
  });

  it("gives a free sock with every two, and free shipping by code", async () => {
    const db = t.platform.db;
    const cart = await readyCart([{ sku: "SOCK-BLUE", quantity: 3 }]);
    await applyCartCoupon(db, cart.id, "FREESHIP", guest);
    const quote = await buildQuote(db, cart.id);
    expect(quote.totals.discountTotal).toBe(1800);
    expect(quote.totals.shippingDiscount).toBe(599);
    expect(quote.totals.shippingTotal).toBe(0);
  });

  it("prices the EU channel tax-inclusive, with converted GBP prices and taxed shipping", async () => {
    const db = t.platform.db;
    const scope = await resolveScope(db, { channel: "eu", locale: "de-DE" });
    const cart = await createCart(db, scope, guest, { email: "mia@example.test", lines: [{ sku: "BOOK-TRAIL-GUIDE", quantity: 1 }, { sku: "TEE-RED-S", quantity: 1 }] });
    await setCartShippingAddress(db, cart.id, { address: BERLIN }, guest);
    await setCartShippingMethod(db, cart.id, "eu_standard", guest);
    const quote = await buildQuote(db, cart.id);
    // Gross prices stay as listed; tax is contained: 22.00 at 7% and 24.00 at 19%, shipping 4.90 at 19%.
    expect(quote.totals.subtotal).toBe(4600);
    expect(quote.totals.grandTotal).toBe(4600 + 490);
    const book = quote.lines.find((l) => l.variant.sku === "BOOK-TRAIL-GUIDE")!.totals!;
    expect(book.tax).toBe(2200 - Math.round(2200 / 1.07));
    expect(quote.totals.shippingTax).toBe(490 - Math.round(490 / 1.19));

    const gbp = await createCart(db, await resolveScope(db, { channel: "eu", currency: "GBP", locale: "en-GB" }), guest, { lines: [{ sku: "TEE-RED-S", quantity: 1 }, { sku: "TRL-BLACK-42", quantity: 1 }] });
    const gbpQuote = await buildQuote(db, gbp.id);
    // Tee has no GBP price → 24.00 EUR × 0.86; the trail runner has an explicit GBP price.
    expect(gbpQuote.lines.map((l) => l.unitPrice)).toEqual([2064, 12500]);
  });

  it("merges a guest cart into the customer's cart on sign-in", async () => {
    const db = t.platform.db;
    const scope = await usScope();
    const customerId = t.seed.customer.id;
    const existing = await createCart(db, scope, { customerId }, { lines: [{ sku: "SOCK-BLACK", quantity: 1 }] });
    const guestCart = await createCart(db, scope, guest, { lines: [{ sku: "SOCK-BLACK", quantity: 2 }, { sku: "TOTE-BLACK", quantity: 1 }] });
    await setCartEmail(db, guestCart.id, "someone@example.test", guest);
    const merged = await assignCartToCustomer(db, guestCart.id, customerId);
    expect(merged.id).toBe(existing.id);
    const quote = await buildQuote(db, merged.id);
    expect(Object.fromEntries(quote.lines.map((l) => [l.variant.sku, l.line.quantity]))).toEqual({ "SOCK-BLACK": 3, "TOTE-BLACK": 1 });
  });
});
