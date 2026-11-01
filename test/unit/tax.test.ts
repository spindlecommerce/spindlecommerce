import { describe, expect, it } from "vitest";
import { rateMatches, resolveTaxRate, splitTax, taxInGross, taxOnNet, type TaxRateRow, type TaxRuleRow } from "../../src/modules/tax/engine.ts";

const rate = (id: string, r: number, extra: Partial<TaxRateRow> = {}): TaxRateRow => ({ id, name: id, countryCode: "US", regionCode: null, postalCodePattern: null, rate: r, ...extra });

describe("tax engine", () => {
  it("matches rates by country, region and postal code glob", () => {
    const ca = rate("ca", 7.25, { regionCode: "CA" });
    const la = rate("la", 2.25, { regionCode: "CA", postalCodePattern: "900*" });
    expect(rateMatches(ca, { countryCode: "US", regionCode: "CA" })).toBe(true);
    expect(rateMatches(ca, { countryCode: "US", regionCode: "NY" })).toBe(false);
    expect(rateMatches(la, { countryCode: "US", regionCode: "CA", postalCode: "90012" })).toBe(true);
    expect(rateMatches(la, { countryCode: "US", regionCode: "CA", postalCode: "94105" })).toBe(false);
  });

  it("adds rates of equal priority and compounds higher priorities", () => {
    const rates = [rate("state", 6), rate("county", 1), rate("luxury", 10)];
    const rules: TaxRuleRow[] = [
      { priority: 0, productTaxClassIds: ["std"], customerTaxClassIds: [], taxRateIds: ["state", "county"] },
      { priority: 1, productTaxClassIds: ["std"], customerTaxClassIds: [], taxRateIds: ["luxury"] },
    ];
    const resolved = resolveTaxRate(rules, rates, { productTaxClassId: "std", customerTaxClassId: null, destination: { countryCode: "US" } });
    // (1 + 0.07) × (1 + 0.10) − 1 = 17.7%
    expect(resolved.rate).toBeCloseTo(17.7, 6);
    expect(resolved.components.map((c) => c.rate).reduce((a, b) => a + b, 0)).toBeCloseTo(17.7, 6);
    expect(taxOnNet(10000, resolved.rate)).toBe(1770);
    expect(splitTax(1770, resolved).reduce((s, t) => s + t.amount, 0)).toBe(1770);
  });

  it("respects customer tax classes and product classes", () => {
    const rules: TaxRuleRow[] = [{ priority: 0, productTaxClassIds: ["std"], customerTaxClassIds: ["retail"], taxRateIds: ["vat"] }];
    const rates = [rate("vat", 20, { countryCode: "GB" })];
    const dest = { countryCode: "GB" };
    expect(resolveTaxRate(rules, rates, { productTaxClassId: "std", customerTaxClassId: "retail", destination: dest }).rate).toBe(20);
    expect(resolveTaxRate(rules, rates, { productTaxClassId: "std", customerTaxClassId: "exempt", destination: dest }).rate).toBe(0);
    expect(resolveTaxRate(rules, rates, { productTaxClassId: "books", customerTaxClassId: "retail", destination: dest }).rate).toBe(0);
    expect(resolveTaxRate(rules, rates, { productTaxClassId: "std", customerTaxClassId: "retail", destination: null }).rate).toBe(0);
  });

  it("extracts tax from tax-inclusive prices", () => {
    expect(taxInGross(11900, 19)).toBe(1900);
    expect(taxInGross(2200, 7)).toBe(144);
    expect(taxInGross(1000, 0)).toBe(0);
  });
});
