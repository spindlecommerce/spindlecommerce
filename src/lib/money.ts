import { ValidationError } from "./errors.ts";

/**
 * Money is always an integer count of the currency's minor unit (cents for USD, yen for JPY).
 * Floats appear only when formatting for display.
 */
export type Money = { amount: number; currency: string };

const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

export const CURRENCY_CODE = /^[A-Z]{3}$/;

export const currencyExponent = (currency: string): number => EXPONENTS[currency] ?? 2;

export const money = (amount: number, currency: string): Money => {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Money amount must be a safe integer, got ${amount}`);
  return { amount, currency };
};

/** Minor units → decimal string, e.g. (1999, "USD") → "19.99", (-5, "USD") → "-0.05". */
export const toDecimalString = (minor: number, currency: string): string => {
  const exponent = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  return exponent === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
};

/** Decimal string → minor units. Rejects more fractional digits than the currency allows. */
export const fromDecimalString = (decimal: string, currency: string, path: string[] = ["amount"]): number => {
  const invalid = (message: string) => new ValidationError(message, [{ path, message }]);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) throw invalid(`"${decimal}" is not a decimal amount`);
  const exponent = currencyExponent(currency);
  const fraction = match[3] ?? "";
  if (fraction.length > exponent) throw invalid(`${currency} allows ${exponent} decimal places, got "${decimal}"`);
  const minor = Number(`${match[2]}${fraction.padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(minor)) throw invalid(`"${decimal}" is out of range`);
  return match[1] ? -minor : minor;
};

export const formatMoney = (minor: number, currency: string, locale: string): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** currencyExponent(currency));

/** Round half away from zero, the convention most tax authorities expect for line amounts. */
export const roundHalfUp = (value: number): number => (value < 0 ? -Math.round(-value) : Math.round(value));

export const percentOf = (minor: number, percent: number): number => roundHalfUp((minor * percent) / 100);

/**
 * Split `total` across `weights` so the parts sum exactly to `total` (largest-remainder method).
 * Zero total weight splits evenly.
 */
export const allocate = (total: number, weights: number[]): number[] => {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const effective = sum === 0 ? weights.map(() => 1) : weights;
  const effectiveSum = sum === 0 ? weights.length : sum;
  const exact = effective.map((w) => (total * w) / effectiveSum);
  const parts = exact.map((x) => Math.trunc(x));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: Math.abs(x - Math.trunc(x)) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = remainder < 0 ? -1 : 1;
  for (let k = 0; remainder !== 0; k = (k + 1) % order.length) {
    parts[order[k]!.i]! += step;
    remainder -= step;
  }
  return parts;
};

/** Rounded in the target currency's minor unit, half away from zero. */
export const convert = (minor: number, from: string, to: string, rate: number): number => {
  const scale = 10 ** (currencyExponent(to) - currencyExponent(from));
  return roundHalfUp(minor * rate * scale);
};
