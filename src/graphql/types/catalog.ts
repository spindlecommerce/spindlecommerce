import { toGlobalId } from "../../lib/ids.ts";
import { eq } from "drizzle-orm";
import type { LocalizedText } from "../../lib/i18n.ts";
import { fromDecimalString } from "../../lib/money.ts";
import {
  ancestorIdsFromPath,
  findCategoryIdBySlug,
  findProductIdBySlug,
  findRedirect,
  getVariantsBySkus,
  listCategories,
  listProducts,
  listProductsSorted,
  type AttributeDefinition,
  type Category,
  type Product,
  type ProductVariant,
} from "../../modules/catalog/read.ts";
import type { AttributeOption, AttributeValue } from "../../modules/catalog/tables.ts";
import {
  formatAttributeValue,
  isSoldIn,
  isVariantAvailable,
  localizedText,
  pickTranslation,
  priceRange,
  productAttributes,
  productOptions,
  variantName,
  variantOptions,
  type ViewLocale,
} from "../../modules/catalog/view.ts";
import { findPageByPath } from "../../modules/builder/pages.ts";
import { searchProducts, type SearchFacet } from "../../modules/search/service.ts";
import { taxClasses } from "../../modules/tax/tables.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { keysetConnection, offsetConnection, offsetPage, type ConnectionArgs } from "../pagination.ts";
import {
  AttributeDefinitionRef,
  CategoryRef,
  ChannelRef,
  MediaRef,
  PageRef,
  ProductRef,
  ProductTypeRef,
  ProductVariantRef,
  StockLevelRef,
  MoneyRef,
  TaxClassRef,
  type MoneyShape,
} from "../refs.ts";
import { isPageView, servedInChannel, viewFor } from "./builder-views.ts";
import { LocalizedStringRef, money, SelectedOptionInput, SelectedOptionRef, toLocalizedList } from "./common.ts";

// ---------------------------------------------------------------- helpers

/** The request's locale, falling back to its channel's default (src/modules/catalog/view.ts). */
const viewOf = (ctx: GraphQLContext): ViewLocale => ({ locale: ctx.scope.locale, fallbackLocale: ctx.scope.channel.defaultLocale });

const localized = (ctx: GraphQLContext, text: LocalizedText | null | undefined) => localizedText(text, viewOf(ctx));

const productTranslation = async (ctx: GraphQLContext, productId: string) => pickTranslation(await ctx.loaders.productTranslations.load(productId), viewOf(ctx));
const categoryTranslation = async (ctx: GraphQLContext, categoryId: string) => pickTranslation(await ctx.loaders.categoryTranslations.load(categoryId), viewOf(ctx));

/** Storefront callers only see active products published in their channel. */
export const isProductVisible = async (ctx: GraphQLContext, product: Product | null): Promise<boolean> => {
  if (!product) return false;
  if (ctx.api === "admin") return true;
  return isSoldIn(product, await ctx.loaders.productListings.load(product.id), ctx.scope.channel.id);
};

const visibleVariants = async (ctx: GraphQLContext, productId: string) =>
  (await ctx.loaders.productVariants.load(productId)).filter((v) => ctx.api === "admin" || v.isActive);

const isCategoryVisible = (ctx: GraphQLContext, category: Category | null) => !!category && (ctx.api === "admin" || category.isActive);

const notErrors = <T>(values: (T | Error | null)[]): T[] => values.filter((v): v is T => v !== null && !(v instanceof Error));

// ---------------------------------------------------------------- enums

export const AttributeTypeEnum = builder.enumType("AttributeType", {
  values: { TEXT: { value: "text" }, RICH_TEXT: { value: "rich_text" }, NUMBER: { value: "number" }, BOOLEAN: { value: "boolean" }, SELECT: { value: "select" }, MULTISELECT: { value: "multiselect" }, DATE: { value: "date" } } as const,
});
export const ProductStatusEnum = builder.enumType("ProductStatus", {
  subGraphs: ADMIN,
  values: { DRAFT: { value: "draft" }, ACTIVE: { value: "active" }, ARCHIVED: { value: "archived" } } as const,
});
export const MediaKindEnum = builder.enumType("MediaKind", { values: { IMAGE: { value: "image" }, VIDEO: { value: "video" } } as const });

// ---------------------------------------------------------------- attributes

export const AttributeOptionRef = builder.objectRef<AttributeOption>("AttributeOption").implement({
  fields: (t) => ({
    code: t.exposeString("code"),
    label: t.string({ resolve: (o, _a, ctx) => localized(ctx, o.label) ?? o.code }),
    swatch: t.exposeString("swatch", { nullable: true }),
    labels: t.field({ subGraphs: ADMIN, type: [LocalizedStringRef], resolve: (o) => toLocalizedList(o.label) }),
  }),
});

