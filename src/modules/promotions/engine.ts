import { allocate, percentOf } from "../../lib/money.ts";
import type { AttributeValue } from "../catalog/tables.ts";
import type { Action, Comparison, Condition, LinePredicate } from "./rules.ts";

/** Pure promotion engine: no I/O, deterministic. */
export type EngineLine = {
  id: string;
  variantId: string;
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  /** unitPrice × quantity, before discounts. */
  subtotal: number;
  /** Assigned categories plus ancestors. */
  categoryIds: readonly string[];
  /** Product and variant attribute values merged. */
  attributes: Readonly<Record<string, AttributeValue>>;
};

export type EngineCart = {
  currency: string;
  lines: readonly EngineLine[];
  customerGroupId: string | null;
  shippingCountry: string | null;
};

export type EngineRule = {
  id: string;
  name: string;
  priority: number;
  stopFurtherRules: boolean;
  conditions: Condition;
  action: Action;
  /** The cart coupon that unlocked this rule, if it requires one. */
  couponCode: string | null;
};

export type AppliedPromotion = {
  promotionId: string;
  name: string;
  couponCode: string | null;
  amount: number;
  lineAmounts: Record<string, number>;
};

export type ShippingDiscount = { promotionId: string; name: string; couponCode: string | null; percent: number; methodCodes: string[] | null };

export type PromotionResult = {
  lineDiscounts: Map<string, number>;
  applied: AppliedPromotion[];
  shippingDiscounts: ShippingDiscount[];
};

const compare = (left: number, operator: Comparison, right: number) =>
  operator === "gte" ? left >= right : operator === "gt" ? left > right : operator === "lte" ? left <= right : operator === "lt" ? left < right : left === right;

const attributeStrings = (value: AttributeValue | undefined): string[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "object") return [];
  return [String(value)];
};

export const matchesLine = (predicate: LinePredicate, line: EngineLine): boolean => {
  switch (predicate.type) {
    case "all":
      return predicate.predicates.every((p) => matchesLine(p, line));
    case "any":
      return predicate.predicates.some((p) => matchesLine(p, line));
    case "sku_in":
      return predicate.skus.includes(line.sku);
    case "product_in":
      return predicate.productIds.includes(line.productId);
    case "category_in":
      return predicate.categoryIds.some((id) => line.categoryIds.includes(id));
    case "attribute_in":
      return attributeStrings(line.attributes[predicate.attribute]).some((v) => predicate.values.includes(v));
  }
};

export const evaluateCondition = (condition: Condition, cart: EngineCart): boolean => {
  switch (condition.type) {
    case "all":
      return condition.conditions.every((c) => evaluateCondition(c, cart));
    case "any":
      return condition.conditions.some((c) => evaluateCondition(c, cart));
    case "not":
      return !evaluateCondition(condition.condition, cart);
    case "subtotal": {
      const threshold = condition.amounts[cart.currency];
      return threshold !== undefined && compare(cart.lines.reduce((s, l) => s + l.subtotal, 0), condition.operator, threshold);
    }
    case "total_quantity":
      return compare(cart.lines.reduce((s, l) => s + l.quantity, 0), condition.operator, condition.value);
    case "line_matches":
      return cart.lines.filter((l) => matchesLine(condition.predicate, l)).reduce((s, l) => s + l.quantity, 0) >= (condition.minQuantity ?? 1);
    case "shipping_country_in":
      return cart.shippingCountry !== null && condition.countries.includes(cart.shippingCountry);
    case "customer_group_in":
      return cart.customerGroupId !== null && condition.groupIds.includes(cart.customerGroupId);
  }
};

