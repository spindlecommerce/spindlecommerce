import { inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { queryRows } from "../../db/query.ts";
import { pickLocalized } from "../../lib/i18n.ts";
import type { AttributeValue } from "../catalog/tables.ts";
import { pickTranslation } from "../catalog/view.ts";
import {
  ancestorIdsFromPath,
  getCategoriesByIds,
  getCategoryIdsByProductIds,
  getListingsByProductIds,
  getMerchandisingByProductIds,
  getProductsByIds,
  getTranslationsByProductIds,
  getVariantsByProductIds,
  listAttributeDefinitions,
} from "../catalog/read.ts";
import { channels } from "../channels/tables.ts";
import { getSalableQuantities, isAvailable } from "../inventory/stock.ts";
import { resolveVariantPrices } from "../pricing/resolve.ts";
import { textSearchConfig } from "./language.ts";
import { productSearch } from "./tables.ts";

const stripHtml = (value: string | null | undefined) => (value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const facetValues = (value: AttributeValue | undefined): string[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "object") return [];
  return [String(value)];
};

const searchableText = (value: AttributeValue | undefined, locale: string): string => {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(" ");
  if (typeof value === "object") return pickLocalized(value, locale) ?? "";
  return String(value);
};

/** Run in the caller's transaction by every write that changes what shoppers can find. */
export const reindexProducts = async (db: Database, productIds: readonly string[]): Promise<void> => {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  // Sequential: the writing transaction takes one query at a time.
  const productRows = await getProductsByIds(db, ids);
  const translations = await getTranslationsByProductIds(db, ids);
  const variantsByProduct = await getVariantsByProductIds(db, ids);
  const listings = await getListingsByProductIds(db, ids);
  const categoryIdsByProduct = await getCategoryIdsByProductIds(db, ids);
  const merchandising = await getMerchandisingByProductIds(db, ids);
  const definitions = await listAttributeDefinitions(db);
  const channelRows = await db.select().from(channels);
  const assignedCategoryIds = [...new Set([...categoryIdsByProduct.values()].flat())];
  const categoryPaths = new Map((await getCategoriesByIds(db, assignedCategoryIds)).map((c) => [c.id, c]));
  const filterable = definitions.filter((d) => d.isFilterable);
  const searchable = definitions.filter((d) => d.isSearchable);
  const allVariantIds = [...variantsByProduct.values()].flat().filter((v) => v.isActive).map((v) => v.id);

  await db.delete(productSearch).where(inArray(productSearch.productId, ids));
  const rows: (typeof productSearch.$inferInsert)[] = [];

  for (const channel of channelRows) {
    const channelProducts = productRows.filter((p) => p.status === "active" && listings.get(p.id)?.some((l) => l.channelId === channel.id && l.isPublished));
    if (channelProducts.length === 0) continue;
    const salable = await getSalableQuantities(db, channel.stockId, allVariantIds);
    const pricesByCurrency = new Map<string, Awaited<ReturnType<typeof resolveVariantPrices>>>();
    for (const currency of channel.currencies) {
      pricesByCurrency.set(
        currency,
        await resolveVariantPrices(db, allVariantIds, { channelId: channel.id, currency, defaultCurrency: channel.defaultCurrency, customerGroupId: null, at: new Date() }),
      );
    }
    for (const product of channelProducts) {
      const listing = listings.get(product.id)!.find((l) => l.channelId === channel.id)!;
      const variants = (variantsByProduct.get(product.id) ?? []).filter((v) => v.isActive);
      const categoryIds = new Set<string>();
      for (const categoryId of categoryIdsByProduct.get(product.id) ?? []) {
        const category = categoryPaths.get(categoryId);
        if (category) for (const ancestor of ancestorIdsFromPath(category.path)) categoryIds.add(ancestor);
      }
      const facets: Record<string, string[]> = {};
      for (const def of filterable) {
        const values = new Set([...facetValues(product.attributes[def.code]), ...variants.flatMap((v) => facetValues(v.attributes[def.code]))]);
        if (values.size > 0) facets[def.code] = [...values];
      }
      const prices: Record<string, { min: number; max: number }> = {};
      for (const [currency, resolved] of pricesByCurrency) {
        const amounts = variants.map((v) => resolved.get(v.id)?.amount).filter((a): a is number => a !== undefined);
        if (amounts.length > 0) prices[currency] = { min: Math.min(...amounts), max: Math.max(...amounts) };
      }
      const inStock = variants.some((v) => isAvailable(v, salable.get(v.id) ?? 0));

      for (const locale of channel.locales) {
        const translation = pickTranslation(translations.get(product.id) ?? [], { locale, fallbackLocale: channel.defaultLocale });
        if (!translation) continue;
        const config = textSearchConfig(locale);
        const weightB = [
          ...variants.map((v) => v.sku),
          ...searchable.map((d) => searchableText(product.attributes[d.code], locale)),
          ...variants.flatMap((v) => searchable.map((d) => searchableText(v.attributes[d.code], locale))),
          ...searchable
            .flatMap((d) => d.options.filter((o) => facets[d.code]?.includes(o.code)).map((o) => pickLocalized(o.label, locale) ?? o.code)),
        ].join(" ");
        rows.push({
          productId: product.id,
          channelId: channel.id,
          locale,
          name: translation.name,
          slug: translation.slug,
          document: sql`setweight(to_tsvector(${config}::regconfig, ${translation.name}), 'A') || setweight(to_tsvector(${config}::regconfig, ${weightB}), 'B') || setweight(to_tsvector(${config}::regconfig, ${stripHtml(translation.description)}), 'C')` as unknown as string,
          facets,
          categoryIds: [...categoryIds],
          pinPositions: merchandising.get(product.id)?.pinPositions ?? {},
          hiddenInCategoryIds: merchandising.get(product.id)?.hiddenInCategoryIds ?? [],
          prices,
          inStock,
          visibleInListings: listing.visibleInListings,
          productCreatedAt: product.createdAt,
        });
      }
    }
  }
  if (rows.length > 0) await db.insert(productSearch).values(rows);
};

export const reindexAllProducts = async (db: Database, batchSize = 200): Promise<number> => {
  const ids = (await queryRows<{ id: string }>(db, sql`select id from products order by id`)).map((r) => r.id);
  for (let i = 0; i < ids.length; i += batchSize) await reindexProducts(db, ids.slice(i, i + batchSize));
  return ids.length;
};