builder.node(AttributeDefinitionRef, {
  id: { resolve: (d) => d.id },
  loadMany: async (ids, ctx) => {
    const defs = [...(await ctx.loaders.attributeDefinitions()).values()];
    return ids.map((id) => defs.find((d) => d.id === id) ?? null);
  },
  fields: (t) => ({
    code: t.exposeString("code"),
    label: t.string({ resolve: (d, _a, ctx) => localized(ctx, d.label) ?? d.code }),
    type: t.field({ type: AttributeTypeEnum, resolve: (d) => d.type }),
    isLocalized: t.exposeBoolean("isLocalized"),
    isFilterable: t.exposeBoolean("isFilterable"),
    isSearchable: t.exposeBoolean("isSearchable"),
    isRequired: t.exposeBoolean("isRequired"),
    unit: t.exposeString("unit", { nullable: true }),
    position: t.exposeInt("position"),
    options: t.field({ type: [AttributeOptionRef], resolve: (d) => d.options }),
    labels: t.field({ subGraphs: ADMIN, type: [LocalizedStringRef], resolve: (d) => toLocalizedList(d.label) }),
  }),
});

type ProductAttributeShape = { def: AttributeDefinition; raw: AttributeValue };
const ProductAttributeRef = builder.objectRef<ProductAttributeShape>("ProductAttribute").implement({
  description: "A typed attribute value, already formatted for the request locale.",
  fields: (t) => ({
    attribute: t.field({ type: AttributeDefinitionRef, resolve: (a) => a.def }),
    value: t.string({ description: "Display value, e.g. \"Organic cotton\" or \"Blue, Green\".", resolve: (a, _x, ctx) => formatAttributeValue(a.def, a.raw, viewOf(ctx)) }),
    options: t.field({
      type: [AttributeOptionRef],
      description: "Selected options for select and multiselect attributes.",
      resolve: (a) => {
        const codes = Array.isArray(a.raw) ? a.raw : typeof a.raw === "string" ? [a.raw] : [];
        return a.def.options.filter((o) => codes.includes(o.code));
      },
    }),
    raw: t.field({ type: "JSON", resolve: (a) => a.raw }),
  }),
});

type ProductOptionShape = { def: AttributeDefinition; values: AttributeOption[] };
const ProductOptionRef = builder.objectRef<ProductOptionShape>("ProductOption").implement({
  description: "A variant axis (e.g. Size) with the values that exist among the product's variants.",
  fields: (t) => ({
    attribute: t.field({ type: AttributeDefinitionRef, resolve: (o) => o.def }),
    values: t.field({ type: [AttributeOptionRef], resolve: (o) => o.values }),
  }),
});

const selectedOptions = async (ctx: GraphQLContext, variant: ProductVariant) => {
  const product = await ctx.loaders.product.load(variant.productId);
  const type = product && (await ctx.loaders.productType.load(product.productTypeId));
  return variantOptions(variant, type?.variantAttributeCodes ?? [], await ctx.loaders.attributeDefinitions(), viewOf(ctx));
};

// ---------------------------------------------------------------- product types, media, prices

builder.node(ProductTypeRef, {
  subGraphs: ADMIN,
  id: { resolve: (p) => p.id },
  loadMany: async (ids, ctx) => (await ctx.loaders.productType.loadMany(ids)).map((r) => (r instanceof Error ? null : r)),
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    isShippable: t.exposeBoolean("isShippable"),
    attributes: t.field({
      type: [AttributeDefinitionRef],
      resolve: async (p, _a, ctx) => {
        const defs = await ctx.loaders.attributeDefinitions();
        return p.attributeCodes.map((c) => defs.get(c)).filter((d): d is AttributeDefinition => !!d);
      },
    }),
    variantAttributes: t.field({
      type: [AttributeDefinitionRef],
      resolve: async (p, _a, ctx) => {
        const defs = await ctx.loaders.attributeDefinitions();
        return p.variantAttributeCodes.map((c) => defs.get(c)).filter((d): d is AttributeDefinition => !!d);
      },
    }),
    taxClass: t.field({ type: TaxClassRef, nullable: true, resolve: (p, _a, ctx) => (p.taxClassId ? ctx.db.query.taxClasses.findFirst({ where: eq(taxClasses.id, p.taxClassId) }).then((r) => r ?? null) : null) }),
  }),
});

builder.node(MediaRef, {
  id: { resolve: (m) => m.id },
  loadMany: async (ids, ctx) => {
    const rows = await ctx.db.query.productMedia.findMany({ where: (m, { inArray }) => inArray(m.id, ids) });
    const visible = new Map(
      await Promise.all([...new Set(rows.map((r) => r.productId))].map(async (productId) => [productId, await isProductVisible(ctx, await ctx.loaders.product.load(productId))] as const)),
    );
    return ids.map((id) => rows.find((r) => r.id === id && visible.get(r.productId)) ?? null);
  },
  fields: (t) => ({
    url: t.exposeString("url"),
    alt: t.string({ nullable: true, resolve: (m, _a, ctx) => localized(ctx, m.alt) }),
    kind: t.field({ type: MediaKindEnum, resolve: (m) => m.kind }),
    position: t.exposeInt("position"),
    variant: t.field({ type: ProductVariantRef, nullable: true, resolve: (m, _a, ctx) => (m.variantId ? ctx.loaders.variant.load(m.variantId) : null) }),
  }),
});

