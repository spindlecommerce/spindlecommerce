import { InvalidStateError } from "../../lib/errors.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { getVariantsByIds, listProductTypes } from "../../modules/catalog/read.ts";
import {
  bulkDeleteProducts,
  bulkUpdateProducts,
  createAttributeDefinition,
  createCategory,
  createProduct,
  createProductType,
  createRedirect,
  createVariant,
  deleteAttributeDefinition,
  deleteCategory,
  deleteProduct,
  deleteProductType,
  deleteRedirect,
  deleteVariant,
  duplicateProduct,
  listCategoriesFlat,
  listRedirects,
  moveCategory,
  searchVariants,
  updateAttributeDefinition,
  updateCategory,
  updateProduct,
  updateProductType,
  updateVariant,
} from "../../modules/catalog/service.ts";
import { getCategoryMerchandising, MAX_PINNED_PRODUCTS, setCategoryMerchandising, type MerchandisingItem } from "../../modules/catalog/merchandising.ts";
import { products, type redirects } from "../../modules/catalog/tables.ts";
import { eq } from "drizzle-orm";
import { setVariantPrices } from "../../modules/pricing/service.ts";
import { hasPermission } from "../../modules/staff/service.ts";
import { reindexAllProducts } from "../../modules/search/projector.ts";
import { ADMIN, builder, connectionComplexity, rawId } from "../builder.ts";
import { offsetConnection, offsetPage } from "../pagination.ts";
import { AttributeDefinitionRef, CategoryRef, ChannelRef, CustomerGroupRef, MediaRef, ProductRef, ProductTypeRef, ProductVariantRef, StockLocationRef, TaxClassRef } from "../refs.ts";
import { AttributeTypeEnum, MediaKindEnum, ProductStatusEnum } from "./catalog.ts";
import { DeletePayload, fromLocalizedList, LocalizedStringInput, LocalizedStringRef, SelectedOptionInput, toLocalizedList } from "./common.ts";

// ---------------------------------------------------------------- shared inputs

type LocalizedList = { locale: string; value: string }[];

const AttributeValueData = builder.inputType("AttributeValueData", {
  subGraphs: ADMIN,
  isOneOf: true,
  description: "A value matching the attribute's type. Exactly one field; `clear: true` removes the value.",
  fields: (t) => ({
    text: t.string(),
    localizedText: t.field({ type: [LocalizedStringInput] }),
    number: t.float(),
    boolean: t.boolean(),
    option: t.string({ description: "Option code for select attributes." }),
    options: t.stringList({ description: "Option codes for multiselect attributes." }),
    date: t.string({ description: "YYYY-MM-DD." }),
    clear: t.boolean(),
  }),
});
const AttributeValueInput = builder.inputType("AttributeValueInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ code: t.string({ required: true }), value: t.field({ type: AttributeValueData, required: true }) }),
});

type AttributeValueArgs = { code: string; value: { text?: string | null; localizedText?: LocalizedList | null; number?: number | null; boolean?: boolean | null; option?: string | null; options?: string[] | null; date?: string | null; clear?: boolean | null } };

const toAttributes = (list: AttributeValueArgs[] | null | undefined): Record<string, unknown> | undefined => {
  if (!list) return undefined;
  return Object.fromEntries(
    list.map(({ code, value: v }) => [
      code,
      v.clear ? null : v.localizedText ? fromLocalizedList(v.localizedText) : (v.text ?? v.number ?? v.boolean ?? v.option ?? v.options ?? v.date ?? null),
    ]),
  );
};

const VariantPriceInput = builder.inputType("VariantPriceInput", {
  subGraphs: ADMIN,
  description: "List price (no group, minQuantity 1, no dates), special price (dates), tier price (minQuantity) or group price.",
  fields: (t) => ({
    channelId: t.globalID({ for: [ChannelRef], required: true }),
    currencyCode: t.field({ type: "CurrencyCode", required: true }),
    amount: t.field({ type: "Decimal", required: true }),
    compareAtAmount: t.field({ type: "Decimal" }),
    costAmount: t.field({ type: "Decimal" }),
    customerGroupId: t.globalID({ for: [CustomerGroupRef] }),
    minQuantity: t.int(),
    startsAt: t.field({ type: "DateTime" }),
    endsAt: t.field({ type: "DateTime" }),
  }),
});
type VariantPriceArgs = { channelId: { id: string }; currencyCode: string; amount: string; compareAtAmount?: string | null; costAmount?: string | null; customerGroupId?: { id: string } | null; minQuantity?: number | null; startsAt?: Date | null; endsAt?: Date | null };
const toPrices = (list: VariantPriceArgs[] | null | undefined) =>
  list?.map((p) => ({
    channelId: rawId(p.channelId),
    currency: p.currencyCode,
    amount: p.amount,
    compareAtAmount: p.compareAtAmount ?? null,
    costAmount: p.costAmount ?? null,
    customerGroupId: p.customerGroupId ? rawId(p.customerGroupId) : null,
    minQuantity: p.minQuantity ?? 1,
    startsAt: p.startsAt ?? null,
    endsAt: p.endsAt ?? null,
  }));

