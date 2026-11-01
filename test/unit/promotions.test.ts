import { describe, expect, it } from "vitest";
import { applyPromotions, evaluateCondition, matchesLine, shippingDiscountPercent, type EngineCart, type EngineLine, type EngineRule } from "../../src/modules/promotions/engine.ts";
import { calculateTotals, type TotalsLineInput } from "../../src/modules/pricing/totals.ts";

const line = (id: string, unitPrice: number, quantity: number, extra: Partial<EngineLine> = {}): EngineLine => ({
  id,
  variantId: `v-${id}`,
  productId: `p-${id}`,
  sku: id.toUpperCase(),
  quantity,
  unitPrice,
  subtotal: unitPrice * quantity,
  categoryIds: [],
  attributes: {},
  ...extra,
});

const cart = (lines: EngineLine[], extra: Partial<EngineCart> = {}): EngineCart => ({ currency: "USD", lines, customerGroupId: null, shippingCountry: "US", ...extra });

const rule = (id: string, action: EngineRule["action"], extra: Partial<EngineRule> = {}): EngineRule => ({
  id,
  name: id,
  priority: 0,
  stopFurtherRules: false,
  conditions: { type: "all", conditions: [] },
  action,
  couponCode: null,
  ...extra,
});

describe("promotion conditions", () => {
  const c = cart([line("shirt", 5000, 2, { categoryIds: ["men", "shirts"], attributes: { color: "blue", tags: ["sale", "new"] } }), line("sock", 1000, 1)]);

  it("evaluates subtotal, quantity, line and boolean conditions", () => {
    expect(evaluateCondition({ type: "subtotal", operator: "gte", amounts: { USD: 11000 } }, c)).toBe(true);
    expect(evaluateCondition({ type: "subtotal", operator: "gt", amounts: { USD: 11000 } }, c)).toBe(false);
    expect(evaluateCondition({ type: "subtotal", operator: "gte", amounts: { EUR: 1 } }, c)).toBe(false);
    expect(evaluateCondition({ type: "total_quantity", operator: "eq", value: 3 }, c)).toBe(true);
    expect(evaluateCondition({ type: "line_matches", predicate: { type: "category_in", categoryIds: ["shirts"] }, minQuantity: 2 }, c)).toBe(true);
    expect(evaluateCondition({ type: "line_matches", predicate: { type: "category_in", categoryIds: ["shirts"] }, minQuantity: 3 }, c)).toBe(false);
    expect(evaluateCondition({ type: "not", condition: { type: "shipping_country_in", countries: ["CA"] } }, c)).toBe(true);
    expect(evaluateCondition({ type: "any", conditions: [] }, c)).toBe(false);
    expect(evaluateCondition({ type: "all", conditions: [] }, c)).toBe(true);
  });

  it("matches lines by attributes, including multiselect values", () => {
    expect(matchesLine({ type: "attribute_in", attribute: "color", values: ["blue", "red"] }, c.lines[0]!)).toBe(true);
    expect(matchesLine({ type: "attribute_in", attribute: "tags", values: ["sale"] }, c.lines[0]!)).toBe(true);
    expect(matchesLine({ type: "all", predicates: [{ type: "sku_in", skus: ["SHIRT"] }, { type: "attribute_in", attribute: "color", values: ["red"] }] }, c.lines[0]!)).toBe(false);
  });
});