const PriceRangeRef = builder.objectRef<{ minimum: MoneyShape; maximum: MoneyShape }>("PriceRange").implement({
  fields: (t) => ({ minimum: t.field({ type: MoneyRef, resolve: (r) => r.minimum }), maximum: t.field({ type: MoneyRef, resolve: (r) => r.maximum }) }),
});

const ProductPriceRangeRef = builder.objectRef<{ min: MoneyShape; max: MoneyShape; compareAtMin: MoneyShape | null }>("ProductPriceRange").implement({
  description: "Prices for the request's channel, currency and customer group.",
  fields: (t) => ({
    minVariantPrice: t.field({ type: MoneyRef, resolve: (r) => r.min }),
    maxVariantPrice: t.field({ type: MoneyRef, resolve: (r) => r.max }),
    compareAtMinVariantPrice: t.field({ type: MoneyRef, nullable: true, resolve: (r) => r.compareAtMin }),
  }),
});

const TierPriceRef = builder.objectRef<{ minQuantity: number; price: MoneyShape }>("TierPrice").implement({
  fields: (t) => ({ minQuantity: t.exposeInt("minQuantity"), price: t.field({ type: MoneyRef, resolve: (p) => p.price }) }),
});

type PriceRowShape = Awaited<ReturnType<GraphQLContext["loaders"]["priceRows"]["load"]>>[number];
const VariantPriceRef = builder.objectRef<PriceRowShape>("VariantPrice").implement({
  subGraphs: ADMIN,
  description: "A stored price point: list, special (dated), tier (minQuantity) or customer-group price.",
  fields: (t) => ({
    id: t.exposeID("id"),
    channel: t.field({ type: ChannelRef, resolve: (p, _a, ctx) => ctx.db.query.channels.findFirst({ where: (c, { eq: e }) => e(c.id, p.channelId) }).then((c) => c!) }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (p) => p.currency }),
    amount: t.field({ type: MoneyRef, resolve: (p) => money(p.amount, p.currency) }),
    compareAtAmount: t.field({ type: MoneyRef, nullable: true, resolve: (p) => (p.compareAtAmount === null ? null : money(p.compareAtAmount, p.currency)) }),
    costAmount: t.field({ type: MoneyRef, nullable: true, resolve: (p) => (p.costAmount === null ? null : money(p.costAmount, p.currency)) }),
    customerGroupId: t.id({ nullable: true, resolve: (p) => (p.customerGroupId ? toGlobalId("CustomerGroup", p.customerGroupId) : null) }),
    minQuantity: t.exposeInt("minQuantity"),
    startsAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.startsAt }),
    endsAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.endsAt }),
  }),
});

// ---------------------------------------------------------------- variants

builder.node(ProductVariantRef, {
  id: { resolve: (v) => v.id },
  loadMany: async (ids, ctx) => {
    const variants = notErrors(await ctx.loaders.variant.loadMany(ids));
    const visible = await Promise.all(variants.map(async (v) => (ctx.api === "admin" || v.isActive) && (await isProductVisible(ctx, await ctx.loaders.product.load(v.productId)))));
    return ids.map((id) => {
      const index = variants.findIndex((v) => v.id === id);
      return index >= 0 && visible[index] ? variants[index]! : null;
    });
  },
  fields: (t) => ({
    sku: t.exposeString("sku"),
    product: t.field({ type: ProductRef, resolve: async (v, _a, ctx) => (await ctx.loaders.product.load(v.productId))! }),
    name: t.string({ description: "Product name with the variant's options, e.g. \"Oxford Shirt – Blue / M\".", resolve: async (v, _a, ctx) =>
      variantName((await productTranslation(ctx, v.productId))?.name ?? v.sku, await selectedOptions(ctx, v)),
    }),
    selectedOptions: t.field({ type: [SelectedOptionRef], resolve: (v, _a, ctx) => selectedOptions(ctx, v) }),
    price: t.field({ type: MoneyRef, nullable: true, resolve: async (v, _a, ctx) => {
      const p = await ctx.loaders.price.load(v.id);
      return p ? money(p.amount, p.currency) : null;
    } }),
    compareAtPrice: t.field({ type: MoneyRef, nullable: true, resolve: async (v, _a, ctx) => {
      const p = await ctx.loaders.price.load(v.id);
      return p?.compareAtAmount != null ? money(p.compareAtAmount, p.currency) : null;
    } }),
    tierPrices: t.field({ type: [TierPriceRef], resolve: async (v, _a, ctx) => {
      const p = await ctx.loaders.price.load(v.id);
      return (p?.tierPrices ?? []).map((tier) => ({ minQuantity: tier.minQuantity, price: money(tier.amount, p!.currency) }));
    } }),
    isAvailable: t.boolean({ resolve: async (v, _a, ctx) => isVariantAvailable(v, await ctx.loaders.salable.load(v.id)) }),
    quantityAvailable: t.int({
      nullable: true,
      description: "Salable quantity in the channel's stock; null when the variant does not track inventory.",
      resolve: async (v, _a, ctx) => (v.trackInventory ? Math.max(0, await ctx.loaders.salable.load(v.id)) : null),
    }),
    weightGrams: t.exposeInt("weightGrams", { nullable: true }),
    media: t.field({ type: [MediaRef], resolve: async (v, _a, ctx) => (await ctx.loaders.productMedia.load(v.productId)).filter((m) => m.variantId === v.id) }),
    barcode: t.exposeString("barcode", { nullable: true, subGraphs: ADMIN }),
    isActive: t.exposeBoolean("isActive", { subGraphs: ADMIN }),
    trackInventory: t.exposeBoolean("trackInventory", { subGraphs: ADMIN }),
    allowBackorder: t.exposeBoolean("allowBackorder", { subGraphs: ADMIN }),
    position: t.exposeInt("position", { subGraphs: ADMIN }),
    prices: t.field({ subGraphs: ADMIN, type: [VariantPriceRef], resolve: (v, _a, ctx) => ctx.loaders.priceRows.load(v.id) }),
    stockLevels: t.field({ subGraphs: ADMIN, type: [StockLevelRef], resolve: (v, _a, ctx) => ctx.loaders.stockLevels.load(v.id) }),
  }),
});