const StockLevelInput = builder.inputType("StockLevelInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ locationId: t.globalID({ for: [StockLocationRef], required: true }), quantity: t.int({ required: true }) }),
});

const ProductVariantInput = builder.inputType("ProductVariantInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    sku: t.string({ required: true }),
    options: t.field({ type: [SelectedOptionInput], description: "Values for the product type's variant axes, e.g. color=blue, size=m." }),
    weightGrams: t.int(),
    barcode: t.string(),
    isActive: t.boolean(),
    trackInventory: t.boolean(),
    allowBackorder: t.boolean(),
    position: t.int(),
    prices: t.field({ type: [VariantPriceInput] }),
    stock: t.field({ type: [StockLevelInput] }),
  }),
});
const ProductVariantUpdateInput = builder.inputType("ProductVariantUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    sku: t.string(),
    options: t.field({ type: [SelectedOptionInput] }),
    weightGrams: t.int(),
    barcode: t.string(),
    isActive: t.boolean(),
    trackInventory: t.boolean(),
    allowBackorder: t.boolean(),
    position: t.int(),
    prices: t.field({ type: [VariantPriceInput], description: "Replaces every price point of the variant." }),
    stock: t.field({ type: [StockLevelInput], description: "Sets on-hand quantity per location." }),
  }),
});

type VariantArgs = {
  sku?: string | null; options?: { attribute: string; value: string }[] | null; weightGrams?: number | null; barcode?: string | null; isActive?: boolean | null;
  trackInventory?: boolean | null; allowBackorder?: boolean | null; position?: number | null; prices?: VariantPriceArgs[] | null; stock?: { locationId: { id: string }; quantity: number }[] | null;
};
const toVariant = (v: VariantArgs) =>
  Object.fromEntries(
    Object.entries({
      sku: v.sku,
      attributes: v.options ? Object.fromEntries(v.options.map((o) => [o.attribute, o.value])) : undefined,
      weightGrams: v.weightGrams,
      barcode: v.barcode,
      isActive: v.isActive,
      trackInventory: v.trackInventory,
      allowBackorder: v.allowBackorder,
      position: v.position,
      prices: toPrices(v.prices),
      stock: v.stock?.map((s) => ({ locationId: rawId(s.locationId), quantity: s.quantity })),
    }).filter(([, value]) => value !== undefined && value !== null),
  );

const ProductTranslationInput = builder.inputType("ProductTranslationInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    locale: t.field({ type: "LocaleCode", required: true }),
    name: t.string({ required: true }),
    slug: t.string({ description: "Generated from the name when omitted; made unique per locale." }),
    description: t.string({ description: "HTML." }),
    metaTitle: t.string(),
    metaDescription: t.string(),
  }),
});
const ProductMediaInput = builder.inputType("ProductMediaInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ url: t.string({ required: true }), alt: t.field({ type: [LocalizedStringInput] }), kind: t.field({ type: MediaKindEnum }), variantSku: t.string(), position: t.int() }),
});
const ProductChannelListingInput = builder.inputType("ProductChannelListingInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ channelId: t.globalID({ for: [ChannelRef], required: true }), isPublished: t.boolean(), visibleInListings: t.boolean() }),
});

