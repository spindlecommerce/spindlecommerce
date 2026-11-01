import type { Address, PluginOrder, TrackingNumber } from "../../src/plugins/sdk.ts";
import { language, stringsFor, type Strings } from "./strings.ts";

/**
 * Table-based HTML with inline styles, as email clients need, in one 600 px column. Every dynamic
 * value goes through `html`, which escapes it.
 */
export type Rendered = { subject: string; html: string; text: string };
export type Brand = { storeName: string; logoUrl: string | null; accentColor: string; storefrontUrl: string | null; replyTo: boolean };

export const TEMPLATES = [
  "order_confirmation",
  "order_shipped",
  "order_refunded",
  "order_canceled",
  "customer_password_reset",
  "staff_password_reset",
  "staff_new_order",
  "low_stock",
  "test",
] as const;
export type TemplateName = (typeof TEMPLATES)[number];

// ---------------------------------------------------------------- escaping and values

/** Markup that is already safe; anything else interpolated into `html` is escaped. */
type Html = { readonly __html: string };
const isHtml = (value: unknown): value is Html => typeof value === "object" && value !== null && "__html" in value;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

const fragment = (value: unknown): string =>
  value == null || value === false ? "" : Array.isArray(value) ? value.map(fragment).join("") : isHtml(value) ? value.__html : escapeHtml(String(value));

/** `html\`<p>${text}</p>\`` escapes `text`; nested `html` fragments and arrays of them pass through. */
export const html = (strings: TemplateStringsArray, ...values: unknown[]): Html => ({
  __html: strings.reduce((out, s, i) => out + s + (i < values.length ? fragment(values[i]) : ""), ""),
});

/** Only http(s) URLs become links or images: a stored `javascript:` URL must never be clickable. */
export const safeUrl = (url: string | null | undefined): string | null => {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
};