// ---------------------------------------------------------------- products

const SeoRef = builder.objectRef<{ title: string | null; description: string | null }>("Seo").implement({
  fields: (t) => ({ title: t.exposeString("title", { nullable: true }), description: t.exposeString("description", { nullable: true }) }),
});

const ProductTranslationRef = builder.objectRef<{ locale: string; name: string; slug: string; description: string | null; metaTitle: string | null; metaDescription: string | null }>("ProductTranslation").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    locale: t.field({ type: "LocaleCode", resolve: (x) => x.locale }),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    description: t.exposeString("description", { nullable: true }),
    metaTitle: t.exposeString("metaTitle", { nullable: true }),
    metaDescription: t.exposeString("metaDescription", { nullable: true }),
  }),
});

const ProductChannelListingRef = builder.objectRef<{ channelId: string; isPublished: boolean; visibleInListings: boolean; publishedAt: Date | null }>("ProductChannelListing").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    channel: t.field({ type: ChannelRef, resolve: (l, _a, ctx) => ctx.db.query.channels.findFirst({ where: (c, { eq: e }) => e(c.id, l.channelId) }).then((c) => c!) }),
    isPublished: t.exposeBoolean("isPublished"),
    visibleInListings: t.exposeBoolean("visibleInListings"),
    publishedAt: t.field({ type: "DateTime", nullable: true, resolve: (l) => l.publishedAt }),
  }),
});

builder.node(ProductRef, {
  id: { resolve: (p) => p.id },
  loadMany: async (ids, ctx) => {
    const rows = await ctx.loaders.product.loadMany(ids);
    return Promise.all(rows.map(async (r) => (r instanceof Error || !(await isProductVisible(ctx, r)) ? null : r)));
  },
  fields: (t) => ({
    name: t.string({ resolve: async (p, _a, ctx) => (await productTranslation(ctx, p.id))?.name ?? "" }),
    slug: t.string({ resolve: async (p, _a, ctx) => (await productTranslation(ctx, p.id))?.slug ?? p.id }),
    description: t.string({ nullable: true, description: "HTML.", resolve: async (p, _a, ctx) => (await productTranslation(ctx, p.id))?.description ?? null }),
    seo: t.field({ type: SeoRef, resolve: async (p, _a, ctx) => {
      const tr = await productTranslation(ctx, p.id);
      return { title: tr?.metaTitle ?? tr?.name ?? null, description: tr?.metaDescription ?? null };
    } }),
    attributes: t.field({
      type: [ProductAttributeRef],
      description: "Product-level attributes (variant axes are under `options`).",
      resolve: async (p, _a, ctx) => {
        const [defs, type] = await Promise.all([ctx.loaders.attributeDefinitions(), ctx.loaders.productType.load(p.productTypeId)]);
        return productAttributes(p, type?.attributeCodes ?? [], defs);
      },
    }),
    options: t.field({
      type: [ProductOptionRef],
      resolve: async (p, _a, ctx) => {
        const [defs, type, variants] = await Promise.all([ctx.loaders.attributeDefinitions(), ctx.loaders.productType.load(p.productTypeId), visibleVariants(ctx, p.id)]);
        return productOptions(type?.variantAttributeCodes ?? [], defs, variants);
      },
    }),
    variants: t.field({ type: [ProductVariantRef], complexity: { field: 1, multiplier: 10 }, resolve: (p, _a, ctx) => visibleVariants(ctx, p.id) }),
    variant: t.field({
      type: ProductVariantRef,
      nullable: true,
      description: "The variant matching every selected option, e.g. color=blue and size=m.",
      args: { selectedOptions: t.arg({ type: [SelectedOptionInput], required: true }) },
      resolve: async (p, { selectedOptions: wanted }, ctx) =>
        (await visibleVariants(ctx, p.id)).find((v) => wanted.every((o) => v.attributes[o.attribute] === o.value)) ?? null,
    }),
    media: t.field({ type: [MediaRef], resolve: (p, _a, ctx) => ctx.loaders.productMedia.load(p.id) }),
    categories: t.field({
      type: [CategoryRef],
      resolve: async (p, _a, ctx) => notErrors(await ctx.loaders.category.loadMany(await ctx.loaders.productCategoryIds.load(p.id))).filter((c) => isCategoryVisible(ctx, c)),
    }),
    priceRange: t.field({
      type: ProductPriceRangeRef,
      nullable: true,
      resolve: async (p, _a, ctx) => {
        const variants = (await visibleVariants(ctx, p.id)).filter((v) => v.isActive);
        const range = priceRange(notErrors(await ctx.loaders.price.loadMany(variants.map((v) => v.id))));
        if (!range) return null;
        return { min: money(range.min, range.currency), max: money(range.max, range.currency), compareAtMin: range.compareAtMin === null ? null : money(range.compareAtMin, range.currency) };
      },
    }),
    isAvailable: t.boolean({
      description: "Whether any variant can be bought now.",
      resolve: async (p, _a, ctx) => {
        const variants = (await visibleVariants(ctx, p.id)).filter((v) => v.isActive);
        const salable = await ctx.loaders.salable.loadMany(variants.map((v) => v.id));
        return variants.some((v, i) => isVariantAvailable(v, typeof salable[i] === "number" ? (salable[i] as number) : 0));
      },
    }),
    createdAt: t.field({ type: "DateTime", resolve: (p) => p.createdAt }),
    updatedAt: t.field({ type: "DateTime", subGraphs: ADMIN, resolve: (p) => p.updatedAt }),
    status: t.field({ type: ProductStatusEnum, subGraphs: ADMIN, resolve: (p) => p.status }),
    productType: t.field({ type: ProductTypeRef, subGraphs: ADMIN, resolve: async (p, _a, ctx) => (await ctx.loaders.productType.load(p.productTypeId))! }),
    translations: t.field({ type: [ProductTranslationRef], subGraphs: ADMIN, resolve: (p, _a, ctx) => ctx.loaders.productTranslations.load(p.id) }),
    channelListings: t.field({ type: [ProductChannelListingRef], subGraphs: ADMIN, resolve: (p, _a, ctx) => ctx.loaders.productListings.load(p.id) }),
    attributeValues: t.field({ type: "JSON", subGraphs: ADMIN, description: "Raw attribute values keyed by code.", resolve: (p) => p.attributes }),
  }),
});