const ProductCreateInput = builder.inputType("ProductCreateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    productTypeId: t.globalID({ for: [ProductTypeRef], required: true }),
    status: t.field({ type: ProductStatusEnum }),
    translations: t.field({ type: [ProductTranslationInput], required: true }),
    attributes: t.field({ type: [AttributeValueInput] }),
    taxClassId: t.globalID({ for: [TaxClassRef], description: "Overrides the product type's tax class; omit to follow the type." }),
    categoryIds: t.globalIDList({ for: [CategoryRef] }),
    channelListings: t.field({ type: [ProductChannelListingInput] }),
    variants: t.field({ type: [ProductVariantInput], required: true }),
    media: t.field({ type: [ProductMediaInput] }),
  }),
});
const ProductUpdateInput = builder.inputType("ProductUpdateInput", {
  subGraphs: ADMIN,
  description: "Lists (translations by locale aside) replace what is stored. Changing a slug records a redirect from the old URL.",
  fields: (t) => ({
    status: t.field({ type: ProductStatusEnum }),
    translations: t.field({ type: [ProductTranslationInput], description: "Upserted per locale." }),
    attributes: t.field({ type: [AttributeValueInput], description: "Merged; use clear to remove one." }),
    taxClassId: t.globalID({ for: [TaxClassRef], description: "Null removes the product's override, so its product type's tax class applies." }),
    categoryIds: t.globalIDList({ for: [CategoryRef] }),
    channelListings: t.field({ type: [ProductChannelListingInput] }),
    media: t.field({ type: [ProductMediaInput] }),
    removeTranslations: t.field({
      type: ["LocaleCode"],
      description: "Locales whose translation (name, slug, description and meta fields) to delete; at least one must remain. Localized attribute values and alt text are kept.",
    }),
  }),
});

type ProductArgs = {
  removeTranslations?: string[] | null;
  productTypeId?: { id: string };
  status?: "draft" | "active" | "archived" | null;
  translations?: { locale: string; name: string; slug?: string | null; description?: string | null; metaTitle?: string | null; metaDescription?: string | null }[] | null;
  attributes?: AttributeValueArgs[] | null;
  taxClassId?: { id: string } | null;
  categoryIds?: { id: string }[] | null;
  channelListings?: { channelId: { id: string }; isPublished?: boolean | null; visibleInListings?: boolean | null }[] | null;
  variants?: VariantArgs[] | null;
  media?: { url: string; alt?: LocalizedList | null; kind?: "image" | "video" | null; variantSku?: string | null; position?: number | null }[] | null;
};

/** Marks an explicit null that should reach the service (the filter below drops plain nulls). */
const CLEAR = Symbol("clear");

const toProduct = (input: ProductArgs) =>
  Object.fromEntries(
    Object.entries({
      productTypeId: input.productTypeId ? rawId(input.productTypeId) : undefined,
      status: input.status,
      translations: input.translations?.map((tr) => Object.fromEntries(Object.entries(tr).filter(([, v]) => v !== null && v !== undefined))),
      attributes: toAttributes(input.attributes),
      taxClassId: input.taxClassId === null ? CLEAR : input.taxClassId ? rawId(input.taxClassId) : undefined,
      categoryIds: input.categoryIds?.map(rawId),
      channelListings: input.channelListings?.map((l) => ({ channelId: rawId(l.channelId), isPublished: l.isPublished ?? true, visibleInListings: l.visibleInListings ?? true })),
      variants: input.variants?.map(toVariant),
      media: input.media?.map((m) => ({ url: m.url, alt: fromLocalizedList(m.alt), kind: m.kind ?? "image", ...(m.variantSku ? { variantSku: m.variantSku } : {}), ...(m.position != null ? { position: m.position } : {}) })),
      removeTranslations: input.removeTranslations ?? undefined,
    })
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, v === CLEAR ? null : v]),
  );

// ---------------------------------------------------------------- attribute definitions and product types

