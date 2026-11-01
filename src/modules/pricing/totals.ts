import { percentOf } from "../../lib/money.ts";
import { applyPromotions, shippingDiscountPercent, type EngineCart, type EngineLine, type EngineRule, type PromotionResult } from "../promotions/engine.ts";
import { resolveTaxRate, splitTax, taxInGross, taxOnNet, type ResolvedTaxRate, type TaxDestination, type TaxRateRow, type TaxRuleRow } from "../tax/engine.ts";

export type TotalsLineInput = EngineLine & { taxClassId: string | null; isShippable: boolean; weightGrams: number };

export type TotalsInput = {
  currency: string;
  pricesIncludeTax: boolean;
  lines: readonly TotalsLineInput[];
  customerGroupId: string | null;
  customerTaxClassId: string | null;
  /** The shipping address, or the billing address when nothing ships. */
  destination: TaxDestination | null;
  rules: readonly EngineRule[];
  shipping: { code: string; name: string; carrier: string; amount: number; taxClassId: string | null } | null;
  shippingTaxClassId: string | null;
  tax: { rates: TaxRateRow[]; rules: TaxRuleRow[] };
};

export type TotalsLine = { id: string; subtotal: number; discount: number; tax: number; taxRate: number; total: number };

export type Totals = {
  currency: string;
  lines: TotalsLine[];
  subtotal: number;
  discountTotal: number;
  /** Shipping before discount. */
  shippingAmount: number;
  shippingDiscount: number;
  /** Shipping after discount. */
  shippingTotal: number;
  shippingTax: number;
  taxTotal: number;
  grandTotal: number;
  taxLines: { name: string; rate: number; amount: number }[];
  discounts: { promotionId: string; name: string; couponCode: string | null; amount: number }[];
  promotions: PromotionResult;
};

/** Pure: subtotal → discount → shipping → shipping discount → tax → grand total. */
export const calculateTotals = (input: TotalsInput): Totals => {
  const inclusive = input.pricesIncludeTax;

  // 1. Subtotal
  const subtotal = input.lines.reduce((sum, l) => sum + l.subtotal, 0);

  // 2. Line discounts
  const cart: EngineCart = {
    currency: input.currency,
    lines: input.lines,
    customerGroupId: input.customerGroupId,
    shippingCountry: input.destination?.countryCode ?? null,
  };
  const promotions = applyPromotions(cart, input.rules);

  // 3–4. Shipping and shipping discount
  const shippingAmount = input.shipping?.amount ?? 0;
  const shippingPercent = input.shipping ? shippingDiscountPercent(promotions.shippingDiscounts, input.shipping.code) : 0;
  const shippingDiscount = Math.min(shippingAmount, percentOf(shippingAmount, shippingPercent));
  const shippingTotal = shippingAmount - shippingDiscount;

  // 5. Tax
  const taxLines = new Map<string, { name: string; rate: number; amount: number }>();
  const addTaxLines = (amount: number, resolved: ResolvedTaxRate) => {
    for (const part of splitTax(amount, resolved)) {
      const existing = taxLines.get(part.name);
      if (existing) existing.amount += part.amount;
      else taxLines.set(part.name, { ...part });
    }
  };
  const rateFor = (productTaxClassId: string | null) =>
    resolveTaxRate(input.tax.rules, input.tax.rates, { productTaxClassId, customerTaxClassId: input.customerTaxClassId, destination: input.destination });

  const lines: TotalsLine[] = input.lines.map((line) => {
    const discount = promotions.lineDiscounts.get(line.id) ?? 0;
    const taxable = line.subtotal - discount;
    const resolved = rateFor(line.taxClassId);
    const tax = inclusive ? taxInGross(taxable, resolved.rate) : taxOnNet(taxable, resolved.rate);
    addTaxLines(tax, resolved);
    return { id: line.id, subtotal: line.subtotal, discount, tax, taxRate: resolved.rate, total: inclusive ? taxable : taxable + tax };
  });

  const shippingRate = input.shipping ? rateFor(input.shipping.taxClassId ?? input.shippingTaxClassId) : { rate: 0, components: [] };
  const shippingTax = inclusive ? taxInGross(shippingTotal, shippingRate.rate) : taxOnNet(shippingTotal, shippingRate.rate);
  addTaxLines(shippingTax, shippingRate);

  // 6. Grand total
  const discountTotal = lines.reduce((sum, l) => sum + l.discount, 0);
  const taxTotal = lines.reduce((sum, l) => sum + l.tax, 0) + shippingTax;
  const grandTotal = subtotal - discountTotal + shippingTotal + (inclusive ? 0 : taxTotal);

  const discounts = promotions.applied.map(({ promotionId, name, couponCode, amount }) => ({ promotionId, name, couponCode, amount }));
  if (shippingDiscount > 0 && input.shipping) {
    const winner = promotions.shippingDiscounts
      .filter((d) => !d.methodCodes || d.methodCodes.includes(input.shipping!.code))
      .sort((a, b) => b.percent - a.percent)[0]!;
    discounts.push({ promotionId: winner.promotionId, name: winner.name, couponCode: winner.couponCode, amount: shippingDiscount });
  }

  return {
    currency: input.currency,
    lines,
    subtotal,
    discountTotal,
    shippingAmount,
    shippingDiscount,
    shippingTotal,
    shippingTax,
    taxTotal,
    grandTotal,
    taxLines: [...taxLines.values()].filter((t) => t.amount !== 0),
    discounts,
    promotions,
  };
};