// ---------------------------------------------------------------- search connection

const FacetValueRef = builder.objectRef<{ value: string; count: number; label: string; swatch: string | null; selected: boolean }>("FacetValue").implement({
  fields: (t) => ({
    value: t.exposeString("value", { description: "Pass this in `filter.attributes` to select it." }),
    label: t.exposeString("label"),
    swatch: t.exposeString("swatch", { nullable: true }),
    count: t.exposeInt("count", { description: "Products matching if this value were (also) selected." }),
    selected: t.exposeBoolean("selected"),
  }),
});

const FacetRef = builder.objectRef<{ def: AttributeDefinition; values: { value: string; count: number; label: string; swatch: string | null; selected: boolean }[] }>("Facet").implement({
  fields: (t) => ({
    attribute: t.field({ type: AttributeDefinitionRef, resolve: (f) => f.def }),
    values: t.field({ type: [FacetValueRef], resolve: (f) => f.values }),
  }),
});

type SearchExtras = { facets: { def: AttributeDefinition; values: { value: string; count: number; label: string; swatch: string | null; selected: boolean }[] }[]; priceRange: { minimum: MoneyShape; maximum: MoneyShape } | null };

export const ProductConnection = builder.connectionObject(
  {
    type: ProductRef,
    name: "ProductConnection",
    fields: (t) => ({
      facets: t.field({
        type: [FacetRef],
        description: "Counts per filterable attribute value. Disjunctive: selecting a value keeps its siblings' counts.",
        resolve: (c) => (c as unknown as SearchExtras).facets,
      }),
      priceRange: t.field({
        type: PriceRangeRef,
        nullable: true,
        description: "Price span of all matches, ignoring the price filter (for range sliders).",
        resolve: (c) => (c as unknown as SearchExtras).priceRange,
      }),
    }),
  },
  { name: "ProductEdge" },
);

const ProductSortField = builder.enumType("ProductSortField", {
  values: {
    RELEVANCE: { value: "RELEVANCE" },
    NAME: { value: "NAME" },
    PRICE: { value: "PRICE" },
    NEWEST: { value: "NEWEST" },
    FEATURED: {
      value: "FEATURED",
      description: "A category's merchandised listing: its pinned products in order, then the rest newest first. Elsewhere, newest first. Storefront only.",
    },
  } as const,
});
export const SortDirection = builder.enumType("SortDirection", { values: ["ASC", "DESC"] as const });