const AttributeOptionInput = builder.inputType("AttributeOptionInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ code: t.string({ required: true }), labels: t.field({ type: [LocalizedStringInput], required: true }), swatch: t.string() }),
});
const AttributeDefinitionInput = builder.inputType("AttributeDefinitionInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    labels: t.field({ type: [LocalizedStringInput], required: true }),
    type: t.field({ type: AttributeTypeEnum, required: true }),
    isLocalized: t.boolean(),
    isFilterable: t.boolean(),
    isSearchable: t.boolean(),
    isRequired: t.boolean(),
    options: t.field({ type: [AttributeOptionInput] }),
    unit: t.string(),
    position: t.int(),
  }),
});
const AttributeDefinitionUpdateInput = builder.inputType("AttributeDefinitionUpdateInput", {
  subGraphs: ADMIN,
  description: "Code and type are fixed once created.",
  fields: (t) => ({
    labels: t.field({ type: [LocalizedStringInput] }),
    isFilterable: t.boolean(),
    isSearchable: t.boolean(),
    isRequired: t.boolean(),
    options: t.field({ type: [AttributeOptionInput] }),
    unit: t.string(),
    position: t.int(),
  }),
});
type AttributeDefinitionArgs = {
  code?: string; labels?: LocalizedList | null; type?: string; isLocalized?: boolean | null; isFilterable?: boolean | null; isSearchable?: boolean | null;
  isRequired?: boolean | null; options?: { code: string; labels: LocalizedList; swatch?: string | null }[] | null; unit?: string | null; position?: number | null;
};
const toAttributeDefinition = (input: AttributeDefinitionArgs) =>
  Object.fromEntries(
    Object.entries({
      ...input,
      labels: undefined,
      label: input.labels ? fromLocalizedList(input.labels) : undefined,
      options: input.options?.map((o) => ({ code: o.code, label: fromLocalizedList(o.labels), swatch: o.swatch ?? null })),
    }).filter(([, v]) => v !== undefined && v !== null),
  );

const ProductTypeInput = builder.inputType("ProductTypeInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    name: t.string({ required: true }),
    attributeCodes: t.stringList(),
    variantAttributeCodes: t.stringList({ description: "Select attributes that define variants. Fixed after creation." }),
    isShippable: t.boolean({ description: "False for virtual or digital goods." }),
    taxClassId: t.globalID({ for: [TaxClassRef] }),
  }),
});
const ProductTypeUpdateInput = builder.inputType("ProductTypeUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ name: t.string(), attributeCodes: t.stringList(), isShippable: t.boolean(), taxClassId: t.globalID({ for: [TaxClassRef] }) }),
});

const CategoryTranslationInput = builder.inputType("CategoryTranslationInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ locale: t.field({ type: "LocaleCode", required: true }), name: t.string({ required: true }), slug: t.string(), description: t.string() }),
});
const CategoryInput = builder.inputType("CategoryInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    parentId: t.globalID({ for: [CategoryRef] }),
    translations: t.field({ type: [CategoryTranslationInput], required: true }),
    position: t.int({ description: "Index among its siblings (0 is first); default last. Siblings are renumbered." }),
    isActive: t.boolean(),
  }),
});
const CategoryUpdateInput = builder.inputType("CategoryUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    translations: t.field({ type: [CategoryTranslationInput] }),
    position: t.int({ description: "New index among its siblings (0 is first); siblings are renumbered." }),
    isActive: t.boolean(),
  }),
});

builder.queryField("productTypes", (t) =>
  t.field({ type: [ProductTypeRef], subGraphs: ADMIN, authScopes: { permission: "catalog:read" }, resolve: (_r, _a, ctx) => listProductTypes(ctx.db) }),
);

// ---------------------------------------------------------------- payloads and mutations

const ProductPayload = builder.simpleObject("ProductPayload", { subGraphs: ADMIN, fields: (t) => ({ product: t.field({ type: ProductRef }) }) });
const ProductVariantPayload = builder.simpleObject("ProductVariantPayload", { subGraphs: ADMIN, fields: (t) => ({ variant: t.field({ type: ProductVariantRef }) }) });
const AttributeDefinitionPayload = builder.simpleObject("AttributeDefinitionPayload", { subGraphs: ADMIN, fields: (t) => ({ attributeDefinition: t.field({ type: AttributeDefinitionRef }) }) });
const ProductTypePayload = builder.simpleObject("ProductTypePayload", { subGraphs: ADMIN, fields: (t) => ({ productType: t.field({ type: ProductTypeRef }) }) });
const CategoryPayload = builder.simpleObject("CategoryPayload", { subGraphs: ADMIN, fields: (t) => ({ category: t.field({ type: CategoryRef }) }) });

const CategoryMerchandisingInput = builder.inputType("CategoryMerchandisingInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    pinned: t.globalIDList({ for: [ProductRef], required: true, description: `Shown first, in this order. At most ${MAX_PINNED_PRODUCTS}.` }),
    hidden: t.globalIDList({ for: [ProductRef], required: true, description: "Left out of this category's listing, in every sort. Its parents' listings have their own." }),
  }),
});

