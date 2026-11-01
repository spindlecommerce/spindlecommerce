import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { queryRows } from "../../db/query.ts";
import { textSearchConfig } from "./language.ts";
import { productSearch } from "./tables.ts";

/**
 * Default directions: newest and most relevant first, names A–Z, cheapest first. FEATURED ignores
 * direction: a category's pinned products first, in order, then newest first.
 */
export type ProductSort = { field: "RELEVANCE" | "NAME" | "PRICE" | "NEWEST" | "FEATURED"; direction?: "ASC" | "DESC" | null };

export type ProductSearchInput = {
  channelId: string;
  locale: string;
  currency: string;
  query?: string | null;
  filter?: {
    categoryId?: string | null;
    productIds?: string[] | null;
    attributes?: { code: string; values: string[] }[] | null;
    price?: { min?: number | null; max?: number | null } | null;
    inStock?: boolean | null;
  } | null;
  sort?: ProductSort | null;
  offset: number;
  limit: number;
  /** Attribute codes to count. Disjunctive: a selected value does not hide its siblings. */
  facetCodes?: string[];
};

export type SearchFacet = { code: string; values: { value: string; count: number }[] };

export type ProductSearchResult = {
  productIds: string[];
  totalCount: number;
  facets: SearchFacet[];
  priceRange: { min: number; max: number } | null;
};

/** "trail run" → `trail:* & run:*`, so partial words match while typing. */
export const prefixQuery = (query: string): string | null => {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return tokens && tokens.length > 0 ? tokens.slice(0, 12).map((t) => `${t}:*`).join(" & ") : null;
};

type Clause = { key: string; sql: SQL };

const buildClauses = (input: ProductSearchInput, tsquery: SQL | null): Clause[] => {
  const ps = productSearch;
  const clauses: Clause[] = [
    { key: "scope", sql: and(eq(ps.channelId, input.channelId), eq(ps.locale, input.locale))! },
  ];
  const f = input.filter ?? {};
  if (!f.productIds) clauses.push({ key: "visibility", sql: eq(ps.visibleInListings, true) });
  if (tsquery) clauses.push({ key: "query", sql: sql`${ps.document} @@ ${tsquery}` });
  if (f.categoryId) {
    clauses.push({ key: "category", sql: sql`${ps.categoryIds} @> array[${f.categoryId}]::uuid[]` });
    // Hidden products stay out of the category's listing in every sort.
    clauses.push({ key: "hidden", sql: sql`not (${ps.hiddenInCategoryIds} @> array[${f.categoryId}]::uuid[])` });
  }
  if (f.productIds) clauses.push({ key: "ids", sql: f.productIds.length ? sql`${ps.productId} in (${sql.join(f.productIds.map((id) => sql`${id}`), sql`, `)})` : sql`false` });
  if (f.inStock) clauses.push({ key: "stock", sql: eq(ps.inStock, true) });
  const price = sql`(${ps.prices} -> ${input.currency} ->> 'min')::bigint`;
  if (f.price?.min != null) clauses.push({ key: "price", sql: sql`${price} >= ${f.price.min}` });
  if (f.price?.max != null) clauses.push({ key: "price", sql: sql`${price} <= ${f.price.max}` });
  for (const attribute of f.attributes ?? []) {
    if (attribute.values.length === 0) continue;
    clauses.push({
      key: `attr:${attribute.code}`,
      sql: sql`(${ps.facets} -> ${attribute.code}) ?| array[${sql.join(attribute.values.map((v) => sql`${v}`), sql`, `)}]::text[]`,
    });
  }
  return clauses;
};

const whereOf = (clauses: Clause[], exclude?: (key: string) => boolean) => and(...clauses.filter((c) => !exclude?.(c.key)).map((c) => c.sql));

