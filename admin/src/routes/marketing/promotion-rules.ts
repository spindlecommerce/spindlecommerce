import type { MoneyByCurrency } from "@/components/inputs";

/**
 * Promotion rules in the editor. The API stores them as JSON (snake_case types, minor-unit amounts
 * by currency, raw UUIDs) and takes them as @oneOf inputs (decimal strings, global ids).
 */

// ---------------------------------------------------------------- money

const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};
const exponent = (currency: string) => EXPONENTS[currency] ?? 2;

export const minorToDecimal = (minor: number, currency: string) => (minor / 10 ** exponent(currency)).toFixed(exponent(currency));

const fromAmounts = (amounts: Record<string, number> | undefined): MoneyByCurrency[] =>
  Object.entries(amounts ?? {}).map(([currencyCode, minor]) => ({ currencyCode, amount: minorToDecimal(minor, currencyCode) }));

const formatDecimal = (amount: string, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
};

const moneyList = (list: MoneyByCurrency[]) => list.filter((m) => m.amount.trim() !== "").map((m) => formatDecimal(m.amount, m.currencyCode)).join(" / ") || "—";

// ---------------------------------------------------------------- state

export type Operator = "GTE" | "GT" | "LTE" | "LT" | "EQ";
export const OPERATORS: { value: Operator; label: string; symbol: string }[] = [
  { value: "GTE", label: "at least", symbol: "≥" },
  { value: "GT", label: "more than", symbol: ">" },
  { value: "LTE", label: "at most", symbol: "≤" },
  { value: "LT", label: "less than", symbol: "<" },
  { value: "EQ", label: "exactly", symbol: "=" },
];

let counter = 0;
export const key = () => `n${++counter}`;

export type Predicate =
  | { key: string; kind: "all" | "any"; children: Predicate[] }
  | { key: string; kind: "sku"; skus: string[] }
  | { key: string; kind: "product"; productIds: string[] }
  | { key: string; kind: "category"; categoryIds: string[] }
  | { key: string; kind: "attribute"; code: string; values: string[] };

export type Condition =
  /** "none" is NOT(ANY(children)). */
  | { key: string; kind: "all" | "any" | "none"; children: Condition[] }
  | { key: string; kind: "subtotal"; operator: Operator; amounts: MoneyByCurrency[] }
  | { key: string; kind: "quantity"; operator: Operator; value: number }
  | { key: string; kind: "lines"; predicate: Predicate; minQuantity: number }
  | { key: string; kind: "country"; countries: string[] }
  | { key: string; kind: "group"; groupIds: string[] };

export type ActionKind = "percentageOff" | "fixedOffEach" | "fixedOffCart" | "buyXGetY" | "shippingOff";

export type ActionState = {
  kind: ActionKind;
  percent: string;
  amounts: MoneyByCurrency[];
  maxDiscount: MoneyByCurrency[];
  buyQuantity: number;
  getQuantity: number;
  methodCodes: string[];
  /** Lines the discount applies to; null means every line. */
  target: Predicate | null;
};

export const ACTIONS: { value: ActionKind; label: string; description: string }[] = [
  { value: "percentageOff", label: "Percentage off", description: "A percentage off matching lines." },
  { value: "fixedOffEach", label: "Fixed amount off each item", description: "A fixed amount off every matching unit." },
  { value: "fixedOffCart", label: "Fixed amount off the order", description: "One amount spread across matching lines." },
  { value: "buyXGetY", label: "Buy X, get Y", description: "For every X bought, Y more of the matching items are discounted, cheapest first." },
  { value: "shippingOff", label: "Shipping discount", description: "Free or cheaper shipping, optionally for some methods only." },
];