const CategoryMerchandisingItemRef = builder.objectRef<MerchandisingItem>("CategoryMerchandisingItem").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    product: t.field({ type: ProductRef, resolve: async (item, _a, ctx) => (await ctx.loaders.product.load(item.productId))! }),
    pinned: t.exposeBoolean("pinned"),
    hidden: t.exposeBoolean("hidden"),
  }),
});

const CategoryMerchandisingRef = builder.objectRef<{ items: MerchandisingItem[]; totalCount: number }>("CategoryMerchandising").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    items: t.field({ type: [CategoryMerchandisingItemRef], resolve: (m) => m.items }),
    totalCount: t.exposeInt("totalCount", { description: "Products in the listing; `items` stops at `first`." }),
  }),
});

builder.objectFields(CategoryRef, (t) => ({
  merchandising: t.field({
    type: CategoryMerchandisingRef,
    subGraphs: ADMIN,
    authScopes: { permission: "catalog:read" },
    description:
      "The category's listing as the merchandising board shows it: pinned products in order, then hidden ones, then the rest newest first (the FEATURED sort). " +
      "Covers products in the category or below it, drafts included, archived ones not.",
    args: { first: t.arg.int({ description: "Up to 500; default 250." }) },
    complexity: (args) => ({ field: 5, multiplier: Math.min(Math.max(args.first ?? 250, 1), 500) }),
    resolve: (c, { first }, ctx) => getCategoryMerchandising(ctx.db, c.id, Math.min(Math.max(first ?? 250, 1), 500)),
  }),
}));
const SearchReindexPayload = builder.simpleObject("SearchReindexPayload", { subGraphs: ADMIN, fields: (t) => ({ productCount: t.int() }) });

const write = { subGraphs: ADMIN, authScopes: { permission: "catalog:write" }, errors: {} } as const;

