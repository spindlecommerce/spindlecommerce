import { describe, expect, it } from "vitest";
import { allocate, convert, fromDecimalString, percentOf, roundHalfUp, toDecimalString } from "../../src/lib/money.ts";

describe("money", () => {
  it("round-trips decimal strings in each currency's minor unit", () => {
    expect(toDecimalString(1999, "USD")).toBe("19.99");
    expect(toDecimalString(5, "USD")).toBe("0.05");
    expect(toDecimalString(-5, "EUR")).toBe("-0.05");
    expect(toDecimalString(1500, "JPY")).toBe("1500");
    expect(toDecimalString(1234, "KWD")).toBe("1.234");
    expect(fromDecimalString("19.99", "USD")).toBe(1999);
    expect(fromDecimalString("19.9", "USD")).toBe(1990);
    expect(fromDecimalString("1500", "JPY")).toBe(1500);
  });

  it("rejects amounts with more precision than the currency has, as validation errors", () => {
    expect(() => fromDecimalString("1.999", "USD")).toThrow(/2 decimal places/);
    expect(() => fromDecimalString("1.5", "JPY")).toThrow(/0 decimal places/);
    expect(() => fromDecimalString("abc", "USD", ["filter", "price", "min"])).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", fieldErrors: [{ path: ["filter", "price", "min"], message: '"abc" is not a decimal amount' }] }));
  });

  it("rounds half away from zero", () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(percentOf(7975, 10)).toBe(798);
  });

  it("allocates exactly, never losing a cent", () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(1000, [3000, 2000, 0])).toEqual([600, 400, 0]);
    expect(allocate(5, [0, 0])).toEqual([3, 2]);
    for (const total of [1, 99, 1001, 123457]) {
      const parts = allocate(total, [7, 13, 29, 51]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("converts between currencies of different exponents", () => {
    expect(convert(2400, "EUR", "GBP", 0.86)).toBe(2064);
    expect(convert(1000, "USD", "JPY", 150)).toBe(1500);
  });
});