export const emptyAction = (): ActionState => ({ kind: "percentageOff", percent: "10", amounts: [], maxDiscount: [], buyQuantity: 2, getQuantity: 1, methodCodes: [], target: null });
export const emptyPredicate = (kind: Predicate["kind"]): Predicate => {
  switch (kind) {
    case "all":
    case "any":
      return { key: key(), kind, children: [] };
    case "sku":
      return { key: key(), kind, skus: [] };
    case "product":
      return { key: key(), kind, productIds: [] };
    case "category":
      return { key: key(), kind, categoryIds: [] };
    case "attribute":
      return { key: key(), kind, code: "", values: [] };
  }
};
export const emptyCondition = (kind: Condition["kind"], currencies: readonly string[] = []): Condition => {
  switch (kind) {
    case "all":
    case "any":
    case "none":
      return { key: key(), kind, children: [] };
    case "subtotal":
      return { key: key(), kind, operator: "GTE", amounts: currencies.slice(0, 1).map((currencyCode) => ({ currencyCode, amount: "" })) };
    case "quantity":
      return { key: key(), kind, operator: "GTE", value: 2 };
    case "lines":
      return { key: key(), kind, predicate: emptyPredicate("category"), minQuantity: 1 };
    case "country":
      return { key: key(), kind, countries: [] };
    case "group":
      return { key: key(), kind, groupIds: [] };
  }
};

// ---------------------------------------------------------------- stored JSON → state

const gid = (type: string, id: string) => (id.startsWith("gid://") ? id : `gid://ecom/${type}/${id}`);
type Stored = Record<string, unknown> & { type?: string };
const list = <T,>(value: unknown) => (Array.isArray(value) ? (value as T[]) : []);

export const predicateFromStored = (stored: Stored | null | undefined): Predicate | null => {
  if (!stored?.type) return null;
  switch (stored.type) {
    case "all":
    case "any":
      return { key: key(), kind: stored.type, children: list<Stored>(stored.predicates).flatMap((p) => predicateFromStored(p) ?? []) };
    case "sku_in":
      return { key: key(), kind: "sku", skus: list<string>(stored.skus) };
    case "product_in":
      return { key: key(), kind: "product", productIds: list<string>(stored.productIds).map((id) => gid("Product", id)) };
    case "category_in":
      return { key: key(), kind: "category", categoryIds: list<string>(stored.categoryIds).map((id) => gid("Category", id)) };
    case "attribute_in":
      return { key: key(), kind: "attribute", code: String(stored.attribute ?? ""), values: list<string>(stored.values) };
    default:
      return null;
  }
};

const operatorFromStored = (value: unknown): Operator => (typeof value === "string" && ["gte", "gt", "lte", "lt", "eq"].includes(value) ? (value.toUpperCase() as Operator) : "GTE");

export const conditionFromStored = (stored: Stored | null | undefined): Condition | null => {
  if (!stored?.type) return null;
  switch (stored.type) {
    case "all":
    case "any":
      return { key: key(), kind: stored.type, children: list<Stored>(stored.conditions).flatMap((c) => conditionFromStored(c) ?? []) };
    case "not": {
      const inner = stored.condition as Stored | undefined;
      const children = inner?.type === "any" ? list<Stored>(inner.conditions) : inner ? [inner] : [];
      return { key: key(), kind: "none", children: children.flatMap((c) => conditionFromStored(c) ?? []) };
    }
    case "subtotal":
      return { key: key(), kind: "subtotal", operator: operatorFromStored(stored.operator), amounts: fromAmounts(stored.amounts as Record<string, number>) };
    case "total_quantity":
      return { key: key(), kind: "quantity", operator: operatorFromStored(stored.operator), value: Number(stored.value ?? 0) };
    case "line_matches":
      return { key: key(), kind: "lines", predicate: predicateFromStored(stored.predicate as Stored) ?? emptyPredicate("category"), minQuantity: Number(stored.minQuantity ?? 1) };
    case "shipping_country_in":
      return { key: key(), kind: "country", countries: list<string>(stored.countries) };
    case "customer_group_in":
      return { key: key(), kind: "group", groupIds: list<string>(stored.groupIds).map((id) => gid("CustomerGroup", id)) };
    default:
      return null;
  }
};

