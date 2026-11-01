const locale = typeof navigator === "undefined" ? "en-US" : navigator.language;

export type MoneyLike = { amount?: string | null; currencyCode?: string | null; formatted?: string | null } | null | undefined;

export const formatMoney = (money: MoneyLike) => {
  if (!money?.amount || !money.currencyCode) return "—";
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currencyCode }).format(Number(money.amount));
};

export const formatAmount = (amount: number, currency: string, options: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat(locale, { style: "currency", currency, ...options }).format(amount);

export const formatNumber = (value: number | null | undefined, options: Intl.NumberFormatOptions = {}) =>
  value === null || value === undefined ? "—" : new Intl.NumberFormat(locale, options).format(value);

export const formatPercent = (value: number, digits = 1) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(value);

/** "20 MB", "512 KB": 1024-based, as the API words its upload limits. */
export const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return "—";
  const [size, unit] = bytes >= 1024 ** 3 ? [bytes / 1024 ** 3, "GB"] : bytes >= 1024 ** 2 ? [bytes / 1024 ** 2, "MB"] : bytes >= 1024 ? [bytes / 1024, "KB"] : [bytes, bytes === 1 ? "byte" : "bytes"];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: size >= 100 ? 0 : 1 }).format(size)} ${unit}`;
};

export const formatDate = (iso: string | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) =>
  iso ? new Intl.DateTimeFormat(locale, options).format(new Date(iso)) : "—";

export const formatDateTime = (iso: string | null | undefined) => formatDate(iso, { dateStyle: "medium", timeStyle: "short" });

const RELATIVE: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

export const relativeTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of RELATIVE) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return rtf.format(Math.round(seconds), "second");
};

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local midnight, `daysAgo` days ago. */
export const startOfDay = (daysAgo = 0) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
};

export const countryName = (code: string | null | undefined) => {
  if (!code) return "—";
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export const COUNTRY_CODES = "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");

export const CURRENCY_CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK", "NZD", "SGD", "HKD", "MXN", "BRL", "INR", "CNY", "ZAR"];