builder.mutationFields((t) => ({
  attributeDefinitionCreate: t.field({
    ...write,
    type: AttributeDefinitionPayload,
    args: { input: t.arg({ type: AttributeDefinitionInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({ attributeDefinition: await createAttributeDefinition(ctx.db, toAttributeDefinition(input)) }),
  }),
  attributeDefinitionUpdate: t.field({
    ...write,
    type: AttributeDefinitionPayload,
    args: { id: t.arg.globalID({ for: [AttributeDefinitionRef], required: true }), input: t.arg({ type: AttributeDefinitionUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({ attributeDefinition: await updateAttributeDefinition(ctx.db, rawId(id), toAttributeDefinition(input)) }),
  }),
  productTypeCreate: t.field({
    ...write,
    type: ProductTypePayload,
    args: { input: t.arg({ type: ProductTypeInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      productType: await createProductType(ctx.db, { ...Object.fromEntries(Object.entries(input).filter(([, v]) => v != null)), taxClassId: input.taxClassId ? rawId(input.taxClassId) : null }),
    }),
  }),
  productTypeUpdate: t.field({
    ...write,
    type: ProductTypePayload,
    args: { id: t.arg.globalID({ for: [ProductTypeRef], required: true }), input: t.arg({ type: ProductTypeUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({
      productType: await updateProductType(ctx.db, rawId(id), {
        ...Object.fromEntries(Object.entries(input).filter(([k, v]) => v != null && k !== "taxClassId")),
        ...(input.taxClassId !== undefined ? { taxClassId: input.taxClassId ? rawId(input.taxClassId) : null } : {}),
      }),
    }),
  }),
  productCreate: t.field({
    ...write,
    type: ProductPayload,
    description: "Create a product with its variants, prices, stock, media, categories and channel listings in one transaction.",
    args: { input: t.arg({ type: ProductCreateInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({ product: await createProduct(ctx.db, toProduct(input)) }),
  }),
  productUpdate: t.field({
    ...write,
    type: ProductPayload,
    args: { id: t.arg.globalID({ for: [ProductRef], required: true }), input: t.arg({ type: ProductUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      const product = await updateProduct(ctx.db, rawId(id), toProduct(input));
      ctx.loaders.product.clear(product.id);
      ctx.loaders.productTranslations.clear(product.id);
      return { product };
    },
  }),
  productDelete: t.field({
    ...write,
    type: DeletePayload,
    args: { id: t.arg.globalID({ for: [ProductRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Product", await deleteProduct(ctx.db, rawId(id))) }),
  }),
  productVariantCreate: t.field({
    ...write,
    type: ProductVariantPayload,
    args: { productId: t.arg.globalID({ for: [ProductRef], required: true }), input: t.arg({ type: ProductVariantInput, required: true }) },
    resolve: async (_r, { productId, input }, ctx) => ({ variant: await createVariant(ctx.db, rawId(productId), toVariant(input)) }),
  }),
  productVariantUpdate: t.field({
    ...write,
    type: ProductVariantPayload,
    args: { id: t.arg.globalID({ for: [ProductVariantRef], required: true }), input: t.arg({ type: ProductVariantUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      const variant = await updateVariant(ctx.db, rawId(id), toVariant(input));
      ctx.loaders.variant.clear(variant.id);
      ctx.loaders.priceRows.clear(variant.id);
      ctx.loaders.stockLevels.clear(variant.id);
      return { variant };
    },
  }),
  productVariantDelete: t.field({
    ...write,
    type: DeletePayload,
    args: { id: t.arg.globalID({ for: [ProductVariantRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("ProductVariant", await deleteVariant(ctx.db, rawId(id))) }),
  }),
  productVariantPricesSet: t.field({
    ...write,
    type: ProductVariantPayload,
    description: "Replace every price point of a variant (all channels, currencies, groups, tiers and dates).",
    args: { variantId: t.arg.globalID({ for: [ProductVariantRef], required: true }), prices: t.arg({ type: [VariantPriceInput], required: true }) },
    resolve: async (_r, { variantId, prices }, ctx) => {
      await setVariantPrices(ctx.db, rawId(variantId), toPrices(prices) ?? []);
      ctx.loaders.priceRows.clear(rawId(variantId));
      ctx.loaders.price.clear(rawId(variantId));
      const [variant] = await getVariantsByIds(ctx.db, [rawId(variantId)]);
      return { variant: variant! };
    },
  }),
  categoryCreate: t.field({
    ...write,
    type: CategoryPayload,
    args: { input: t.arg({ type: CategoryInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      category: await createCategory(ctx.db, {
        parentId: input.parentId ? rawId(input.parentId) : null,
        translations: input.translations.map((tr) => Object.fromEntries(Object.entries(tr).filter(([, v]) => v != null))),
        ...(input.position != null ? { position: input.position } : {}),
        isActive: input.isActive ?? true,
      }),
    }),
  }),
  categoryUpdate: t.field({
    ...write,
    type: CategoryPayload,
    args: { id: t.arg.globalID({ for: [CategoryRef], required: true }), input: t.arg({ type: CategoryUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      const category = await updateCategory(ctx.db, rawId(id), {
        ...(input.translations ? { translations: input.translations.map((tr) => Object.fromEntries(Object.entries(tr).filter(([, v]) => v != null))) } : {}),
        ...(input.position != null ? { position: input.position } : {}),
        ...(input.isActive != null ? { isActive: input.isActive } : {}),
      });
      ctx.loaders.category.clear(category.id);
      ctx.loaders.categoryTranslations.clear(category.id);
      return { category };
    },
  }),
  categoryMove: t.field({
    ...write,
    type: CategoryPayload,
    description: "Re-parent a category and its subtree (null parent makes it a root), or reorder it within its parent.",
    args: {
      id: t.arg.globalID({ for: [CategoryRef], required: true }),
      parentId: t.arg.globalID({ for: [CategoryRef] }),
      position: t.arg.int({ description: "Index among the new siblings (0 is first); default last. Siblings are renumbered." }),
    },
    resolve: async (_r, args, ctx) => ({ category: await moveCategory(ctx.db, rawId(args.id), args.parentId ? rawId(args.parentId) : null, args.position ?? undefined) }),
  }),
  categoryDelete: t.field({
    ...write,
    type: DeletePayload,
    description: "Deletes the category and its subtree; products stay, without these assignments.",
    args: { id: t.arg.globalID({ for: [CategoryRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Category", await deleteCategory(ctx.db, rawId(id))) }),
  }),
  categoryMerchandisingUpdate: t.field({
    ...write,
    type: CategoryPayload,
    description:
      "Replace the listing's pinned and hidden products. Products in neither list go back to the automatic order, newest first. " +
      "Each must be in the category or below it, and named once.",
    args: { id: t.arg.globalID({ for: [CategoryRef], required: true }), input: t.arg({ type: CategoryMerchandisingInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      await setCategoryMerchandising(ctx.db, rawId(id), { pinned: input.pinned.map(rawId), hidden: input.hidden.map(rawId) });
      return { category: (await ctx.loaders.category.load(rawId(id)))! };
    },
  }),
  searchReindex: t.field({
    ...write,
    type: SearchReindexPayload,
    description: "Rebuild the search projection for every product. Normally unnecessary: writes keep it current.",
    resolve: async (_r, _a, ctx) => ({ productCount: await reindexAllProducts(ctx.db) }),
  }),
}));

// ---------------------------------------------------------------- bulk actions, duplication, redirects, variant search

const ProductBulkUpdateInput = builder.inputType("ProductBulkUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    status: t.field({ type: ProductStatusEnum }),
    addCategoryIds: t.globalIDList({ for: [CategoryRef] }),
    removeCategoryIds: t.globalIDList({ for: [CategoryRef] }),
    channelListings: t.field({ type: [ProductChannelListingInput], description: "Upserted per channel; other channels are left alone." }),
    attributes: t.field({
      type: [AttributeValueInput],
      description: "Merged into each product and checked against each product's type. Localized text is merged per language, so setting one language keeps the others.",
    }),
  }),
});
const ProductsPayload = builder.simpleObject("ProductsPayload", { subGraphs: ADMIN, fields: (t) => ({ products: t.field({ type: [ProductRef] }) }) });
const BulkDeletePayload = builder.simpleObject("BulkDeletePayload", { subGraphs: ADMIN, fields: (t) => ({ deletedIds: t.idList() }) });

type RedirectRow = typeof redirects.$inferSelect;
const UrlRedirectRef = builder.objectRef<RedirectRow>("UrlRedirect").implement({
  subGraphs: ADMIN,
  description: "A managed redirect. Slug changes create these automatically.",
  fields: (t) => ({
    id: t.id({ resolve: (r) => toGlobalId("UrlRedirect", r.id) }),
    fromPath: t.exposeString("fromPath"),
    toPath: t.exposeString("toPath", { description: "A path, or an absolute URL for external targets." }),
    statusCode: t.exposeInt("statusCode"),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
  }),
});
const UrlRedirectInput = builder.inputType("UrlRedirectInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ fromPath: t.string({ required: true }), toPath: t.string({ required: true }), statusCode: t.int({ description: "301 (default), 302, 307 or 308." }) }),
});
const UrlRedirectPayload = builder.simpleObject("UrlRedirectPayload", { subGraphs: ADMIN, fields: (t) => ({ urlRedirect: t.field({ type: UrlRedirectRef }) }) });

const writeOrInvalid = { subGraphs: ADMIN, authScopes: { permission: "catalog:write" as const }, errors: { types: [InvalidStateError] } };

builder.mutationFields((t) => ({
  attributeDefinitionDelete: t.field({
    ...writeOrInvalid,
    type: DeletePayload,
    description: "Fails while a product type uses the attribute.",
    args: { id: t.arg.globalID({ for: [AttributeDefinitionRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("AttributeDefinition", await deleteAttributeDefinition(ctx.db, rawId(id))) }),
  }),
  productTypeDelete: t.field({
    ...writeOrInvalid,
    type: DeletePayload,
    description: "Fails while products use the type.",
    args: { id: t.arg.globalID({ for: [ProductTypeRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("ProductType", await deleteProductType(ctx.db, rawId(id))) }),
  }),
  productBulkUpdate: t.field({
    ...write,
    type: ProductsPayload,
    description: "Set status, categories or channel listings on up to 500 products in one transaction.",
    args: { ids: t.arg.globalIDList({ for: [ProductRef], required: true }), input: t.arg({ type: ProductBulkUpdateInput, required: true }) },
    resolve: async (_r, { ids, input }, ctx) => {
      const products = await bulkUpdateProducts(
        ctx.db,
        ids.map(rawId),
        {
          ...(input.status ? { status: input.status } : {}),
          addCategoryIds: input.addCategoryIds?.map(rawId) ?? [],
          removeCategoryIds: input.removeCategoryIds?.map(rawId) ?? [],
          channelListings: input.channelListings?.map((l) => ({ channelId: rawId(l.channelId), isPublished: l.isPublished ?? true, visibleInListings: l.visibleInListings ?? true })) ?? [],
          ...(input.attributes ? { attributes: toAttributes(input.attributes) } : {}),
        },
      );
      for (const p of products) ctx.loaders.product.clear(p.id);
      return { products };
    },
  }),
  productBulkDelete: t.field({
    ...write,
    type: BulkDeletePayload,
    args: { ids: t.arg.globalIDList({ for: [ProductRef], required: true }) },
    resolve: async (_r, { ids }, ctx) => ({ deletedIds: (await bulkDeleteProducts(ctx.db, ids.map(rawId))).map((id) => toGlobalId("Product", id)) }),
  }),
  productDuplicate: t.field({
    ...write,
    type: ProductPayload,
    description: "Copy as an unpublished draft with new SKUs and slugs; stock is not copied.",
    args: { id: t.arg.globalID({ for: [ProductRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ product: await duplicateProduct(ctx.db, rawId(id)) }),
  }),
  urlRedirectCreate: t.field({
    ...write,
    type: UrlRedirectPayload,
    args: { input: t.arg({ type: UrlRedirectInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({ urlRedirect: await createRedirect(ctx.db, { ...input, statusCode: input.statusCode ?? undefined }) }),
  }),
  urlRedirectDelete: t.field({
    ...write,
    type: DeletePayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("UrlRedirect", await deleteRedirect(ctx.db, rawId(String(id)))) }),
  }),
}));

builder.objectFields(ProductRef, (t) => ({
  taxClass: t.field({
    type: TaxClassRef,
    nullable: true,
    subGraphs: ADMIN,
    description: "The product's own override; null means its product type's tax class applies.",
    resolve: async (p, _a, ctx) => (p.taxClassId ? ((await ctx.db.query.taxClasses.findFirst({ where: (c, { eq: e }) => e(c.id, p.taxClassId!) })) ?? null) : null),
  }),
}));

builder.objectFields(MediaRef, (t) => ({
  alts: t.field({ type: [LocalizedStringRef], subGraphs: ADMIN, description: "Alt text in every locale.", resolve: (m) => toLocalizedList(m.alt) }),
}));

builder.objectFields(ProductTypeRef, (t) => ({
  productCount: t.int({ description: "Products of this type; a type in use cannot be deleted.", resolve: (p, _a, ctx) => ctx.db.$count(products, eq(products.productTypeId, p.id)) }),
}));

builder.queryFields((t) => ({
  categories: t.field({
    type: [CategoryRef],
    subGraphs: ADMIN,
    description: "Every category, depth first in position order (a flat view of categoryTree), optionally matching a name.",
    authScopes: { permission: "catalog:read" },
    args: { query: t.arg.string() },
    resolve: (_r, { query }, ctx) => listCategoriesFlat(ctx.db, query),
  }),
  urlRedirects: t.connection({
    type: UrlRedirectRef,
    subGraphs: ADMIN,
    authScopes: { permission: "catalog:read" },
    args: { query: t.arg.string({ description: "Matches either path." }) },
    complexity: connectionComplexity,
    resolve: async (_r, args, ctx) => {
      const page = offsetPage(args);
      const { rows, total } = await listRedirects(ctx.db, { query: args.query }, page);
      return offsetConnection(page, rows, total);
    },
  }),
  productVariants: t.connection({
    type: ProductVariantRef,
    subGraphs: ADMIN,
    description: "Search variants by SKU, barcode or product name, e.g. for stock counts and order entry.",
    authScopes: (_r, _a, ctx) => (hasPermission(ctx.permissions, "inventory:read") ? true : { permission: "catalog:read" }),
    args: {
      query: t.arg.string(),
      productId: t.arg.globalID({ for: [ProductRef] }),
      maxOnHand: t.arg.int({ description: "Only variants with at most this many on hand across locations." }),
      trackInventory: t.arg.boolean(),
    },
    complexity: connectionComplexity,
    resolve: async (_r, args, ctx) => {
      const page = offsetPage(args);
      const { rows, total } = await searchVariants(ctx.db, { query: args.query, productId: args.productId ? rawId(args.productId) : null, maxOnHand: args.maxOnHand, trackInventory: args.trackInventory }, page);
      return offsetConnection(page, rows, total);
    },
  }),
}));