/** Per-line discount, capped at what earlier rules left of each line. */
const actionLineDiscounts = (action: Exclude<Action, { type: "shipping_off" }>, cart: EngineCart, remaining: Map<string, number>): Map<string, number> => {
  const targets = cart.lines.filter((l) => (action.target ? matchesLine(action.target, l) : true) && (remaining.get(l.id) ?? 0) > 0);
  const result = new Map<string, number>();
  const capped = (line: EngineLine, amount: number) => Math.max(0, Math.min(amount, remaining.get(line.id) ?? 0));
  switch (action.type) {
    case "percentage_off": {
      for (const line of targets) result.set(line.id, capped(line, percentOf(remaining.get(line.id)!, action.percent)));
      const max = action.maxDiscountAmounts?.[cart.currency];
      const total = [...result.values()].reduce((a, b) => a + b, 0);
      if (max !== undefined && total > max) {
        const ids = [...result.keys()];
        allocate(max, ids.map((id) => result.get(id)!)).forEach((part, i) => result.set(ids[i]!, part));
      }
      return result;
    }
    case "fixed_off_each": {
      const perUnit = action.amounts[cart.currency] ?? 0;
      for (const line of targets) result.set(line.id, capped(line, perUnit * line.quantity));
      return result;
    }
    case "fixed_off_cart": {
      const pool = targets.reduce((s, l) => s + remaining.get(l.id)!, 0);
      const amount = Math.min(action.amounts[cart.currency] ?? 0, pool);
      allocate(amount, targets.map((l) => remaining.get(l.id)!)).forEach((part, i) => result.set(targets[i]!.id, part));
      return result;
    }
    case "buy_x_get_y": {
      // Per line: in each run of buy+get units, `get` units are discounted.
      const period = action.buyQuantity + action.getQuantity;
      for (const line of targets) {
        const full = Math.floor(line.quantity / period);
        const rest = line.quantity - full * period;
        const discountedUnits = full * action.getQuantity + Math.max(0, rest - action.buyQuantity);
        if (discountedUnits > 0) result.set(line.id, capped(line, percentOf(line.unitPrice * discountedUnits, action.percent)));
      }
      return result;
    }
  }
};

/** By ascending priority, then id. A matching rule with `stopFurtherRules` ends the run. */
export const applyPromotions = (cart: EngineCart, rules: readonly EngineRule[]): PromotionResult => {
  const remaining = new Map(cart.lines.map((l) => [l.id, l.subtotal]));
  const lineDiscounts = new Map(cart.lines.map((l) => [l.id, 0]));
  const applied: AppliedPromotion[] = [];
  const shippingDiscounts: ShippingDiscount[] = [];
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of ordered) {
    if (!evaluateCondition(rule.conditions, cart)) continue;
    if (rule.action.type === "shipping_off") {
      shippingDiscounts.push({ promotionId: rule.id, name: rule.name, couponCode: rule.couponCode, percent: rule.action.percent, methodCodes: rule.action.methodCodes ?? null });
    } else {
      const discounts = actionLineDiscounts(rule.action, cart, remaining);
      const amount = [...discounts.values()].reduce((a, b) => a + b, 0);
      if (amount > 0) {
        for (const [lineId, value] of discounts) {
          remaining.set(lineId, remaining.get(lineId)! - value);
          lineDiscounts.set(lineId, lineDiscounts.get(lineId)! + value);
        }
        applied.push({ promotionId: rule.id, name: rule.name, couponCode: rule.couponCode, amount, lineAmounts: Object.fromEntries([...discounts].filter(([, v]) => v > 0)) });
      } else if (rule.couponCode) {
        // Reported anyway, so the coupon shows as applied.
        applied.push({ promotionId: rule.id, name: rule.name, couponCode: rule.couponCode, amount: 0, lineAmounts: {} });
      }
    }
    if (rule.stopFurtherRules) break;
  }
  return { lineDiscounts, applied, shippingDiscounts };
};

/** Shipping discounts don't stack: the best one for the method wins. */
export const shippingDiscountPercent = (discounts: readonly ShippingDiscount[], methodCode: string) =>
  discounts.filter((d) => !d.methodCodes || d.methodCodes.includes(methodCode)).reduce((max, d) => Math.max(max, d.percent), 0);