export const searchProducts = async (db: Database, input: ProductSearchInput): Promise<ProductSearchResult> => {
  const ps = productSearch;
  const config = textSearchConfig(input.locale);
  const prefix = input.query ? prefixQuery(input.query) : null;
  const tsquery = prefix ? sql`to_tsquery(${config}::regconfig, ${prefix})` : null;
  const clauses = buildClauses(input, tsquery);
  const where = whereOf(clauses);
  const minPrice = sql`(${ps.prices} -> ${input.currency} ->> 'min')::bigint`;

  const categoryId = input.filter?.categoryId ?? null;
  const sort = input.sort ?? { field: tsquery ? "RELEVANCE" : categoryId ? "FEATURED" : "NEWEST" };
  const direction = sort.field === "FEATURED" ? "DESC" : (sort.direction ?? (sort.field === "NEWEST" || sort.field === "RELEVANCE" ? "DESC" : "ASC"));
  const dir = direction === "ASC" ? sql`asc` : sql`desc`;
  const orderBy =
    sort.field === "RELEVANCE" && tsquery ? sql`ts_rank_cd(${ps.document}, ${tsquery}) desc, ${ps.name} asc`
    : sort.field === "NAME" ? sql`${ps.name} ${dir}, ${ps.productId} asc`
    : sort.field === "PRICE" ? sql`${minPrice} ${dir} nulls last, ${ps.productId} asc`
    : sort.field === "FEATURED" && categoryId ? sql`(${ps.pinPositions} ->> ${categoryId})::int asc nulls last, ${ps.productCreatedAt} desc, ${ps.productId} desc`
    : sql`${ps.productCreatedAt} ${dir}, ${ps.productId} desc`;

  const [page, count, priceRange] = await Promise.all([
    queryRows<{ product_id: string }>(db, sql`select ${ps.productId} as product_id from ${ps} where ${where} order by ${orderBy} limit ${input.limit} offset ${input.offset}`),
    queryRows<{ n: number }>(db, sql`select count(*)::int as n from ${ps} where ${where}`),
    queryRows<{ min: string | null; max: string | null }>(
      db,
      sql`select min((${ps.prices} -> ${input.currency} ->> 'min')::bigint) as min, max((${ps.prices} -> ${input.currency} ->> 'max')::bigint) as max
          from ${ps} where ${whereOf(clauses, (k) => k === "price")}`,
    ),
  ]);

  const facets: SearchFacet[] = [];
  const codes = input.facetCodes ?? [];
  if (codes.length > 0) {
    const active = new Set((input.filter?.attributes ?? []).filter((a) => a.values.length > 0).map((a) => a.code));
    const passive = codes.filter((c) => !active.has(c));
    const facetQuery = (codesToCount: string[], exclude?: string) =>
      queryRows<{ code: string; value: string; count: number }>(db, sql`
        select f.key as code, v.value as value, count(*)::int as count
        from ${ps}
        cross join lateral jsonb_each(${ps.facets}) as f(key, vals)
        cross join lateral jsonb_array_elements_text(f.vals) as v(value)
        where ${whereOf(clauses, exclude ? (k) => k === `attr:${exclude}` : undefined)}
          and f.key in (${sql.join(codesToCount.map((c) => sql`${c}`), sql`, `)})
        group by f.key, v.value
        order by count desc, v.value asc`);
    const results = await Promise.all([
      ...(passive.length ? [facetQuery(passive)] : []),
      ...[...active].filter((c) => codes.includes(c)).map((c) => facetQuery([c], c)),
    ]);
    const byCode = new Map<string, SearchFacet>();
    for (const row of results.flat()) {
      const facet = byCode.get(row.code) ?? { code: row.code, values: [] };
      facet.values.push({ value: row.value, count: Number(row.count) });
      byCode.set(row.code, facet);
    }
    for (const c of codes) if (byCode.has(c)) facets.push(byCode.get(c)!);
  }

  const range = priceRange[0];
  return {
    productIds: page.map((r) => r.product_id),
    totalCount: Number(count[0]?.n ?? 0),
    facets,
    priceRange: range?.min != null && range.max != null ? { min: Number(range.min), max: Number(range.max) } : null,
  };
};