const ProductSortInput = builder.inputType("ProductSortInput", {
  fields: (t) => ({
    field: t.field({ type: ProductSortField, required: true }),
    direction: t.field({ type: SortDirection, description: "Defaults to DESC for NEWEST and RELEVANCE (newest, best match first) and ASC for NAME and PRICE. FEATURED ignores it." }),
  }),
});
const AttributeFilterInput = builder.inputType("AttributeFilterInput", {
  fields: (t) => ({ code: t.string({ required: true }), values: t.stringList({ required: true }) }),
});
const PriceFilterInput = builder.inputType("PriceFilterInput", {
  description: "Inclusive bounds in the request currency.",
  fields: (t) => ({ min: t.field({ type: "Decimal" }), max: t.field({ type: "Decimal" }) }),
});
export const ProductFilterInput = builder.inputType("ProductFilter", {
  fields: (t) => ({
    categoryId: t.globalID({ for: [CategoryRef], description: "Includes products in descendant categories." }),
    attributes: t.field({ type: [AttributeFilterInput], description: "Values within one attribute are ORed; attributes are ANDed." }),
    price: t.field({ type: PriceFilterInput }),
    inStock: t.boolean(),
    ids: t.globalIDList({ for: [ProductRef] }),
    status: t.field({ type: ProductStatusEnum, subGraphs: ADMIN }),
    productTypeId: t.globalID({ for: [ProductTypeRef], subGraphs: ADMIN }),
  }),
});

type ProductsArgs = ConnectionArgs & {
  query?: string | null;
  filter?: {
    categoryId?: { id: string } | null;
    attributes?: { code: string; values: string[] }[] | null;
    price?: { min?: string | null; max?: string | null } | null;
    inStock?: boolean | null;
    ids?: { id: string }[] | null;
    status?: Product["status"] | null;
    productTypeId?: { id: string } | null;
  } | null;
  sort?: { field: "RELEVANCE" | "NAME" | "PRICE" | "NEWEST" | "FEATURED"; direction?: "ASC" | "DESC" | null } | null;
};

export const resolveProducts = async (ctx: GraphQLContext, args: ProductsArgs, categoryId?: string) => {
  const filter = args.filter ?? {};
  const category = categoryId ?? (filter.categoryId ? rawId(filter.categoryId) : null);
  if (ctx.api === "admin") {
    const listFilter = { query: args.query, status: filter.status, productTypeId: filter.productTypeId ? rawId(filter.productTypeId) : null, categoryId: category };
    const sort = args.sort;
    // Name, price and oldest-first page by offset; the default, newest first, by id.
    if (sort && (sort.field === "NAME" || sort.field === "PRICE" || (sort.field === "NEWEST" && sort.direction === "ASC"))) {
      const page = offsetPage(args);
      const direction = sort.direction ?? "ASC";
      const { rows, total } = await listProductsSorted(ctx.db, listFilter, { field: sort.field, direction, locale: ctx.scope.locale, currency: ctx.scope.currency }, page);
      return { ...offsetConnection(page, rows, total), facets: [], priceRange: null };
    }
    const connection = await keysetConnection(args, (page) => listProducts(ctx.db, listFilter, page));
    return { ...connection, facets: [], priceRange: null };
  }
  const page = offsetPage(args);
  const defs = await ctx.loaders.attributeDefinitions();
  const currency = ctx.scope.currency;
  const result = await searchProducts(ctx.db, {
    channelId: ctx.scope.channel.id,
    locale: ctx.scope.locale,
    currency,
    query: args.query,
    filter: {
      categoryId: category,
      productIds: filter.ids ? filter.ids.map(rawId) : null,
      attributes: filter.attributes,
      price: filter.price ? { min: filter.price.min ? fromDecimalString(filter.price.min, currency) : null, max: filter.price.max ? fromDecimalString(filter.price.max, currency) : null } : null,
      inStock: filter.inStock,
    },
    sort: args.sort ? { field: args.sort.field, direction: args.sort.direction ?? null } : null,
    offset: page.offset,
    limit: page.limit,
    facetCodes: [...defs.values()].filter((d) => d.isFilterable).map((d) => d.code),
  });
  const products = notErrors(await ctx.loaders.product.loadMany(result.productIds));
  const selected = new Map((filter.attributes ?? []).map((a) => [a.code, new Set(a.values)]));
  const facets = result.facets.flatMap((f: SearchFacet) => {
    const def = defs.get(f.code);
    if (!def) return [];
    return [{
      def,
      values: f.values.map((v) => {
        const option = def.options.find((o) => o.code === v.value);
        return { value: v.value, count: v.count, label: option ? (localized(ctx, option.label) ?? v.value) : v.value, swatch: option?.swatch ?? null, selected: selected.get(f.code)?.has(v.value) ?? false };
      }),
    }];
  });
  return {
    ...offsetConnection(page, products, result.totalCount),
    facets,
    priceRange: result.priceRange ? { minimum: money(result.priceRange.min, currency), maximum: money(result.priceRange.max, currency) } : null,
  };
};

const QUERY_ARG_DESCRIPTION = "Full-text search with prefix matching, e.g. \"trail run\".";
const SORT_ARG_DESCRIPTION = "Defaults to RELEVANCE with a query, then to FEATURED in a category's listing, otherwise NEWEST.";

