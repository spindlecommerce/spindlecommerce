/** Shopper-facing catalog views, shared so the storefront API, search and plugins agree. */
import { pickLocalized, type LocalizedText } from "../../lib/i18n.ts";
import { isAvailable, type StockPolicy } from "../inventory/stock.ts";
import type { AttributeDefinition, Product, ProductVariant } from "./read.ts";
import type { AttributeOption, AttributeValue } from "./tables.ts";

/** The locale texts are shown in, and the channel's default locale to fall back to. */
export type ViewLocale = { locale: string; fallbackLocale: string };

export const localizedText = (text: LocalizedText | null | undefined, view: ViewLocale) => pickLocalized(text, view.locale, view.fallbackLocale);

/** Exact locale, then the same language, then the fallback locale, then any. */
export const pickTranslation = <T extends { locale: string }>(rows: readonly T[], view: ViewLocale): T | null =>
  rows.find((t) => t.locale === view.locale) ??
  rows.find((t) => t.locale.split("-")[0] === view.locale.split("-")[0]) ??
  rows.find((t) => t.locale === view.fallbackLocale) ??
  rows[0] ??
  null;

export const isSoldIn = (product: Pick<Product, "status">, listings: readonly { channelId: string; isPublished: boolean }[], channelId: string) =>
  product.status === "active" && listings.some((l) => l.channelId === channelId && l.isPublished);

/** An attribute value for display, e.g. "Organic cotton" or "Blue, Green". */
export const formatAttributeValue = (def: AttributeDefinition, raw: AttributeValue, view: ViewLocale): string => {
  const option = (code: string) => def.options.find((o) => o.code === code);
  if (def.type === "select") return localizedText(option(String(raw))?.label, view) ?? String(raw);
  if (def.type === "multiselect" && Array.isArray(raw)) return raw.map((c) => localizedText(option(c)?.label, view) ?? c).join(", ");
  if (def.isLocalized && typeof raw === "object" && !Array.isArray(raw)) return localizedText(raw, view) ?? "";
  if (def.type === "number") return `${raw}${def.unit ? ` ${def.unit}` : ""}`;
  return String(raw);
};

/** The product type's product-level attributes that have a value, in the type's order. */
export const productAttributes = (product: Pick<Product, "attributes">, attributeCodes: readonly string[], defs: ReadonlyMap<string, AttributeDefinition>) =>
  attributeCodes.flatMap((code) => {
    const def = defs.get(code);
    const raw = product.attributes[code];
    return def && raw !== undefined && raw !== null ? [{ def, raw }] : [];
  });

/** A variant's value on each of the product type's variant attributes, e.g. Size: M. */
export const variantOptions = (
  variant: Pick<ProductVariant, "attributes">,
  variantAttributeCodes: readonly string[],
  defs: ReadonlyMap<string, AttributeDefinition>,
  view: ViewLocale,
) =>
  variantAttributeCodes.flatMap((code) => {
    const def = defs.get(code);
    const value = variant.attributes[code];
    if (!def || typeof value !== "string") return [];
    const option = def.options.find((o) => o.code === value);
    return [{ attribute: code, name: localizedText(def.label, view) ?? code, value, label: localizedText(option?.label, view) ?? value, swatch: option?.swatch ?? null }];
  });

/** The product name with the variant's option labels, e.g. "Oxford Shirt – Blue / M". */
export const variantName = (productName: string, options: readonly { label: string }[]) =>
  options.length ? `${productName} – ${options.map((o) => o.label).join(" / ")}` : productName;

/** Each variant attribute with the options that exist among the variants. */
export const productOptions = (
  variantAttributeCodes: readonly string[],
  defs: ReadonlyMap<string, AttributeDefinition>,
  variants: readonly Pick<ProductVariant, "attributes">[],
): { def: AttributeDefinition; values: AttributeOption[] }[] =>
  variantAttributeCodes.flatMap((code) => {
    const def = defs.get(code);
    if (!def) return [];
    const used = new Set(variants.map((v) => v.attributes[code]));
    return [{ def, values: def.options.filter((o) => used.has(o.code)) }];
  });

/** Min and max price and the lowest compare-at price, in minor units; null without prices. */
export const priceRange = (prices: readonly { amount: number; compareAtAmount: number | null; currency: string }[]) => {
  if (prices.length === 0) return null;
  const amounts = prices.map((p) => p.amount);
  const compare = prices.map((p) => p.compareAtAmount).filter((x): x is number => x !== null);
  return { min: Math.min(...amounts), max: Math.max(...amounts), compareAtMin: compare.length ? Math.min(...compare) : null, currency: prices[0]!.currency };
};

/** Whether a variant can be bought now, given its salable quantity in the channel's stock. */
export const isVariantAvailable = (variant: StockPolicy & { isActive: boolean }, salable: number) => variant.isActive && isAvailable(variant, salable);