/** The root is always a group, so the editor can add conditions to it. */
export const rootFromStored = (stored: unknown): Condition => {
  const condition = conditionFromStored(stored as Stored);
  if (!condition) return { key: key(), kind: "all", children: [] };
  if (condition.kind === "all" || condition.kind === "any") return condition;
  return { key: key(), kind: "all", children: [condition] };
};

export const actionFromStored = (stored: unknown): ActionState => {
  const a = (stored ?? {}) as Stored;
  const base = emptyAction();
  const target = predicateFromStored(a.target as Stored);
  switch (a.type) {
    case "percentage_off":
      return { ...base, kind: "percentageOff", percent: String(a.percent ?? ""), maxDiscount: fromAmounts(a.maxDiscountAmounts as Record<string, number>), target };
    case "fixed_off_each":
      return { ...base, kind: "fixedOffEach", amounts: fromAmounts(a.amounts as Record<string, number>), target };
    case "fixed_off_cart":
      return { ...base, kind: "fixedOffCart", amounts: fromAmounts(a.amounts as Record<string, number>), target };
    case "buy_x_get_y":
      return { ...base, kind: "buyXGetY", buyQuantity: Number(a.buyQuantity ?? 2), getQuantity: Number(a.getQuantity ?? 1), percent: String(a.percent ?? 100), target };
    case "shipping_off":
      return { ...base, kind: "shippingOff", percent: String(a.percent ?? 100), methodCodes: list<string>(a.methodCodes) };
    default:
      return base;
  }
};

// ---------------------------------------------------------------- state → API input

export type PredicateInput =
  | { all: PredicateInput[] }
  | { any: PredicateInput[] }
  | { skuIn: string[] }
  | { productIn: string[] }
  | { categoryIn: string[] }
  | { attributeIn: { code: string; values: string[] } };

export type ConditionInput =
  | { all: ConditionInput[] }
  | { any: ConditionInput[] }
  | { not: ConditionInput }
  | { subtotal: { operator: Operator; amounts: MoneyByCurrency[] } }
  | { totalQuantity: { operator: Operator; value: number } }
  | { lineMatches: { predicate: PredicateInput; minQuantity?: number } }
  | { shippingCountryIn: string[] }
  | { customerGroupIn: string[] };

const amountsInput = (list: MoneyByCurrency[]) => list.filter((m) => m.amount.trim() !== "").map((m) => ({ currencyCode: m.currencyCode, amount: m.amount.trim() }));

export const predicateInput = (p: Predicate): PredicateInput => {
  switch (p.kind) {
    case "all":
      return { all: p.children.map(predicateInput) };
    case "any":
      return { any: p.children.map(predicateInput) };
    case "sku":
      return { skuIn: p.skus };
    case "product":
      return { productIn: p.productIds };
    case "category":
      return { categoryIn: p.categoryIds };
    case "attribute":
      return { attributeIn: { code: p.code, values: p.values } };
  }
};

export const conditionInput = (c: Condition): ConditionInput => {
  switch (c.kind) {
    case "all":
      return { all: c.children.map(conditionInput) };
    case "any":
      return { any: c.children.map(conditionInput) };
    case "none":
      return { not: c.children.length === 1 ? conditionInput(c.children[0]!) : { any: c.children.map(conditionInput) } };
    case "subtotal":
      return { subtotal: { operator: c.operator, amounts: amountsInput(c.amounts) } };
    case "quantity":
      return { totalQuantity: { operator: c.operator, value: c.value } };
    case "lines":
      return { lineMatches: { predicate: predicateInput(c.predicate), ...(c.minQuantity > 1 ? { minQuantity: c.minQuantity } : {}) } };
    case "country":
      return { shippingCountryIn: c.countries };
    case "group":
      return { customerGroupIn: c.groupIds };
  }
};