// ---------------------------------------------------------------- categories

const CategoryTranslationRef = builder.objectRef<{ locale: string; name: string; slug: string; description: string | null }>("CategoryTranslation").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    locale: t.field({ type: "LocaleCode", resolve: (x) => x.locale }),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    description: t.exposeString("description", { nullable: true }),
  }),
});

builder.node(CategoryRef, {
  id: { resolve: (c) => c.id },
  loadMany: async (ids, ctx) => (await ctx.loaders.category.loadMany(ids)).map((c) => (c instanceof Error || !isCategoryVisible(ctx, c) ? null : c)),
  fields: (t) => ({
    name: t.string({ resolve: async (c, _a, ctx) => (await categoryTranslation(ctx, c.id))?.name ?? "" }),
    slug: t.string({ resolve: async (c, _a, ctx) => (await categoryTranslation(ctx, c.id))?.slug ?? c.id }),
    path: t.string({
      description: "Slugs from the root, e.g. \"men/mens-shirts\".",
      resolve: async (c, _a, ctx) => {
        const ancestors = ancestorIdsFromPath(c.path);
        return (await Promise.all(ancestors.map(async (id) => (await categoryTranslation(ctx, id))?.slug ?? id))).join("/");
      },
    }),
    description: t.string({ nullable: true, resolve: async (c, _a, ctx) => (await categoryTranslation(ctx, c.id))?.description ?? null }),
    depth: t.exposeInt("depth"),
    position: t.exposeInt("position"),
    parent: t.field({ type: CategoryRef, nullable: true, resolve: async (c, _a, ctx) => (c.parentId ? ctx.loaders.category.load(c.parentId) : null) }),
    ancestors: t.field({
      type: [CategoryRef],
      description: "Root first, for breadcrumbs. Excludes this category.",
      resolve: async (c, _a, ctx) => notErrors(await ctx.loaders.category.loadMany(ancestorIdsFromPath(c.path).slice(0, -1))),
    }),
    children: t.field({ type: [CategoryRef], resolve: async (c, _a, ctx) => (await ctx.loaders.categoryChildren.load(c.id)).filter((x) => isCategoryVisible(ctx, x)) }),
    products: t.connection(
      {
        type: ProductRef,
        args: {
          query: t.arg.string({ description: QUERY_ARG_DESCRIPTION }),
          filter: t.arg({ type: ProductFilterInput }),
          sort: t.arg({ type: ProductSortInput, description: SORT_ARG_DESCRIPTION }),
        },
        complexity: (args) => ({ field: 5, multiplier: Math.min(args.first ?? 20, 100) }),
        resolve: (c, args, ctx) => resolveProducts(ctx, args as ProductsArgs, c.id),
      },
      ProductConnection,
    ),
    isActive: t.exposeBoolean("isActive", { subGraphs: ADMIN }),
    translations: t.field({ type: [CategoryTranslationRef], subGraphs: ADMIN, resolve: (c, _a, ctx) => ctx.loaders.categoryTranslations.load(c.id) }),
  }),
});

// ---------------------------------------------------------------- routing

type RedirectShape = { kind: "redirect"; location: string; statusCode: number };
const RedirectRef = builder.objectRef<RedirectShape>("Redirect").implement({
  description: "The path moved; send the shopper to `location`.",
  fields: (t) => ({ location: t.exposeString("location"), statusCode: t.exposeInt("statusCode") }),
});

const RouteResult = builder.unionType("RouteResult", {
  types: [PageRef, ProductRef, CategoryRef, RedirectRef],
  resolveType: (value) => {
    if ("kind" in value && value.kind === "redirect") return RedirectRef;
    if (isPageView(value)) return PageRef;
    return "productTypeId" in value ? ProductRef : CategoryRef;
  },
});

// ---------------------------------------------------------------- queries