export const DEFAULT_ACCENT = "#111827";
/** A hex color, or the default: the value lands in style attributes. */
export const safeColor = (color: string | null | undefined): string => (color && /^#(?:[0-9a-f]{3}){1,2}$/i.test(color.trim()) ? color.trim().toLowerCase() : DEFAULT_ACCENT);

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
const textOn = (hex: string) => {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(digits.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.179 ? "#111827" : "#ffffff";
};

/** A locale Intl accepts, or English. */
const usableLocale = (locale: string) => {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {
    return "en";
  }
};

// Minor units per currency, as the platform counts them (ISO 4217; 2 when not listed).
const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

/** Integer minor units → "$1,234.50", "1.234,50 €", "1 234,50 €" per locale. */
export const formatMoney = (minor: number, currency: string, locale: string) =>
  new Intl.NumberFormat(usableLocale(locale), { style: "currency", currency }).format(minor / 10 ** (EXPONENTS[currency] ?? 2));

const countryName = (code: string, locale: string) => {
  try {
    return new Intl.DisplayNames([usableLocale(locale)], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Postal lines in the order most of the country's mail uses. */
export const addressLines = (a: Address, locale: string): string[] => {
  const region = a.regionCode ?? a.region;
  const locality = ["US", "CA", "AU"].includes(a.countryCode)
    ? [[a.city, region].filter(Boolean).join(", ") + ` ${a.postalCode}`]
    : a.countryCode === "GB"
      ? [a.city, a.postalCode]
      : [`${a.postalCode} ${a.city}`];
  return [[a.firstName, a.lastName].filter(Boolean).join(" "), a.company, a.line1, a.line2, ...locality, countryName(a.countryCode, locale)]
    .map((line) => line?.trim())
    .filter((line): line is string => !!line);
};

// Public tracking pages of common carriers, for tracking numbers stored without a URL.
const CARRIERS: [RegExp, (number: string) => string][] = [
  [/^ups$/, (n) => `https://www.ups.com/track?tracknum=${n}`],
  [/^usps$/, (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`],
  [/^fedex$/, (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`],
  [/^(dhlpaket|deutschepost)$/, (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}`],
  [/^dhl/, (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}&submit=1`],
  [/^royalmail$/, (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`],
  [/^(colissimo|laposte)$/, (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${n}`],
  [/^canadapost$/, (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${n}`],
];

export const trackingUrl = (tracking: TrackingNumber): string | null => {
  const own = safeUrl(tracking.url);
  if (own) return own;
  const carrier = tracking.carrier.toLowerCase().replace(/[^a-z]/g, "");
  const match = CARRIERS.find(([pattern]) => pattern.test(carrier));
  return match ? match[1](encodeURIComponent(tracking.number.trim())) : null;
};

// ---------------------------------------------------------------- blocks and layout

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";

/** A piece of an email in both formats. */
type Block = { html: Html; text: string };

const heading = (text: string): Block => ({ html: html`<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${text}</h1>`, text });
const paragraph = (text: string, muted = false): Block => ({
  html: html`<p style="margin:0 0 16px;${muted ? `font-size:13px;color:${MUTED};` : ""}">${text}</p>`,
  text,
});

/** A bulletproof button; `fallback` adds the URL as text for clients that block it (reset links). */
const button = (brand: Brand, link: string, label: string, s: Strings, fallback = true): Block => {
  const url = safeUrl(link);
  if (!url) return { html: html``, text: "" };
  const accent = safeColor(brand.accentColor);
  return {
    html: html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td style="border-radius:6px;background:${accent};"><a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:${textOn(accent)};text-decoration:none;border-radius:6px;">${label}</a></td></tr></table>
${fallback ? html`<p style="margin:0 0 16px;font-size:13px;color:${MUTED};word-break:break-all;">${s.linkFallback}<br><a href="${url}" style="color:${MUTED};">${url}</a></p>` : ""}`,
    text: `${label}:\n${url}`,
  };
};

type Row = { name: string; detail?: string | null; quantity: number; amount?: string | null };

const itemsTable = (rows: Row[], s: Strings, withAmounts: boolean): Block => {
  const cell = `padding:10px 0;border-bottom:1px solid ${RULE};vertical-align:top;`;
  return {
    html: html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;border-collapse:collapse;">
<tr><th align="left" style="padding:0 0 6px;font-size:12px;font-weight:600;color:${MUTED};border-bottom:1px solid ${RULE};">${s.item}</th><th align="right" style="padding:0 0 6px 12px;font-size:12px;font-weight:600;color:${MUTED};border-bottom:1px solid ${RULE};">${s.qty}</th>${withAmounts ? html`<th align="right" style="padding:0 0 6px 12px;font-size:12px;font-weight:600;color:${MUTED};border-bottom:1px solid ${RULE};">${s.amount}</th>` : ""}</tr>
${rows.map(
  (r) =>
    html`<tr><td style="${cell}word-break:break-word;">${r.name}${r.detail ? html`<br><span style="font-size:13px;color:${MUTED};">${r.detail}</span>` : ""}</td><td align="right" style="${cell}padding-left:12px;white-space:nowrap;">${r.quantity}</td>${withAmounts ? html`<td align="right" style="${cell}padding-left:12px;white-space:nowrap;">${r.amount ?? ""}</td>` : ""}</tr>`,
)}
</table>`,
    text: rows.map((r) => `${r.quantity} × ${r.name}${r.detail ? ` (${r.detail})` : ""}${withAmounts && r.amount ? `  ${r.amount}` : ""}`).join("\n"),
  };
};

const totalsTable = (rows: { label: string; value: string; strong?: boolean }[]): Block => ({
  html: html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
${rows.map(
  (r) =>
    html`<tr><td style="padding:3px 0;${r.strong ? `font-weight:700;font-size:16px;color:${INK};` : `color:${MUTED};`}">${r.label}</td><td align="right" style="padding:3px 0 3px 12px;white-space:nowrap;${r.strong ? "font-weight:700;font-size:16px;" : ""}">${r.value}</td></tr>`,
)}
</table>`,
  text: rows.map((r) => `${r.label}: ${r.value}`).join("\n"),
});

/** Side by side when there is room, stacked on phones (inline-blocks that wrap). */
const columns = (sections: { title: string; lines: string[] }[]): Block => ({
  html: html`<div style="margin:0 0 8px;">${sections.map(
    (c) =>
      html`<div style="display:inline-block;vertical-align:top;width:100%;max-width:256px;margin:0 0 16px;"><div style="font-size:12px;font-weight:600;color:${MUTED};margin:0 0 4px;">${c.title}</div><div style="font-size:14px;">${c.lines.map((line, i) => html`${i ? html`<br>` : ""}${line}`)}</div></div>`,
  )}</div>`,
  text: sections.map((c) => [c.title, ...c.lines].join("\n")).join("\n\n"),
});

const layout = (input: { brand: Brand; locale: string; subject: string; preheader: string; blocks: Block[]; help: boolean; s: Strings }) => {
  const { brand } = input;
  const logoUrl = safeUrl(brand.logoUrl);
  const storefrontUrl = safeUrl(brand.storefrontUrl);
  const accent = safeColor(brand.accentColor);
  const logo = logoUrl ? html`<img src="${logoUrl}" alt="${brand.storeName}" height="40" style="display:block;height:40px;width:auto;max-width:240px;border:0;">` : null;
  const store = storefrontUrl ? html`<a href="${storefrontUrl}" style="color:${MUTED};">${brand.storeName}</a>` : brand.storeName;
  return html`<!doctype html>
<html lang="${language(input.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${input.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${input.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;border-top:4px solid ${accent};">
<tr><td style="padding:24px 28px 0;font-family:${FONT};font-size:18px;font-weight:700;color:${INK};">${logo ?? brand.storeName}</td></tr>
<tr><td style="padding:20px 28px 12px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK};">
${input.blocks.map((b) => b.html)}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:16px 28px;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">${input.help ? html`${input.s.help}<br>` : ""}${store}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`.__html;
};

const render = (input: { brand: Brand; locale: string; subject: string; preheader: string; blocks: Block[]; help?: boolean }): Rendered => {
  const s = stringsFor(input.locale);
  const help = (input.help ?? false) && input.brand.replyTo;
  const footer = [help ? s.help : null, input.brand.storeName, safeUrl(input.brand.storefrontUrl)].filter(Boolean).join("\n");
  return {
    subject: input.subject,
    html: layout({ ...input, help, s }),
    text: [...input.blocks.map((b) => b.text).filter(Boolean), `--\n${footer}`].join("\n\n"),
  };
};

// ---------------------------------------------------------------- order pieces

type Line = PluginOrder["lines"][number];

const detail = (line: Line) => Object.values(line.variantAttributes ?? {}).filter(Boolean).join(" / ") || null;
const firstName = (order: PluginOrder) => order.billingAddress?.firstName ?? order.shippingAddress?.firstName ?? null;

const orderLines = (order: PluginOrder, s: Strings, locale: string) =>
  itemsTable(
    order.lines.map((l) => ({ name: l.name, detail: detail(l), quantity: l.quantity, amount: formatMoney(l.total, order.currency, locale) })),
    s,
    true,
  );

const orderTotals = (order: PluginOrder, s: Strings, locale: string) => {
  const money = (minor: number) => formatMoney(minor, order.currency, locale);
  return totalsTable([
    { label: s.subtotal, value: money(order.subtotal) },
    ...(order.discountTotal ? [{ label: s.discount, value: money(-order.discountTotal) }] : []),
    ...(order.shippingMethod || order.shippingTotal ? [{ label: order.shippingMethod ? `${s.shipping} (${order.shippingMethod.name})` : s.shipping, value: money(order.shippingTotal) }] : []),
    ...(order.taxTotal ? [{ label: order.pricesIncludeTax ? s.taxIncluded : s.tax, value: money(order.taxTotal) }] : []),
    { label: s.total, value: money(order.grandTotal), strong: true },
  ]);
};

/** Shipping and billing address; one of them when they are the same. */
const orderAddresses = (order: PluginOrder, s: Strings, locale: string, which: "both" | "shipping" = "both") => {
  const shipping = order.shippingAddress ? addressLines(order.shippingAddress, locale) : null;
  const billing = which === "both" && order.billingAddress ? addressLines(order.billingAddress, locale) : null;
  return columns([
    ...(shipping ? [{ title: s.shippingAddress, lines: shipping }] : []),
    ...(billing && billing.join("\n") !== shipping?.join("\n") ? [{ title: s.billingAddress, lines: billing }] : []),
  ]);
};

// ---------------------------------------------------------------- templates

export const orderConfirmation = (input: { order: PluginOrder; brand: Brand; locale?: string }): Rendered => {
  const { order, brand } = input;
  const locale = input.locale ?? order.locale;
  const s = stringsFor(locale);
  const intro = order.lines.some((l) => l.isShippable) ? s.confirmation.intro : s.confirmation.introDigital;
  const subject = s.confirmation.subject(order.number);
  return render({
    brand,
    locale,
    subject,
    preheader: intro,
    help: true,
    blocks: [heading(subject), paragraph(s.hello(firstName(order))), paragraph(intro), orderLines(order, s, locale), orderTotals(order, s, locale), orderAddresses(order, s, locale)],
  });
};

export type Shipment = { number: string; tracking: TrackingNumber[]; lines: { orderLineId: string; quantity: number }[] };

export const orderShipped = (input: { order: PluginOrder; shipment: Shipment; complete: boolean; brand: Brand; locale?: string }): Rendered => {
  const { order, shipment, brand } = input;
  const locale = input.locale ?? order.locale;
  const s = stringsFor(locale);
  const intro = input.complete ? s.shipped.intro : s.shipped.introPartial;
  const subject = s.shipped.subject(order.number);
  const rows = shipment.lines.flatMap((sl) => {
    const line = order.lines.find((l) => l.id === sl.orderLineId);
    return line ? [{ name: line.name, detail: detail(line), quantity: sl.quantity }] : [];
  });
  const tracking = shipment.tracking.filter((t) => t.number?.trim());
  const links = tracking.map((t) => ({ ...t, url: trackingUrl(t) }));
  const single = links.length === 1 ? links[0]!.url : null;
  return render({
    brand,
    locale,
    subject,
    preheader: intro,
    help: true,
    blocks: [
      heading(subject),
      paragraph(s.hello(firstName(order))),
      paragraph(intro),
      ...(links.length
        ? [
            {
              html: html`<p style="margin:0 0 16px;">${links.map(
                (t, i) =>
                  html`${i ? html`<br>` : ""}${s.shipped.tracking} (${t.carrier}): ${t.url ? html`<a href="${t.url}" style="color:${safeColor(brand.accentColor)};font-weight:600;">${t.number}</a>` : html`<strong>${t.number}</strong>`}`,
              )}</p>`,
              text: links.map((t) => `${s.shipped.tracking} (${t.carrier}): ${t.number}${t.url ? `\n${t.url}` : ""}`).join("\n"),
            },
          ]
        : []),
      // The text version already lists the link with the number.
      ...(single ? [{ ...button(brand, single, s.shipped.track, s, false), text: "" }] : []),
      ...(rows.length ? [paragraph(s.shipped.inShipment), itemsTable(rows, s, false)] : []),
      orderAddresses(order, s, locale, "shipping"),
    ],
  });
};

export const orderRefunded = (input: { order: PluginOrder; amount: number | null; refundNumber: string | null; brand: Brand; locale?: string }): Rendered => {
  const { order, brand } = input;
  const locale = input.locale ?? order.locale;
  const s = stringsFor(locale);
  const amount = input.amount != null ? formatMoney(input.amount, order.currency, locale) : null;
  const intro = amount ? s.refunded.intro(amount) : s.refunded.introNoAmount;
  const subject = s.refunded.subject(order.number);
  return render({
    brand,
    locale,
    subject,
    preheader: intro,
    help: true,
    blocks: [
      heading(subject),
      paragraph(s.hello(firstName(order))),
      paragraph(intro),
      ...(amount ? [totalsTable([{ label: input.refundNumber ? `${s.refunded.refund} ${input.refundNumber}` : s.refunded.refund, value: amount, strong: true }])] : []),
    ],
  });
};

export const orderCanceled = (input: { order: PluginOrder; declined: boolean; brand: Brand; locale?: string }): Rendered => {
  const { order, brand } = input;
  const locale = input.locale ?? order.locale;
  const s = stringsFor(locale);
  const intro = input.declined ? s.canceled.declined : s.canceled.intro;
  const subject = s.canceled.subject(order.number);
  return render({
    brand,
    locale,
    subject,
    preheader: intro,
    help: true,
    blocks: [heading(subject), paragraph(s.hello(firstName(order))), paragraph(intro), orderLines(order, s, locale), orderTotals(order, s, locale)],
  });
};

export const customerPasswordReset = (input: { name: string | null; url: string; brand: Brand; locale: string }): Rendered => {
  const s = stringsFor(input.locale);
  const intro = s.customerReset.intro(input.brand.storeName);
  return render({
    brand: input.brand,
    locale: input.locale,
    subject: s.customerReset.subject,
    preheader: intro,
    blocks: [heading(s.customerReset.subject), paragraph(s.hello(input.name)), paragraph(intro), button(input.brand, input.url, s.customerReset.button, s), paragraph(s.customerReset.note, true)],
  });
};

export const staffPasswordReset = (input: { name: string | null; url: string; brand: Brand; locale: string }): Rendered => {
  const s = stringsFor(input.locale);
  const subject = s.staffReset.subject(input.brand.storeName);
  const intro = s.staffReset.intro(input.brand.storeName);
  return render({
    brand: input.brand,
    locale: input.locale,
    subject,
    preheader: intro,
    blocks: [heading(subject), paragraph(s.hello(input.name)), paragraph(intro), button(input.brand, input.url, s.customerReset.button, s), paragraph(s.customerReset.note, true)],
  });
};

export const staffNewOrder = (input: { order: PluginOrder; channelName: string; adminUrl: string; brand: Brand; locale: string }): Rendered => {
  const { order, brand, locale } = input;
  const s = stringsFor(locale);
  const total = formatMoney(order.grandTotal, order.currency, locale);
  const name = [order.billingAddress?.firstName, order.billingAddress?.lastName].filter(Boolean).join(" ");
  const customer = name ? `${name} (${order.email})` : order.email;
  const subject = s.newOrder.subject(order.number, total);
  const intro = s.newOrder.intro(customer, order.number, total, input.channelName);
  return render({
    brand,
    locale,
    subject,
    preheader: intro,
    blocks: [
      heading(subject),
      paragraph(intro),
      button(brand, input.adminUrl, s.newOrder.button, s, false),
      orderLines(order, s, locale),
      orderTotals(order, s, locale),
      orderAddresses(order, s, locale),
    ],
  });
};

export type LowStockItem = { sku: string; name: string; quantity: number; location: string };

export const lowStock = (input: { item: LowStockItem; threshold: number; adminUrl: string; brand: Brand; locale: string }): Rendered => {
  const { item, brand, locale } = input;
  const s = stringsFor(locale);
  const subject = s.lowStock.subject(item.sku, item.quantity);
  const intro = s.lowStock.intro(item.name, item.sku, item.quantity, item.location, input.threshold);
  return render({ brand, locale, subject, preheader: intro, blocks: [heading(subject), paragraph(intro), button(brand, input.adminUrl, s.lowStock.button, s, false)] });
};

export const testEmail = (input: { provider: string; brand: Brand; locale: string }): Rendered => {
  const s = stringsFor(input.locale);
  const subject = s.test.subject(input.brand.storeName);
  const intro = s.test.intro(input.provider);
  return render({ brand: input.brand, locale: input.locale, subject, preheader: intro, blocks: [heading(subject), paragraph(intro)] });
};

// ---------------------------------------------------------------- sample data (previews)

const SAMPLES: Record<string, { currency: string; pricesIncludeTax: boolean; carrier: string; trackingNumber: string; shippingName: string; address: Address }> = {
  "en-US": {
    currency: "USD",
    pricesIncludeTax: false,
    carrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    shippingName: "Standard (5–7 days)",
    address: { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" },
  },
  "en-GB": {
    currency: "GBP",
    pricesIncludeTax: true,
    carrier: "Royal Mail",
    trackingNumber: "AB123456789GB",
    shippingName: "Royal Mail",
    address: { firstName: "Alex", lastName: "Morgan", line1: "12 High Street", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" },
  },
  de: {
    currency: "EUR",
    pricesIncludeTax: true,
    carrier: "DHL",
    trackingNumber: "00340434161234567890",
    shippingName: "Standardversand",
    address: { firstName: "Mia", lastName: "Schmidt", line1: "Unter den Linden 1", city: "Berlin", postalCode: "10117", countryCode: "DE" },
  },
  fr: {
    currency: "EUR",
    pricesIncludeTax: true,
    carrier: "Colissimo",
    trackingNumber: "6A12345678901",
    shippingName: "Livraison standard",
    address: { firstName: "Léa", lastName: "Martin", line1: "10 rue de Rivoli", city: "Paris", postalCode: "75001", countryCode: "FR" },
  },
};

/** A plausible order in the locale's currency and country, for previews without a real one. */
export const sampleOrder = (locale: string): PluginOrder => {
  const sample = SAMPLES[locale] ?? SAMPLES[language(locale)] ?? SAMPLES["en-US"]!;
  const line = (id: string, sku: string, name: string, attributes: Record<string, string>, quantity: number, unitPrice: number) => ({
    id,
    productId: null,
    variantId: null,
    sku,
    name,
    variantAttributes: attributes,
    quantity,
    quantityFulfilled: 0,
    unitPrice,
    total: unitPrice * quantity,
    weightGrams: 300,
    isShippable: true,
  });
  const lines = [line("sample-line-1", "TEE-BLACK-M", "Organic cotton tee", { color: "Black", size: "M" }, 2, 2500), line("sample-line-2", "TOTE-NATURAL", "Canvas tote", {}, 1, 1800)];
  const subtotal = lines.reduce((sum, l) => sum + l.total, 0);
  const discountTotal = 680;
  const shippingTotal = 599;
  const taxed = subtotal - discountTotal + shippingTotal;
  const taxTotal = sample.pricesIncludeTax ? Math.round(taxed / 6) : Math.round((subtotal - discountTotal) * 0.0725);
  return {
    id: "00000000-0000-7000-8000-000000000000",
    number: "100123",
    channelId: "",
    customerId: null,
    email: "customer@example.com",
    locale,
    currency: sample.currency,
    status: "open",
    paymentStatus: "authorized",
    fulfillmentStatus: "unfulfilled",
    subtotal,
    discountTotal,
    shippingTotal,
    taxTotal,
    grandTotal: sample.pricesIncludeTax ? taxed : taxed + taxTotal,
    pricesIncludeTax: sample.pricesIncludeTax,
    shippingAddress: sample.address,
    billingAddress: sample.address,
    shippingMethod: { code: "standard", name: sample.shippingName, carrier: sample.carrier, amount: shippingTotal },
    paymentMethodCode: "card",
    lines,
    fulfillments: [
      { id: "sample-fulfillment", number: "FUL-000123", tracking: [{ carrier: sample.carrier, number: sample.trackingNumber }], lines: lines.map((l) => ({ orderLineId: l.id, quantity: l.quantity })), createdAt: new Date() },
    ],
    couponCodes: [],
    metadata: {},
    createdAt: new Date(),
  };
};

export const SAMPLE_LOW_STOCK: LowStockItem = { sku: "TEE-BLACK-M", name: "Organic cotton tee", quantity: 3, location: "Main warehouse" };