const percent = (value: string) => Number(value.replace(",", "."));

export const actionInput = (a: ActionState) => {
  const target = a.target ? { target: predicateInput(a.target) } : {};
  switch (a.kind) {
    case "percentageOff":
      return { percentageOff: { percent: percent(a.percent), ...target, ...(amountsInput(a.maxDiscount).length ? { maxDiscount: amountsInput(a.maxDiscount) } : {}) } };
    case "fixedOffEach":
      return { fixedOffEach: { amounts: amountsInput(a.amounts), ...target } };
    case "fixedOffCart":
      return { fixedOffCart: { amounts: amountsInput(a.amounts), ...target } };
    case "buyXGetY":
      return { buyXGetY: { buyQuantity: a.buyQuantity, getQuantity: a.getQuantity, percent: percent(a.percent || "100"), ...target } };
    case "shippingOff":
      return { shippingOff: { percent: percent(a.percent || "100"), ...(a.methodCodes.length ? { methodCodes: a.methodCodes } : {}) } };
  }
};

// ---------------------------------------------------------------- validation

/**
 * Something the API would reject. `key` is the condition or filter row's key, or an ACTION_FIELDS
 * value; `where` names the place in a summary ("Cart contains"); `message` is shown on the row.
 */
export type RuleProblem = { key: string; where: string; message: string };

/** Keys of the discount's own fields, for problems that are not about a row. */
export const ACTION_FIELDS = { percent: "action.percent", amounts: "action.amounts", quantities: "action.quantities" } as const;

/** Problems in a group of item filters, in the order they appear. */
export const validatePredicate = (p: Predicate, where: string): RuleProblem[] => {
  const problem = (message: string): RuleProblem[] => [{ key: p.key, where, message }];
  switch (p.kind) {
    case "all":
    case "any":
      return p.children.length ? p.children.flatMap((c) => validatePredicate(c, where)) : problem("Add a filter to the empty group, or remove it");
    case "sku":
      return p.skus.length ? [] : problem("Add at least one SKU");
    case "product":
      return p.productIds.length ? [] : problem("Choose at least one product");
    case "category":
      return p.categoryIds.length ? [] : problem("Choose at least one category");
    case "attribute":
      return !p.code ? problem("Choose an attribute") : p.values.length ? [] : problem("Choose at least one attribute value");
  }
};

/** Problems in the condition tree, in the order they appear. */
export const validateCondition = (c: Condition): RuleProblem[] => {
  const problem = (where: string, message: string): RuleProblem[] => [{ key: c.key, where, message }];
  switch (c.kind) {
    case "all":
    case "any":
      return c.children.flatMap(validateCondition);
    case "none":
      return c.children.length ? c.children.flatMap(validateCondition) : problem("None of these is true", "Add at least one condition, or remove the group");
    case "subtotal":
      return amountsInput(c.amounts).length ? [] : problem("Subtotal", "Enter an amount in at least one currency");
    case "quantity":
      return Number.isInteger(c.value) && c.value >= 0 ? [] : problem("Number of items", "Enter a whole number of 0 or more");
    case "lines":
      return validatePredicate(c.predicate, "Cart contains");
    case "country":
      return c.countries.length ? [] : problem("Ships to", "Choose at least one country");
    case "group":
      return c.groupIds.length ? [] : problem("Customer group", "Choose at least one group");
  }
};

