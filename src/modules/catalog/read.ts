import { and, asc, desc, eq, gt, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import {
  attributeDefinitions,
  categories,
  categoryMerchandising,
  categoryTranslations,
  productCategories,
  productChannelListings,
  productMedia,
  productTranslations,
  productTypes,
  products,
  productVariants,
  redirects,
} from "./tables.ts";

export type AttributeDefinition = typeof attributeDefinitions.$inferSelect;
export type ProductType = typeof productTypes.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductTranslation = typeof productTranslations.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type ProductMedia = typeof productMedia.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type CategoryTranslation = typeof categoryTranslations.$inferSelect;
export type ProductChannelListing = typeof productChannelListings.$inferSelect;

const group = <T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
};

export const listAttributeDefinitions = (db: Database) =>
  db.query.attributeDefinitions.findMany({ orderBy: [asc(attributeDefinitions.position), asc(attributeDefinitions.code)] });

export const listProductTypes = (db: Database) => db.query.productTypes.findMany({ orderBy: asc(productTypes.code) });

export const getProductTypesByIds = (db: Database, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(productTypes).where(inArray(productTypes.id, [...ids]));

export const getProductsByIds = (db: Database, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(products).where(inArray(products.id, [...ids]));

export const getTranslationsByProductIds = async (db: Database, ids: readonly string[]) =>
  group(ids.length === 0 ? [] : await db.select().from(productTranslations).where(inArray(productTranslations.productId, [...ids])), (t) => t.productId);

export const findProductIdBySlug = async (db: Database, locale: string, slug: string): Promise<string | null> => {
  const rows = await db
    .select({ productId: productTranslations.productId, locale: productTranslations.locale })
    .from(productTranslations)
    .where(eq(productTranslations.slug, slug));
  return (rows.find((r) => r.locale === locale) ?? rows.find((r) => r.locale.split("-")[0] === locale.split("-")[0]) ?? rows[0])?.productId ?? null;
};

export const getVariantsByProductIds = async (db: Database, ids: readonly string[]) =>
  group(
    ids.length === 0
      ? []
      : await db.select().from(productVariants).where(inArray(productVariants.productId, [...ids])).orderBy(asc(productVariants.position), asc(productVariants.sku)),
    (v) => v.productId,
  );

export const getVariantsByIds = (db: Database, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(productVariants).where(inArray(productVariants.id, [...ids]));

export const getVariantsBySkus = (db: Database, skus: readonly string[]) =>
  skus.length === 0 ? Promise.resolve([]) : db.select().from(productVariants).where(inArray(productVariants.sku, [...skus]));

export const getMediaByProductIds = async (db: Database, ids: readonly string[]) =>
  group(
    ids.length === 0 ? [] : await db.select().from(productMedia).where(inArray(productMedia.productId, [...ids])).orderBy(asc(productMedia.position)),
    (m) => m.productId,
  );

export const getCategoryIdsByProductIds = async (db: Database, ids: readonly string[]) => {
  const rows = ids.length === 0 ? [] : await db.select().from(productCategories).where(inArray(productCategories.productId, [...ids])).orderBy(asc(productCategories.position));
  return new Map([...group(rows, (r) => r.productId)].map(([k, v]) => [k, v.map((r) => r.categoryId)]));
};

/** Where category listings pin or hide each product, for the search projection. */
export const getMerchandisingByProductIds = async (db: Database, ids: readonly string[]) => {
  const rows = ids.length === 0 ? [] : await db.select().from(categoryMerchandising).where(inArray(categoryMerchandising.productId, [...ids]));
  return new Map(
    [...group(rows, (r) => r.productId)].map(([productId, placements]) => [
      productId,
      {
        pinPositions: Object.fromEntries(placements.filter((p) => p.pinPosition !== null).map((p) => [p.categoryId, p.pinPosition!])),
        hiddenInCategoryIds: placements.filter((p) => p.hidden).map((p) => p.categoryId),
      },
    ]),
  );
};

export const getListingsByProductIds = async (db: Database, ids: readonly string[]) =>
  group(ids.length === 0 ? [] : await db.select().from(productChannelListings).where(inArray(productChannelListings.productId, [...ids])), (l) => l.productId);

/**
 * Keyset-paged after `afterId`, oldest first, for the plugins' catalog service. Unlike storefront
 * search, includes products hidden from listings.
 */
export const listProductIdsSoldIn = async (db: Database, channelId: string, page: { limit: number; afterId?: string | null }) => {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .innerJoin(
      productChannelListings,
      and(eq(productChannelListings.productId, products.id), eq(productChannelListings.channelId, channelId), eq(productChannelListings.isPublished, true)),
    )
    .where(and(eq(products.status, "active"), page.afterId ? gt(products.id, page.afterId) : undefined))
    .orderBy(asc(products.id))
    .limit(page.limit);
  return rows.map((r) => r.id);
};

type ProductListFilter = { query?: string | null; status?: string | null; productTypeId?: string | null; categoryId?: string | null };

/** Admin listing with keyset pagination on the time-ordered id (newest first). */
export const listProducts = async (db: Database, filter: ProductListFilter, page: { limit: number; afterId?: string | null }) => {
  const where = productListConditions(filter);
  const total = await db.$count(products, where.length ? and(...where) : undefined);
  if (page.afterId) where.push(lt(products.id, page.afterId));
  const rows = await db
    .select()
    .from(products)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(products.id))
    .limit(page.limit);
  return { rows, total };
};

export type ProductListSort = { field: "NAME" | "PRICE" | "NEWEST"; direction: "ASC" | "DESC"; locale: string; currency: string };

/**
 * Admin listing with offset pagination, by name in a locale, lowest base price in a currency
 * (unpriced last) or age. Ties go newest first.
 */
export const listProductsSorted = async (db: Database, filter: ProductListFilter, sort: ProductListSort, page: { limit: number; offset: number }) => {
  const where = productListConditions(filter);
  const key =
    sort.field === "NAME"
      ? sql`lower(coalesce(
          (select t.name from product_translations t where t.product_id = ${products.id} and t.locale = ${sort.locale}),
          (select t.name from product_translations t where t.product_id = ${products.id} order by t.locale limit 1)))`
      : sort.field === "PRICE"
        ? sql`(select min(p.amount) from variant_prices p join product_variants v on v.id = p.variant_id
            where v.product_id = ${products.id} and p.currency = ${sort.currency}
              and p.customer_group_id is null and p.min_quantity = 1 and p.starts_at is null and p.ends_at is null)`
        : sql`${products.id}`;
  const rows = await db
    .select()
    .from(products)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sort.direction === "DESC" ? sql`${key} desc nulls last` : sql`${key} asc nulls last`, desc(products.id))
    .limit(page.limit)
    .offset(page.offset);
  return { rows, total: await db.$count(products, where.length ? and(...where) : undefined) };
};

const productListConditions = (filter: ProductListFilter) => {
  const where: SQL[] = [];
  if (filter.status) where.push(eq(products.status, filter.status as Product["status"]));
  if (filter.productTypeId) where.push(eq(products.productTypeId, filter.productTypeId));
  if (filter.categoryId) {
    where.push(sql`${products.id} in (select product_id from product_categories where category_id = ${filter.categoryId})`);
  }
  if (filter.query) {
    const pattern = `%${filter.query.replace(/[%_]/g, "\\$&")}%`;
    where.push(
      or(
        sql`${products.id} in (select product_id from product_translations where name ilike ${pattern})`,
        sql`${products.id} in (select product_id from product_variants where sku ilike ${pattern})`,
      )!,
    );
  }
  return where;
};

// ---------------------------------------------------------------- categories

export const getCategoriesByIds = (db: Database, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(categories).where(inArray(categories.id, [...ids]));

export const getCategoryTranslations = async (db: Database, ids: readonly string[]) =>
  group(ids.length === 0 ? [] : await db.select().from(categoryTranslations).where(inArray(categoryTranslations.categoryId, [...ids])), (t) => t.categoryId);

export const listCategories = (db: Database, opts: { parentId?: string | null; activeOnly?: boolean; maxDepth?: number } = {}) => {
  const where: SQL[] = [];
  if (opts.parentId !== undefined) where.push(opts.parentId === null ? sql`${categories.parentId} is null` : eq(categories.parentId, opts.parentId));
  if (opts.activeOnly) where.push(eq(categories.isActive, true));
  if (opts.maxDepth !== undefined) where.push(sql`${categories.depth} <= ${opts.maxDepth}`);
  return db.select().from(categories).where(where.length ? and(...where) : undefined).orderBy(asc(categories.depth), asc(categories.position), asc(categories.id));
};

export const getDescendantCategoryIds = async (db: Database, category: Category) =>
  (await db.select({ id: categories.id }).from(categories).where(like(categories.path, `${category.path}%`))).map((r) => r.id);

export const ancestorIdsFromPath = (path: string) => path.split("/").filter(Boolean);

export const findCategoryIdBySlug = async (db: Database, locale: string, slug: string): Promise<string | null> => {
  const rows = await db
    .select({ categoryId: categoryTranslations.categoryId, locale: categoryTranslations.locale })
    .from(categoryTranslations)
    .where(eq(categoryTranslations.slug, slug));
  return (rows.find((r) => r.locale === locale) ?? rows.find((r) => r.locale.split("-")[0] === locale.split("-")[0]) ?? rows[0])?.categoryId ?? null;
};

export const findRedirect = (db: Database, path: string) => db.query.redirects.findFirst({ where: eq(redirects.fromPath, path) });