builder.queryFields((t) => ({
  products: t.connection(
    {
      type: ProductRef,
      description: "Storefront: full-text search with facets over the channel's published catalog. Admin: every product, newest first, or by name or lowest base price with `sort`.",
      args: {
        query: t.arg.string({ description: QUERY_ARG_DESCRIPTION }),
        filter: t.arg({ type: ProductFilterInput }),
        sort: t.arg({ type: ProductSortInput, description: SORT_ARG_DESCRIPTION }),
      },
      complexity: (args) => ({ field: 5, multiplier: Math.min(args.first ?? 20, 100) }),
      authScopes: (_p, _a, ctx) => (ctx.api === "admin" ? { permission: "catalog:read" } : true),
      resolve: (_root, args, ctx) => resolveProducts(ctx, args as ProductsArgs),
    },
    ProductConnection,
  ),
  product: t.field({
    type: ProductRef,
    nullable: true,
    description: "Look up a product by exactly one of id, slug (in the request locale) or a variant SKU.",
    args: { id: t.arg.globalID({ for: [ProductRef] }), slug: t.arg.string(), sku: t.arg.string() },
    authScopes: (_p, _a, ctx) => (ctx.api === "admin" ? { permission: "catalog:read" } : true),
    resolve: async (_root, args, ctx) => {
      let id: string | null = args.id ? rawId(args.id) : null;
      if (!id && args.slug) id = await findProductIdBySlug(ctx.db, ctx.scope.locale, args.slug);
      if (!id && args.sku) id = (await getVariantsBySkus(ctx.db, [args.sku]))[0]?.productId ?? null;
      if (!id) return null;
      const product = await ctx.loaders.product.load(id);
      return (await isProductVisible(ctx, product)) ? product : null;
    },
  }),
  categoryTree: t.field({
    type: [CategoryRef],
    description: "Root categories; walk `children` for the tree.",
    resolve: async (_root, _args, ctx) => (await listCategories(ctx.db, { parentId: null, activeOnly: ctx.api !== "admin" })).sort((a, b) => a.position - b.position),
  }),
  category: t.field({
    type: CategoryRef,
    nullable: true,
    args: { id: t.arg.globalID({ for: [CategoryRef] }), slug: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const id = args.id ? rawId(args.id) : args.slug ? await findCategoryIdBySlug(ctx.db, ctx.scope.locale, args.slug) : null;
      const category = id ? await ctx.loaders.category.load(id) : null;
      return isCategoryVisible(ctx, category) ? category : null;
    },
  }),
  route: t.field({
    type: RouteResult,
    nullable: true,
    description:
      "What a storefront path serves: a builder page at exactly that path; a product at /products/<slug> or a category at /categories/<slug path>, redirecting when a slug moved or the parents differ; otherwise a product or category by the last segment, else a redirect.",
    args: { path: t.arg.string({ required: true }) },
    resolve: async (_root, { path }, ctx) => {
      const normalized = `/${path.split("?")[0]!.replace(/^\/+|\/+$/g, "")}`;
      const built = await findPageByPath(ctx.db, normalized.toLowerCase(), { preview: ctx.api === "admin" || !!ctx.preview });
      if (built && servedInChannel(ctx, built)) {
        const view = viewFor(ctx, built);
        if (view) return view;
      }
      const redirectTo = (location: string, statusCode = 301) => ({ kind: "redirect" as const, location, statusCode });
      const productBySlug = async (slug: string) => {
        const productId = await findProductIdBySlug(ctx.db, ctx.scope.locale, slug);
        const product = productId ? await ctx.loaders.product.load(productId) : null;
        return product && (await isProductVisible(ctx, product)) ? product : null;
      };
      const categoryBySlug = async (slug: string) => {
        const categoryId = await findCategoryIdBySlug(ctx.db, ctx.scope.locale, slug);
        const category = categoryId ? await ctx.loaders.category.load(categoryId) : null;
        return category && isCategoryVisible(ctx, category) ? category : null;
      };
      const exact = await findRedirect(ctx.db, normalized);
      const segments = normalized.split("/").filter(Boolean);

      // Canonical URLs: /products/<slug> is only ever a product and /categories/<slug path> only a
      // category. Renamed slugs (recorded as /<old> → /<new>) redirect within the same prefix.
      if (segments[0] === "products" && segments.length === 2) {
        const product = await productBySlug(segments[1]!);
        if (product) return product;
        const moved = exact ?? (await findRedirect(ctx.db, `/${segments[1]}`));
        return moved ? redirectTo(moved.toPath.startsWith("/products/") || exact ? moved.toPath : `/products${moved.toPath}`, moved.statusCode) : null;
      }
      if (segments[0] === "categories" && segments.length >= 2) {
        let category = await categoryBySlug(segments.at(-1)!);
        if (!category && !exact) {
          const moved = await findRedirect(ctx.db, `/${segments.at(-1)}`);
          category = moved ? await categoryBySlug(moved.toPath.replace(/^\//, "")) : null;
        }
        if (category) {
          const canonical = await categorySlugPath(ctx, category);
          return canonical === segments.slice(1).join("/") ? category : redirectTo(`/categories/${canonical}`);
        }
        return exact ? redirectTo(exact.toPath, exact.statusCode) : null;
      }

      const slug = segments.at(-1) ?? "";
      if (slug) {
        const product = await productBySlug(slug);
        if (product) return product;
        const category = await categoryBySlug(slug);
        if (category) return category;
      }
      const redirect = exact ?? (slug ? await findRedirect(ctx.db, `/${slug}`) : undefined);
      return redirect ? redirectTo(redirect.toPath, redirect.statusCode) : null;
    },
  }),
  attributeDefinitions: t.field({
    type: [AttributeDefinitionRef],
    description: "All attribute definitions, e.g. to render filters.",
    resolve: async (_root, _args, ctx) => [...(await ctx.loaders.attributeDefinitions()).values()].sort((a, b) => a.position - b.position),
  }),
}));

/** A category's slugs from the root in the request locale, e.g. "men/mens-shirts". */
const categorySlugPath = async (ctx: GraphQLContext, category: Category) =>
  (await Promise.all(ancestorIdsFromPath(category.path).map(async (id) => (await categoryTranslation(ctx, id))?.slug ?? id))).join("/");

export { productTranslation, categoryTranslation, categorySlugPath, isCategoryVisible, notErrors, localized };
