import { describe, expect, it } from "vitest";
import { selectPrice, type PriceRow } from "../../src/modules/pricing/resolve.ts";

const row = (overrides: Partial<PriceRow>): PriceRow => ({
  id: crypto.randomUUID(),
  variantId: "v",
  channelId: "c",
  currency: "USD",
  amount: 1000,
  compareAtAmount: null,
  costAmount: null,
  customerGroupId: null,
  minQuantity: 1,
  startsAt: null,
  endsAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const at = new Date("2026-06-15T12:00:00Z");

describe("price selection", () => {
  it("uses the list price by default", () => {
    expect(selectPrice([row({ amount: 2500 })], { customerGroupId: null, at })).toEqual({ amount: 2500, compareAtAmount: null, tierPrices: [] });
  });

  it("takes the lowest of special, tier and group prices that apply, showing the list price as compare-at", () => {
    const rows = [
      row({ amount: 2500 }),
      row({ amount: 2200, minQuantity: 5 }),
      row({ amount: 2000, customerGroupId: "wholesale" }),
      row({ amount: 1900, startsAt: new Date("2026-06-01"), endsAt: new Date("2026-07-01") }),
    ];
    expect(selectPrice(rows, { customerGroupId: null, at }, 1)).toMatchObject({ amount: 1900, compareAtAmount: 2500 });
    expect(selectPrice(rows, { customerGroupId: null, at: new Date("2026-08-01") }, 1)).toMatchObject({ amount: 2500, compareAtAmount: null });
    expect(selectPrice(rows, { customerGroupId: null, at: new Date("2026-08-01") }, 5)).toMatchObject({ amount: 2200, compareAtAmount: 2500 });
    expect(selectPrice(rows, { customerGroupId: "wholesale", at: new Date("2026-08-01") }, 1)).toMatchObject({ amount: 2000 });
  });

  it("lists tier prices for display and keeps an explicit compare-at", () => {
    const rows = [row({ amount: 2500, compareAtAmount: 3000 }), row({ amount: 2200, minQuantity: 5 }), row({ amount: 2000, minQuantity: 10 })];
    expect(selectPrice(rows, { customerGroupId: null, at })).toEqual({
      amount: 2500,
      compareAtAmount: 3000,
      tierPrices: [{ minQuantity: 5, amount: 2200 }, { minQuantity: 10, amount: 2000 }],
    });
  });

  it("returns null when nothing applies", () => {
    expect(selectPrice([row({ amount: 2000, minQuantity: 10 })], { customerGroupId: null, at }, 1)).toBeNull();
    expect(selectPrice([row({ customerGroupId: "wholesale" })], { customerGroupId: "general", at })).toBeNull();
  });
});
