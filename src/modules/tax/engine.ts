import { allocate, roundHalfUp } from "../../lib/money.ts";

export type TaxRateRow = {
  id: string;
  name: string;
  countryCode: string;
  regionCode: string | null;
  postalCodePattern: string | null;
  rate: number;
};

export type TaxRuleRow = {
  priority: number;
  productTaxClassIds: string[];
  customerTaxClassIds: string[];
  taxRateIds: string[];
};

export type TaxDestination = { countryCode: string; regionCode?: string | null; postalCode?: string | null };

export type ResolvedTaxRate = {
  /** Effective percent after compounding, e.g. 19 or 13.4. */
  rate: number;
  components: { name: string; rate: number }[];
};

export const NO_TAX: ResolvedTaxRate = { rate: 0, components: [] };

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

export const rateMatches = (rate: TaxRateRow, destination: TaxDestination): boolean =>
  rate.countryCode === destination.countryCode &&
  (rate.regionCode === null || rate.regionCode === "*" || rate.regionCode === (destination.regionCode ?? null)) &&
  (rate.postalCodePattern === null || rate.postalCodePattern === "*" ||
    (destination.postalCode != null && globToRegExp(rate.postalCodePattern).test(destination.postalCode.replace(/\s/g, ""))));

/** Equal priorities add their rates; each higher priority compounds on the lower ones' tax. */
export const resolveTaxRate = (
  rules: TaxRuleRow[],
  rates: TaxRateRow[],
  input: { productTaxClassId: string | null; customerTaxClassId: string | null; destination: TaxDestination | null },
): ResolvedTaxRate => {
  if (!input.destination || !input.productTaxClassId) return NO_TAX;
  const rateById = new Map(rates.map((r) => [r.id, r]));
  const byPriority = new Map<number, Map<string, TaxRateRow>>();
  for (const rule of rules) {
    if (!rule.productTaxClassIds.includes(input.productTaxClassId)) continue;
    if (rule.customerTaxClassIds.length > 0 && (!input.customerTaxClassId || !rule.customerTaxClassIds.includes(input.customerTaxClassId))) continue;
    for (const rateId of rule.taxRateIds) {
      const rate = rateById.get(rateId);
      if (!rate || !rateMatches(rate, input.destination)) continue;
      const group = byPriority.get(rule.priority) ?? new Map<string, TaxRateRow>();
      group.set(rate.id, rate);
      byPriority.set(rule.priority, group);
    }
  }
  if (byPriority.size === 0) return NO_TAX;
  let multiplier = 1;
  const components: ResolvedTaxRate["components"] = [];
  for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
    const group = [...byPriority.get(priority)!.values()];
    const groupRate = group.reduce((sum, r) => sum + r.rate, 0);
    // Each component's effective share of the compounded rate.
    for (const r of group) components.push({ name: r.name, rate: (r.rate * multiplier) });
    multiplier *= 1 + groupRate / 100;
  }
  return { rate: Number(((multiplier - 1) * 100).toFixed(6)), components };
};

export const taxOnNet = (net: number, rate: number): number => roundHalfUp((net * rate) / 100);

export const taxInGross = (gross: number, rate: number): number => (rate === 0 ? 0 : gross - roundHalfUp(gross / (1 + rate / 100)));

/** In proportion to the components' rates. */
export const splitTax = (amount: number, resolved: ResolvedTaxRate): { name: string; rate: number; amount: number }[] => {
  if (resolved.components.length === 0 || amount === 0) return [];
  const parts = allocate(amount, resolved.components.map((c) => Math.round(c.rate * 10_000)));
  return resolved.components.map((c, i) => ({ name: c.name, rate: Number(c.rate.toFixed(4)), amount: parts[i]! }));
};