export const validateAction = (a: ActionState): RuleProblem[] => {
  const problems: RuleProblem[] = [];
  const p = percent(a.percent);
  if ((a.kind === "percentageOff" || a.kind === "buyXGetY" || a.kind === "shippingOff") && !(p > 0 && p <= 100)) problems.push({ key: ACTION_FIELDS.percent, where: "Discount", message: "Enter a percentage more than 0 and at most 100" });
  if ((a.kind === "fixedOffEach" || a.kind === "fixedOffCart") && !amountsInput(a.amounts).length) problems.push({ key: ACTION_FIELDS.amounts, where: "Discount", message: "Enter the amount in at least one currency" });
  if (a.kind === "buyXGetY" && (!(a.buyQuantity >= 1) || !(a.getQuantity >= 1))) problems.push({ key: ACTION_FIELDS.quantities, where: "Buy X, get Y", message: "Buy and get quantities must be at least 1" });
  if (a.target && a.kind !== "shippingOff") problems.push(...validatePredicate(a.target, "Applies to"));
  return problems;
};

// ---------------------------------------------------------------- descriptions

export type Names = { product: (id: string) => string; category: (id: string) => string; group: (id: string) => string; attribute: (code: string) => string; country: (code: string) => string };

const join = (items: string[], word = "or") => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`);

export const describePredicate = (p: Predicate, names: Names): string => {
  switch (p.kind) {
    case "all":
      return p.children.length ? p.children.map((c) => describePredicate(c, names)).join(" and ") : "any item";
    case "any":
      return p.children.length ? `(${p.children.map((c) => describePredicate(c, names)).join(" or ")})` : "any item";
    case "sku":
      return `SKU ${join(p.skus) || "…"}`;
    case "product":
      return join(p.productIds.map(names.product)) || "the chosen products";
    case "category":
      return `items in ${join(p.categoryIds.map(names.category)) || "…"}`;
    case "attribute":
      return `${names.attribute(p.code) || "attribute"} is ${join(p.values) || "…"}`;
  }
};

export const describeCondition = (c: Condition, names: Names): string => {
  const op = (o: Operator) => OPERATORS.find((x) => x.value === o)?.label ?? o;
  switch (c.kind) {
    case "all":
      return c.children.length ? c.children.map((x) => describeCondition(x, names)).join(" and ") : "always";
    case "any":
      return c.children.length ? `either ${c.children.map((x) => describeCondition(x, names)).join(" or ")}` : "always";
    case "none":
      return `not (${c.children.map((x) => describeCondition(x, names)).join(" or ")})`;
    case "subtotal":
      return `the subtotal is ${op(c.operator)} ${moneyList(c.amounts)}`;
    case "quantity":
      return `the cart has ${op(c.operator)} ${c.value} item${c.value === 1 ? "" : "s"}`;
    case "lines":
      return `the cart contains ${c.minQuantity > 1 ? `${c.minQuantity} or more of ` : ""}${describePredicate(c.predicate, names)}`;
    case "country":
      return `it ships to ${join(c.countries.map(names.country)) || "…"}`;
    case "group":
      return `the customer is in ${join(c.groupIds.map(names.group)) || "…"}`;
  }
};

export const describeAction = (a: ActionState, names?: Names): string => {
  const on = a.target && names ? ` on ${describePredicate(a.target, names)}` : a.target ? " on matching items" : "";
  switch (a.kind) {
    case "percentageOff":
      return `${a.percent || "?"}% off${on}${amountsInput(a.maxDiscount).length ? ` (at most ${moneyList(a.maxDiscount)})` : ""}`;
    case "fixedOffEach":
      return `${moneyList(a.amounts)} off each item${on}`;
    case "fixedOffCart":
      return `${moneyList(a.amounts)} off the order${on}`;
    case "buyXGetY":
      return `Buy ${a.buyQuantity}, get ${a.getQuantity} ${percent(a.percent || "100") >= 100 ? "free" : `${a.percent}% off`}${on}`;
    case "shippingOff":
      return `${percent(a.percent || "100") >= 100 ? "Free shipping" : `${a.percent}% off shipping`}${a.methodCodes.length ? ` (${a.methodCodes.join(", ")})` : ""}`;
  }
};

export const summarizeStoredAction = (stored: unknown) => describeAction(actionFromStored(stored));