describe("promotion actions", () => {
  it("applies rules by priority on what earlier rules left, and stops when asked", () => {
    const c = cart([line("a", 10000, 1)]);
    const result = applyPromotions(c, [
      rule("ten", { type: "percentage_off", percent: 10 }, { priority: 2 }),
      rule("twenty", { type: "percentage_off", percent: 20 }, { priority: 1 }),
    ]);
    // 20% of 100.00 = 20.00, then 10% of the remaining 80.00 = 8.00.
    expect(result.applied.map((a) => [a.promotionId, a.amount])).toEqual([["twenty", 2000], ["ten", 800]]);
    const stopped = applyPromotions(c, [rule("twenty", { type: "percentage_off", percent: 20 }, { priority: 1, stopFurtherRules: true }), rule("ten", { type: "percentage_off", percent: 10 }, { priority: 2 })]);
    expect(stopped.applied.map((a) => a.promotionId)).toEqual(["twenty"]);
  });

  it("caps percentage discounts and never discounts below zero", () => {
    const c = cart([line("a", 10000, 1), line("b", 5000, 1)]);
    const capped = applyPromotions(c, [rule("half", { type: "percentage_off", percent: 50, maxDiscountAmounts: { USD: 3000 } })]);
    expect(capped.applied[0]!.amount).toBe(3000);
    expect(capped.lineDiscounts.get("a")! + capped.lineDiscounts.get("b")!).toBe(3000);
    const huge = applyPromotions(c, [rule("fixed", { type: "fixed_off_each", amounts: { USD: 999999 } })]);
    expect(huge.lineDiscounts.get("a")).toBe(10000);
    expect(huge.lineDiscounts.get("b")).toBe(5000);
  });

  it("allocates a fixed cart discount across lines in proportion", () => {
    const c = cart([line("a", 3000, 1), line("b", 1000, 1)]);
    const result = applyPromotions(c, [rule("cart", { type: "fixed_off_cart", amounts: { USD: 1000 } })]);
    expect(result.lineDiscounts.get("a")).toBe(750);
    expect(result.lineDiscounts.get("b")).toBe(250);
  });

  it("discounts the free units of buy X get Y per line", () => {
    const rules = [rule("b2g1", { type: "buy_x_get_y", buyQuantity: 2, getQuantity: 1, percent: 100 })];
    const discount = (qty: number) => applyPromotions(cart([line("sock", 1000, qty)]), rules).lineDiscounts.get("sock");
    expect([1, 2, 3, 4, 5, 6, 7].map(discount)).toEqual([0, 0, 1000, 1000, 1000, 2000, 2000]);
  });

  it("only targets matching lines", () => {
    const c = cart([line("shirt", 5000, 1, { categoryIds: ["shirts"] }), line("sock", 1000, 1)]);
    const result = applyPromotions(c, [rule("shirts", { type: "percentage_off", percent: 20, target: { type: "category_in", categoryIds: ["shirts"] } })]);
    expect(result.lineDiscounts.get("shirt")).toBe(1000);
    expect(result.lineDiscounts.get("sock")).toBe(0);
  });

  it("reports the best shipping discount for a method", () => {
    const result = applyPromotions(cart([line("a", 1000, 1)]), [
      rule("half-ship", { type: "shipping_off", percent: 50 }),
      rule("free-express", { type: "shipping_off", percent: 100, methodCodes: ["express"] }),
    ]);
    expect(shippingDiscountPercent(result.shippingDiscounts, "standard")).toBe(50);
    expect(shippingDiscountPercent(result.shippingDiscounts, "express")).toBe(100);
  });
});

describe("totals pipeline", () => {
  const totalsLine = (id: string, unitPrice: number, quantity: number): TotalsLineInput => ({ ...line(id, unitPrice, quantity), taxClassId: "std", isShippable: true, weightGrams: 100 });
  const tax = {
    rates: [{ id: "de", name: "MwSt.", countryCode: "DE", regionCode: null, postalCodePattern: null, rate: 19 }],
    rules: [{ priority: 0, productTaxClassIds: ["std"], customerTaxClassIds: [], taxRateIds: ["de"] }],
  };
  const base = {
    currency: "EUR",
    customerGroupId: null,
    customerTaxClassId: null,
    destination: { countryCode: "DE" },
    shipping: { code: "std", name: "Standard", carrier: "flat_rate", amount: 500, taxClassId: null },
    shippingTaxClassId: "std",
    tax,
  };

  it("adds tax on top when prices exclude it", () => {
    const totals = calculateTotals({ ...base, pricesIncludeTax: false, lines: [totalsLine("a", 10000, 1)], rules: [rule("ten", { type: "percentage_off", percent: 10 })] });
    expect(totals).toMatchObject({ subtotal: 10000, discountTotal: 1000, shippingTotal: 500, taxTotal: 1710 + 95, grandTotal: 10000 - 1000 + 500 + 1805 });
  });

  it("extracts tax when prices include it, so the grand total is what was shown", () => {
    const totals = calculateTotals({ ...base, pricesIncludeTax: true, lines: [totalsLine("a", 11900, 1)], rules: [] });
    expect(totals.taxTotal).toBe(1900 + 80);
    expect(totals.grandTotal).toBe(11900 + 500);
    expect(totals.taxLines).toEqual([{ name: "MwSt.", rate: 19, amount: 1980 }]);
  });

  it("applies shipping discounts after shipping is priced and reports them", () => {
    const totals = calculateTotals({ ...base, pricesIncludeTax: true, lines: [totalsLine("a", 1000, 1)], rules: [rule("freeship", { type: "shipping_off", percent: 100 }, { couponCode: "FREESHIP" })] });
    expect(totals.shippingDiscount).toBe(500);
    expect(totals.shippingTotal).toBe(0);
    expect(totals.discounts).toEqual([{ promotionId: "freeship", name: "freeship", couponCode: "FREESHIP", amount: 500 }]);
  });
});
