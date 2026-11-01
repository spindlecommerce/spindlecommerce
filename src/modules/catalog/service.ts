import { and, asc, eq, ilike, inArray, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError, ValidationError, type FieldError } from "../../lib/errors.ts";
import { slugify, type LocalizedText } from "../../lib/i18n.ts";
import { parseInput, patchSchema } from "../../lib/validation.ts";
import { setStockLevel } from "../inventory/service.ts";
import { emit } from "../integrations/outbox.ts";
import { toPriceRows, priceInputSchema } from "../pricing/service.ts";
import { variantPrices } from "../pricing/tables.ts";
import { reindexProducts } from "../search/projector.ts";
import { getDescendantCategoryIds, type AttributeDefinition, type Category, type Product, type ProductVariant } from "./read.ts";
import {
  ATTRIBUTE_TYPES,
  PRODUCT_STATUSES,
  attributeDefinitions,
  categories,
  categoryTranslations,
  productCategories,
  productChannelListings,
  productMedia,
  productTranslations,
  productTypes,
  products,
  productVariants,
  redirects,
  type AttributeValue,
} from "./tables.ts";

const localizedText = z.record(z.string().min(2), z.string());
const code = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, "Use lowercase letters, digits and underscores");
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens");

// ---------------------------------------------------------------- attribute definitions

const attributeDefinitionSchema = z
  .object({
    code,
    label: localizedText,
    type: z.enum(ATTRIBUTE_TYPES),
    isLocalized: z.boolean().default(false),
    isFilterable: z.boolean().default(false),
    isSearchable: z.boolean().default(false),
    isRequired: z.boolean().default(false),
    options: z.array(z.object({ code: z.string().regex(/^[a-z0-9_-]{1,60}$/), label: localizedText, swatch: z.string().nullable().optional() })).default([]),
    unit: z.string().max(20).nullable().optional(),
    position: z.number().int().default(0),
  })
  .refine((d) => !["select", "multiselect"].includes(d.type) || d.options.length > 0, { path: ["options"], message: "Select attributes need options" })
  .refine((d) => !d.isLocalized || ["text", "rich_text"].includes(d.type), { path: ["isLocalized"], message: "Only text attributes can be localized" });

export const createAttributeDefinition = async (db: Database, input: unknown) => {
  const [row] = await db.insert(attributeDefinitions).values(parseInput(attributeDefinitionSchema, input)).returning();
  return row!;
};

export const updateAttributeDefinition = async (db: Database, id: string, input: unknown) => {
  const existing = await db.query.attributeDefinitions.findFirst({ where: eq(attributeDefinitions.id, id) });
  if (!existing) throw new NotFoundError("AttributeDefinition", id);
  const data = parseInput(attributeDefinitionSchema, { ...existing, ...(input as object), code: existing.code, type: existing.type });
  const [row] = await db.update(attributeDefinitions).set(data).where(eq(attributeDefinitions.id, id)).returning();
  return row!;
};

const isLocalizedText = (value: unknown): value is LocalizedText =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");

/** Throws field errors for unknown, invalid or missing required attributes. */
export const normalizeAttributeValues = (
  definitions: Map<string, AttributeDefinition>,
  allowed: readonly string[],
  values: Record<string, unknown> | undefined,
  path: string[],
  required: readonly string[] = [],
): Record<string, AttributeValue> => {
  const errors: FieldError[] = [];
  const out: Record<string, AttributeValue> = {};
  for (const [attrCode, raw] of Object.entries(values ?? {})) {
    const def = definitions.get(attrCode);
    const p = [...path, attrCode];
    if (!def || !allowed.includes(attrCode)) {
      errors.push({ path: p, message: `Attribute ${attrCode} is not part of this product type` });
      continue;
    }
    if (raw === null || raw === undefined) continue;
    const options = new Set(def.options.map((o) => o.code));
    const ok = (() => {
      switch (def.type) {
        case "text":
        case "rich_text":
          return def.isLocalized ? isLocalizedText(raw) : typeof raw === "string";
        case "number":
          return typeof raw === "number" && Number.isFinite(raw);
        case "boolean":
          return typeof raw === "boolean";
        case "select":
          return typeof raw === "string" && options.has(raw);
        case "multiselect":
          return Array.isArray(raw) && raw.every((v) => typeof v === "string" && options.has(v));
        case "date":
          return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) && !Number.isNaN(Date.parse(raw));
      }
    })();
    if (!ok) {
      const expected = def.isLocalized ? "an object of locale → text" : ["select", "multiselect"].includes(def.type) ? `one of ${[...options].join(", ")}` : `a ${def.type} value`;
      errors.push({ path: p, message: `Expected ${expected}` });
      continue;
    }
    out[attrCode] = raw as AttributeValue;
  }
  for (const attrCode of required) if (out[attrCode] === undefined) errors.push({ path: [...path, attrCode], message: "Required" });
  if (errors.length > 0) throw new ValidationError("Invalid attribute values", errors);
  return out;
};

// ---------------------------------------------------------------- product types

const productTypeSchema = z.object({
  code,
  name: z.string().min(1),
  attributeCodes: z.array(code).default([]),
  variantAttributeCodes: z.array(code).default([]),
  isShippable: z.boolean().default(true),
  taxClassId: z.uuid().nullable().optional(),
});

const checkTypeAttributes = async (db: Database, data: { attributeCodes: string[]; variantAttributeCodes: string[] }) => {
  const codes = [...new Set([...data.attributeCodes, ...data.variantAttributeCodes])];
  const found = codes.length ? await db.select().from(attributeDefinitions).where(inArray(attributeDefinitions.code, codes)) : [];
  const byCode = new Map(found.map((d) => [d.code, d]));
  const errors: FieldError[] = [];
  data.attributeCodes.forEach((c, i) => !byCode.has(c) && errors.push({ path: ["input", "attributeCodes", String(i)], message: `Unknown attribute ${c}` }));
  data.variantAttributeCodes.forEach((c, i) => {
    const def = byCode.get(c);
    if (!def) errors.push({ path: ["input", "variantAttributeCodes", String(i)], message: `Unknown attribute ${c}` });
    else if (def.type !== "select") errors.push({ path: ["input", "variantAttributeCodes", String(i)], message: "Variant axes must be select attributes" });
  });
  if (errors.length) throw new ValidationError("Invalid product type", errors);
};

export const createProductType = async (db: Database, input: unknown) => {
  const data = parseInput(productTypeSchema, input);
  await checkTypeAttributes(db, data);
  const [row] = await db.insert(productTypes).values(data).returning();
  return row!;
};

export const updateProductType = async (db: Database, id: string, input: unknown) => {
  const existing = await db.query.productTypes.findFirst({ where: eq(productTypes.id, id) });
  if (!existing) throw new NotFoundError("ProductType", id);
  const data = parseInput(productTypeSchema, { ...existing, ...(input as object), code: existing.code, variantAttributeCodes: existing.variantAttributeCodes });
  await checkTypeAttributes(db, data);
  const [row] = await db.update(productTypes).set(data).where(eq(productTypes.id, id)).returning();
  return row!;
};

// ---------------------------------------------------------------- products

const translationSchema = z.object({
  locale: z.string().min(2),
  name: z.string().min(1).max(250),
  slug: slug.optional(),
  description: z.string().max(100_000).nullable().optional(),
  metaTitle: z.string().max(250).nullable().optional(),
  metaDescription: z.string().max(500).nullable().optional(),
});

const variantSchema = z.object({
  sku: z.string().regex(/^[A-Za-z0-9._\-/]{1,64}$/),
  attributes: z.record(z.string(), z.unknown()).default({}),
  position: z.number().int().default(0),
  weightGrams: z.number().int().nonnegative().nullable().optional(),
  barcode: z.string().max(64).nullable().optional(),
  isActive: z.boolean().default(true),
  trackInventory: z.boolean().default(true),
  allowBackorder: z.boolean().default(false),
  prices: z.array(priceInputSchema).optional(),
  stock: z.array(z.object({ locationId: z.uuid(), quantity: z.number().int() })).optional(),
});

const mediaSchema = z.object({
  url: z.url(),
  alt: localizedText.default({}),
  kind: z.enum(["image", "video"]).default("image"),
  variantSku: z.string().optional(),
  position: z.number().int().optional(),
});

const listingSchema = z.object({ channelId: z.uuid(), isPublished: z.boolean().default(true), visibleInListings: z.boolean().default(true) });

const productCreateSchema = z.object({
  productTypeId: z.uuid(),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  translations: z.array(translationSchema).min(1),
  attributes: z.record(z.string(), z.unknown()).default({}),
  taxClassId: z.uuid().nullable().optional(),
  categoryIds: z.array(z.uuid()).default([]),
  channelListings: z.array(listingSchema).default([]),
  variants: z.array(variantSchema).min(1),
  media: z.array(mediaSchema).default([]),
});

const productUpdateSchema = patchSchema(productCreateSchema.omit({ productTypeId: true, variants: true }).extend({ removeTranslations: z.array(z.string().min(2)).default([]) }));
const variantPatchSchema = patchSchema(variantSchema);

type VariantInput = z.output<typeof variantSchema>;

const loadTypeContext = async (db: Database, productTypeId: string) => {
  const type = await db.query.productTypes.findFirst({ where: eq(productTypes.id, productTypeId) });
  if (!type) throw new ValidationError("Unknown product type", [{ path: ["input", "productTypeId"], message: "No such product type" }]);
  const codes = [...new Set([...type.attributeCodes, ...type.variantAttributeCodes])];
  const defs = codes.length ? await db.select().from(attributeDefinitions).where(inArray(attributeDefinitions.code, codes)) : [];
  return { type, definitions: new Map(defs.map((d) => [d.code, d])) };
};

/** Every variant must set every axis, and no two variants may share a combination. */
const validateVariantAxes = (
  ctx: Awaited<ReturnType<typeof loadTypeContext>>,
  variants: { attributes: Record<string, unknown>; sku: string }[],
  basePath: string[],
  existing: ProductVariant[] = [],
) => {
  const axes = ctx.type.variantAttributeCodes;
  if (axes.length === 0 && variants.length + existing.length > 1) {
    throw new ValidationError("This product type has no variant attributes, so a product can only have one variant", [{ path: basePath, message: "Exactly one variant allowed" }]);
  }
  const seen = new Map(existing.map((v) => [JSON.stringify(axes.map((a) => v.attributes[a])), v.sku]));
  return variants.map((variant, index) => {
    const normalized = normalizeAttributeValues(ctx.definitions, ctx.type.variantAttributeCodes, variant.attributes, [...basePath, String(index), "attributes"], axes);
    const key = JSON.stringify(axes.map((a) => normalized[a]));
    const clash = seen.get(key);
    if (axes.length > 0 && clash) {
      throw new ValidationError("Duplicate variant", [{ path: [...basePath, String(index), "attributes"], message: `Same options as ${clash}` }]);
    }
    seen.set(key, variant.sku);
    return normalized;
  });
};

const ensureSkusFree = async (db: Database, skus: string[], basePath: string[], exceptVariantId?: string) => {
  const dupes = skus.filter((s, i) => skus.indexOf(s) !== i);
  const taken = skus.length
    ? await db.select({ sku: productVariants.sku }).from(productVariants).where(exceptVariantId ? and(inArray(productVariants.sku, skus), ne(productVariants.id, exceptVariantId)) : inArray(productVariants.sku, skus))
    : [];
  const bad = new Set([...dupes, ...taken.map((t) => t.sku)]);
  if (bad.size > 0) {
    throw new ValidationError("SKU already in use", skus.flatMap((s, i) => (bad.has(s) ? [{ path: [...basePath, String(i), "sku"], message: `SKU ${s} is already in use` }] : [])));
  }
};

const uniqueSlug = async (db: Database, table: typeof productTranslations | typeof categoryTranslations, locale: string, base: string, ownerId?: string) => {
  const owner = table === productTranslations ? productTranslations.productId : categoryTranslations.categoryId;
  const rows = await db
    .select({ slug: table.slug, owner })
    .from(table)
    .where(and(eq(table.locale, locale), like(table.slug, `${base}%`)));
  const taken = new Set(rows.filter((r) => r.owner !== ownerId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

/** Point old URLs at new ones, collapsing chains and removing loops. */
const recordRedirect = async (db: Database, fromSlug: string, toSlug: string) => {
  if (fromSlug === toSlug) return;
  const from = `/${fromSlug}`;
  const to = `/${toSlug}`;
  await db.delete(redirects).where(eq(redirects.fromPath, to));
  await db.update(redirects).set({ toPath: to }).where(eq(redirects.toPath, from));
  await db.insert(redirects).values({ fromPath: from, toPath: to }).onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: to } });
};

const insertVariants = async (db: Database, productId: string, variants: VariantInput[], attributes: Record<string, AttributeValue>[], pathBase: string[]) => {
  const inserted = await db
    .insert(productVariants)
    .values(
      variants.map((v, i) => ({
        productId,
        sku: v.sku,
        attributes: attributes[i]!,
        position: v.position || i,
        weightGrams: v.weightGrams ?? null,
        barcode: v.barcode ?? null,
        isActive: v.isActive,
        trackInventory: v.trackInventory,
        allowBackorder: v.allowBackorder,
      })),
    )
    .returning();
  for (const [i, variant] of variants.entries()) {
    const row = inserted.find((r) => r.sku === variant.sku)!;
    if (variant.prices?.length) await db.insert(variantPrices).values(toPriceRows(row.id, variant.prices, [...pathBase, String(i), "prices"]));
    for (const level of variant.stock ?? []) await setStockLevel(db, { variantId: row.id, locationId: level.locationId, quantity: level.quantity });
  }
  return inserted;
};

const replaceMedia = async (db: Database, productId: string, media: z.output<typeof mediaSchema>[]) => {
  await db.delete(productMedia).where(eq(productMedia.productId, productId));
  if (media.length === 0) return;
  const skus = media.map((m) => m.variantSku).filter((s): s is string => !!s);
  const variants = skus.length ? await db.select().from(productVariants).where(and(eq(productVariants.productId, productId), inArray(productVariants.sku, skus))) : [];
  await db.insert(productMedia).values(
    media.map((m, i) => ({
      productId,
      variantId: m.variantSku ? (variants.find((v) => v.sku === m.variantSku)?.id ?? null) : null,
      kind: m.kind,
      url: m.url,
      alt: m.alt,
      position: m.position ?? i,
    })),
  );
};

const replaceCategories = async (db: Database, productId: string, categoryIds: string[]) => {
  await db.delete(productCategories).where(eq(productCategories.productId, productId));
  if (categoryIds.length === 0) return;
  const found = await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, categoryIds));
  const missing = categoryIds.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new ValidationError("Unknown categories", missing.map((id) => ({ path: ["input", "categoryIds"], message: `No category ${id}` })));
  await db.insert(productCategories).values(categoryIds.map((categoryId, position) => ({ productId, categoryId, position })));
};

const replaceListings = async (db: Database, productId: string, listings: z.output<typeof listingSchema>[]) => {
  await db.delete(productChannelListings).where(eq(productChannelListings.productId, productId));
  if (listings.length === 0) return;
  await db.insert(productChannelListings).values(listings.map((l) => ({ productId, ...l, publishedAt: l.isPublished ? new Date() : null })));
};

const upsertTranslations = async (db: Database, productId: string, translations: z.output<typeof translationSchema>[]) => {
  const existing = await db.select().from(productTranslations).where(eq(productTranslations.productId, productId));
  for (const t of translations) {
    const desired = await uniqueSlug(db, productTranslations, t.locale, t.slug ?? slugify(t.name), productId);
    const current = existing.find((e) => e.locale === t.locale);
    const values = { productId, locale: t.locale, name: t.name, slug: desired, description: t.description ?? null, metaTitle: t.metaTitle ?? null, metaDescription: t.metaDescription ?? null };
    await db.insert(productTranslations).values(values).onConflictDoUpdate({ target: [productTranslations.productId, productTranslations.locale], set: values });
    if (current && current.slug !== desired) await recordRedirect(db, current.slug, desired);
  }
};

const isTextByLocale = (value: unknown): value is Record<string, string> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Merge `values` into a product's attributes (null removes one) and validate them. With
 * `mergeLocales`, localized text merges per locale instead of being replaced.
 */
const mergeAttributes = async (db: Database, product: Product, values: Record<string, unknown>, options: { mergeLocales?: boolean } = {}) => {
  const { type, definitions } = await loadTypeContext(db, product.productTypeId);
  const merged: Record<string, unknown> = { ...product.attributes, ...values };
  for (const [k, v] of Object.entries(values)) {
    const current = product.attributes[k];
    if (v === null) delete merged[k];
    else if (options.mergeLocales && definitions.get(k)?.isLocalized && isTextByLocale(current) && isTextByLocale(v)) merged[k] = { ...current, ...v };
  }
  const required = [...definitions.values()].filter((d) => d.isRequired && type.attributeCodes.includes(d.code)).map((d) => d.code);
  try {
    return normalizeAttributeValues(definitions, type.attributeCodes, merged, ["input", "attributes"], required);
  } catch (error) {
    if (error instanceof ValidationError) throw new ValidationError(`Invalid attribute values for the ${type.name} product type`, error.fieldErrors);
    throw error;
  }
};

export const createProduct = async (db: Database, input: unknown): Promise<Product> =>
  db.transaction(async (tx) => {
    const data = parseInput(productCreateSchema, input);
    const ctx = await loadTypeContext(tx, data.productTypeId);
    const required = [...ctx.definitions.values()].filter((d) => d.isRequired && ctx.type.attributeCodes.includes(d.code)).map((d) => d.code);
    const attributes = normalizeAttributeValues(ctx.definitions, ctx.type.attributeCodes, data.attributes, ["input", "attributes"], required);
    const variantAttributes = validateVariantAxes(ctx, data.variants, ["input", "variants"]);
    await ensureSkusFree(tx, data.variants.map((v) => v.sku), ["input", "variants"]);
    const [product] = await tx
      .insert(products)
      .values({ productTypeId: ctx.type.id, status: data.status, attributes, taxClassId: data.taxClassId ?? null })
      .returning();
    await upsertTranslations(tx, product!.id, data.translations);
    await insertVariants(tx, product!.id, data.variants, variantAttributes, ["input", "variants"]);
    await replaceMedia(tx, product!.id, data.media);
    await replaceCategories(tx, product!.id, data.categoryIds);
    await replaceListings(tx, product!.id, data.channelListings);
    await reindexProducts(tx, [product!.id]);
    await emit(tx, { type: "product.created", aggregateType: "Product", aggregateId: product!.id });
    return product!;
  });

export const updateProduct = async (db: Database, id: string, input: unknown): Promise<Product> =>
  db.transaction(async (tx) => {
    const product = await tx.query.products.findFirst({ where: eq(products.id, id) });
    if (!product) throw new NotFoundError("Product", id);
    const data = parseInput(productUpdateSchema, input);
    const patch: Partial<typeof products.$inferInsert> = {};
    if (data.status) patch.status = data.status;
    if (data.taxClassId !== undefined) patch.taxClassId = data.taxClassId;
    if (data.attributes) patch.attributes = await mergeAttributes(tx, product, data.attributes);
    const [updated] = await tx.update(products).set({ ...patch, updatedAt: new Date() }).where(eq(products.id, id)).returning();
    if (data.translations) await upsertTranslations(tx, id, data.translations);
    if (data.removeTranslations?.length) {
      const remaining = (await tx.select({ locale: productTranslations.locale }).from(productTranslations).where(eq(productTranslations.productId, id))).filter((t) => !data.removeTranslations!.includes(t.locale));
      if (remaining.length === 0) throw new ValidationError("A product needs at least one translation", [{ path: ["input", "removeTranslations"], message: "Keep at least one locale" }]);
      await tx.delete(productTranslations).where(and(eq(productTranslations.productId, id), inArray(productTranslations.locale, data.removeTranslations)));
    }
    if (data.media) await replaceMedia(tx, id, data.media);
    if (data.categoryIds) await replaceCategories(tx, id, data.categoryIds);
    if (data.channelListings) await replaceListings(tx, id, data.channelListings);
    await reindexProducts(tx, [id]);
    await emit(tx, { type: "product.updated", aggregateType: "Product", aggregateId: id });
    return updated!;
  });

export const deleteProduct = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const [deleted] = await tx.delete(products).where(eq(products.id, id)).returning({ id: products.id });
    if (!deleted) throw new NotFoundError("Product", id);
    await emit(tx, { type: "product.deleted", aggregateType: "Product", aggregateId: id });
    return id;
  });

export const createVariant = async (db: Database, productId: string, input: unknown) =>
  db.transaction(async (tx) => {
    const product = await tx.query.products.findFirst({ where: eq(products.id, productId) });
    if (!product) throw new NotFoundError("Product", productId);
    const data = parseInput(variantSchema, input);
    const ctx = await loadTypeContext(tx, product.productTypeId);
    const existing = await tx.select().from(productVariants).where(eq(productVariants.productId, productId));
    const [attributes] = validateVariantAxes(ctx, [data], ["input"], existing);
    await ensureSkusFree(tx, [data.sku], ["input"]);
    const [variant] = await insertVariants(tx, productId, [data], [attributes!], ["input"]);
    await reindexProducts(tx, [productId]);
    await emit(tx, { type: "product.updated", aggregateType: "Product", aggregateId: productId });
    return variant!;
  });

export const updateVariant = async (db: Database, variantId: string, input: unknown) =>
  db.transaction(async (tx) => {
    const variant = await tx.query.productVariants.findFirst({ where: eq(productVariants.id, variantId) });
    if (!variant) throw new NotFoundError("ProductVariant", variantId);
    const data = parseInput(variantPatchSchema, input);
    const product = (await tx.query.products.findFirst({ where: eq(products.id, variant.productId) }))!;
    const ctx = await loadTypeContext(tx, product.productTypeId);
    const patch: Partial<typeof productVariants.$inferInsert> = {};
    if (data.sku && data.sku !== variant.sku) {
      await ensureSkusFree(tx, [data.sku], ["input"], variantId);
      patch.sku = data.sku;
    }
    if (data.attributes) {
      const others = (await tx.select().from(productVariants).where(eq(productVariants.productId, variant.productId))).filter((v) => v.id !== variantId);
      patch.attributes = validateVariantAxes(ctx, [{ sku: data.sku ?? variant.sku, attributes: { ...variant.attributes, ...data.attributes } }], ["input"], others)[0]!;
    }
    for (const key of ["position", "weightGrams", "barcode", "isActive", "trackInventory", "allowBackorder"] as const) {
      if (data[key] !== undefined) (patch as Record<string, unknown>)[key] = data[key];
    }
    const [updated] = await tx.update(productVariants).set({ ...patch, updatedAt: new Date() }).where(eq(productVariants.id, variantId)).returning();
    if (data.prices) {
      await tx.delete(variantPrices).where(eq(variantPrices.variantId, variantId));
      if (data.prices.length) await tx.insert(variantPrices).values(toPriceRows(variantId, data.prices, ["input", "prices"]));
    }
    for (const level of data.stock ?? []) await setStockLevel(tx, { variantId, locationId: level.locationId, quantity: level.quantity });
    await reindexProducts(tx, [variant.productId]);
    await emit(tx, { type: "product.updated", aggregateType: "Product", aggregateId: variant.productId });
    return updated!;
  });

export const deleteVariant = async (db: Database, variantId: string) =>
  db.transaction(async (tx) => {
    const variant = await tx.query.productVariants.findFirst({ where: eq(productVariants.id, variantId) });
    if (!variant) throw new NotFoundError("ProductVariant", variantId);
    const count = await tx.$count(productVariants, eq(productVariants.productId, variant.productId));
    if (count <= 1) throw new ValidationError("A product needs at least one variant", [{ path: ["id"], message: "Cannot delete the last variant" }]);
    await tx.delete(productVariants).where(eq(productVariants.id, variantId));
    await reindexProducts(tx, [variant.productId]);
    await emit(tx, { type: "product.updated", aggregateType: "Product", aggregateId: variant.productId });
    return variantId;
  });

// ---------------------------------------------------------------- categories

const categoryTranslationSchema = z.object({ locale: z.string().min(2), name: z.string().min(1).max(200), slug: slug.optional(), description: z.string().nullable().optional() });
const categoryCreateSchema = z.object({
  parentId: z.uuid().nullable().optional(),
  translations: z.array(categoryTranslationSchema).min(1),
  /** Index among its siblings; default last. */
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().default(true),
});

/** The children of `parentId` (null: the roots) in display order. */
const categoryLevel = (db: Database, parentId: string | null) =>
  db
    .select({ id: categories.id, position: categories.position })
    .from(categories)
    .where(parentId ? eq(categories.parentId, parentId) : sql`${categories.parentId} is null`)
    .orderBy(asc(categories.position), asc(categories.id));

/** Renumber a level 0, 1, 2… after a category moved away from it or was deleted. */
const closeCategoryGap = async (db: Database, parentId: string | null) => {
  for (const [i, sibling] of (await categoryLevel(db, parentId)).entries()) {
    if (sibling.position !== i) await db.update(categories).set({ position: i }).where(eq(categories.id, sibling.id));
  }
};

/**
 * Renumber `parentId`'s other children around `position` (default last) and return the index;
 * the caller writes it to the category.
 */
const placeAmongSiblings = async (db: Database, id: string, parentId: string | null, position?: number) => {
  const siblings = (await categoryLevel(db, parentId)).filter((s) => s.id !== id);
  const index = Math.max(0, Math.min(position ?? siblings.length, siblings.length));
  for (const [i, sibling] of siblings.entries()) {
    const wanted = i < index ? i : i + 1;
    if (sibling.position !== wanted) await db.update(categories).set({ position: wanted }).where(eq(categories.id, sibling.id));
  }
  return index;
};

const upsertCategoryTranslations = async (db: Database, categoryId: string, translations: z.output<typeof categoryTranslationSchema>[]) => {
  const existing = await db.select().from(categoryTranslations).where(eq(categoryTranslations.categoryId, categoryId));
  for (const t of translations) {
    const desired = await uniqueSlug(db, categoryTranslations, t.locale, t.slug ?? slugify(t.name), categoryId);
    const values = { categoryId, locale: t.locale, name: t.name, slug: desired, description: t.description ?? null };
    await db.insert(categoryTranslations).values(values).onConflictDoUpdate({ target: [categoryTranslations.categoryId, categoryTranslations.locale], set: values });
    const current = existing.find((e) => e.locale === t.locale);
    if (current && current.slug !== desired) await recordRedirect(db, current.slug, desired);
  }
};

const productIdsInCategories = async (db: Database, categoryIds: string[]) =>
  categoryIds.length === 0
    ? []
    : [...new Set((await db.select({ productId: productCategories.productId }).from(productCategories).where(inArray(productCategories.categoryId, categoryIds))).map((r) => r.productId))];

export const createCategory = async (db: Database, input: unknown): Promise<Category> =>
  db.transaction(async (tx) => {
    const data = parseInput(categoryCreateSchema, input);
    const parent = data.parentId ? await tx.query.categories.findFirst({ where: eq(categories.id, data.parentId) }) : null;
    if (data.parentId && !parent) throw new ValidationError("Unknown parent", [{ path: ["input", "parentId"], message: "No such category" }]);
    const [row] = await tx
      .insert(categories)
      .values({ parentId: parent?.id ?? null, path: "/", depth: parent ? parent.depth + 1 : 0, position: 0, isActive: data.isActive })
      .returning();
    const position = await placeAmongSiblings(tx, row!.id, parent?.id ?? null, data.position);
    const [category] = await tx
      .update(categories)
      .set({ path: `${parent?.path ?? "/"}${row!.id}/`, position })
      .where(eq(categories.id, row!.id))
      .returning();
    await upsertCategoryTranslations(tx, row!.id, data.translations);
    await emit(tx, { type: "category.created", aggregateType: "Category", aggregateId: row!.id });
    return category!;
  });

export const updateCategory = async (db: Database, id: string, input: unknown): Promise<Category> =>
  db.transaction(async (tx) => {
    const category = await tx.query.categories.findFirst({ where: eq(categories.id, id) });
    if (!category) throw new NotFoundError("Category", id);
    const data = parseInput(patchSchema(categoryCreateSchema.omit({ parentId: true })), input);
    const position = data.position === undefined ? category.position : await placeAmongSiblings(tx, id, category.parentId, data.position);
    const [updated] = await tx
      .update(categories)
      .set({ position, isActive: data.isActive ?? category.isActive, updatedAt: new Date() })
      .where(eq(categories.id, id))
      .returning();
    if (data.translations) await upsertCategoryTranslations(tx, id, data.translations);
    await emit(tx, { type: "category.updated", aggregateType: "Category", aggregateId: id });
    return updated!;
  });

/** Rewrites the subtree's paths and places the category at `position` (default last). */
export const moveCategory = async (db: Database, id: string, parentId: string | null, position?: number): Promise<Category> =>
  db.transaction(async (tx) => {
    const category = await tx.query.categories.findFirst({ where: eq(categories.id, id) });
    if (!category) throw new NotFoundError("Category", id);
    const parent = parentId ? await tx.query.categories.findFirst({ where: eq(categories.id, parentId) }) : null;
    if (parentId && !parent) throw new ValidationError("Unknown parent", [{ path: ["parentId"], message: "No such category" }]);
    if (parent && parent.path.startsWith(category.path)) {
      throw new ValidationError("Cannot move a category into its own subtree", [{ path: ["parentId"], message: "Would create a cycle" }]);
    }
    const newPath = `${parent?.path ?? "/"}${id}/`;
    const depthShift = (parent ? parent.depth + 1 : 0) - category.depth;
    await tx
      .update(categories)
      .set({
        path: sql`${newPath} || substr(${categories.path}, ${category.path.length + 1})`,
        depth: sql`${categories.depth} + ${depthShift}`,
      })
      .where(like(categories.path, `${category.path}%`));
    const index = await placeAmongSiblings(tx, id, parent?.id ?? null, position);
    const [moved] = await tx
      .update(categories)
      .set({ parentId: parent?.id ?? null, position: index, updatedAt: new Date() })
      .where(eq(categories.id, id))
      .returning();
    if (category.parentId !== (parent?.id ?? null)) await closeCategoryGap(tx, category.parentId);
    await reindexProducts(tx, await productIdsInCategories(tx, await getDescendantCategoryIds(tx, moved!)));
    await emit(tx, { type: "category.updated", aggregateType: "Category", aggregateId: id });
    return moved!;
  });

export const deleteCategory = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const category = await tx.query.categories.findFirst({ where: eq(categories.id, id) });
    if (!category) throw new NotFoundError("Category", id);
    const affected = await productIdsInCategories(tx, await getDescendantCategoryIds(tx, category));
    await tx.delete(categories).where(like(categories.path, `${category.path}%`));
    await closeCategoryGap(tx, category.parentId);
    await reindexProducts(tx, affected);
    await emit(tx, { type: "category.deleted", aggregateType: "Category", aggregateId: id });
    return id;
  });

// ---------------------------------------------------------------- admin maintenance

/** Attributes used by a product type must be removed from it first. */
export const deleteAttributeDefinition = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const definition = await tx.query.attributeDefinitions.findFirst({ where: eq(attributeDefinitions.id, id) });
    if (!definition) throw new NotFoundError("AttributeDefinition", id);
    const usedBy = (await tx.select().from(productTypes)).filter((t) => t.attributeCodes.includes(definition.code) || t.variantAttributeCodes.includes(definition.code));
    if (usedBy.length) throw new InvalidStateError(`Used by product types: ${usedBy.map((t) => t.code).join(", ")}`);
    await tx.delete(attributeDefinitions).where(eq(attributeDefinitions.id, id));
    return id;
  });

export const deleteProductType = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const type = await tx.query.productTypes.findFirst({ where: eq(productTypes.id, id) });
    if (!type) throw new NotFoundError("ProductType", id);
    const [{ count }] = (await tx.select({ count: sql<number>`count(*)::int` }).from(products).where(eq(products.productTypeId, id))) as [{ count: number }];
    if (count > 0) throw new InvalidStateError(`${count} product(s) use the ${type.code} type`);
    await tx.delete(productTypes).where(eq(productTypes.id, id));
    return id;
  });

const MAX_BULK = 500;
const bulkIds = (ids: string[], path = ["ids"]) => parseInput(z.array(z.uuid()).min(1).max(MAX_BULK), [...new Set(ids)], path);

const bulkUpdateSchema = z.object({
  status: z.enum(PRODUCT_STATUSES).optional(),
  addCategoryIds: z.array(z.uuid()).default([]),
  removeCategoryIds: z.array(z.uuid()).default([]),
  /** Upserted per channel; listings in other channels are left alone. */
  channelListings: z.array(listingSchema).default([]),
  /** Merged into each product and validated against its type. */
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const bulkUpdateProducts = async (db: Database, idsInput: string[], input: unknown): Promise<Product[]> =>
  db.transaction(async (tx) => {
    const ids = bulkIds(idsInput);
    const data = parseInput(bulkUpdateSchema, input);
    const found = await tx.select({ id: products.id }).from(products).where(inArray(products.id, ids));
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new NotFoundError("Product", missing.join(", "));
    if (data.status) await tx.update(products).set({ status: data.status, updatedAt: new Date() }).where(inArray(products.id, ids));
    if (data.addCategoryIds.length) {
      const known = await tx.select({ id: categories.id }).from(categories).where(inArray(categories.id, data.addCategoryIds));
      const unknown = data.addCategoryIds.filter((id) => !known.some((k) => k.id === id));
      if (unknown.length) throw new ValidationError("Unknown categories", unknown.map((id) => ({ path: ["input", "addCategoryIds"], message: `No category ${id}` })));
      await tx.insert(productCategories).values(ids.flatMap((productId) => data.addCategoryIds.map((categoryId) => ({ productId, categoryId })))).onConflictDoNothing();
    }
    if (data.removeCategoryIds.length) {
      await tx.delete(productCategories).where(and(inArray(productCategories.productId, ids), inArray(productCategories.categoryId, data.removeCategoryIds)));
    }
    for (const listing of data.channelListings) {
      await tx
        .insert(productChannelListings)
        .values(ids.map((productId) => ({ productId, ...listing, publishedAt: listing.isPublished ? new Date() : null })))
        .onConflictDoUpdate({
          target: [productChannelListings.productId, productChannelListings.channelId],
          set: {
            isPublished: listing.isPublished,
            visibleInListings: listing.visibleInListings,
            publishedAt: listing.isPublished ? sql`coalesce(${productChannelListings.publishedAt}, now())` : null,
          },
        });
    }
    if (data.attributes) {
      for (const product of await tx.select().from(products).where(inArray(products.id, ids))) {
        await tx.update(products).set({ attributes: await mergeAttributes(tx, product, data.attributes, { mergeLocales: true }), updatedAt: new Date() }).where(eq(products.id, product.id));
      }
    }
    await reindexProducts(tx, ids);
    await emit(tx, ...ids.map((id) => ({ type: "product.updated" as const, aggregateType: "Product", aggregateId: id })));
    return tx.select().from(products).where(inArray(products.id, ids));
  });

export const bulkDeleteProducts = async (db: Database, idsInput: string[]) =>
  db.transaction(async (tx) => {
    const ids = bulkIds(idsInput);
    const deleted = await tx.delete(products).where(inArray(products.id, ids)).returning({ id: products.id });
    await emit(tx, ...deleted.map((d) => ({ type: "product.deleted" as const, aggregateType: "Product", aggregateId: d.id })));
    return deleted.map((d) => d.id);
  });

const freeSku = async (db: Database, base: string) => {
  const taken = new Set((await db.select({ sku: productVariants.sku }).from(productVariants).where(like(productVariants.sku, `${base}%`))).map((r) => r.sku));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

/** Copy a product as an unpublished draft with new SKUs and slugs, and no stock. */
export const duplicateProduct = async (db: Database, id: string): Promise<Product> =>
  db.transaction(async (tx) => {
    const source = await tx.query.products.findFirst({ where: eq(products.id, id) });
    if (!source) throw new NotFoundError("Product", id);
    const [copy] = await tx.insert(products).values({ productTypeId: source.productTypeId, status: "draft", attributes: source.attributes, taxClassId: source.taxClassId }).returning();
    for (const t of await tx.select().from(productTranslations).where(eq(productTranslations.productId, id))) {
      const slugValue = await uniqueSlug(tx, productTranslations, t.locale, `${t.slug}-copy`, copy!.id);
      await tx.insert(productTranslations).values({ ...t, productId: copy!.id, name: `${t.name} (copy)`, slug: slugValue });
    }
    const variants = await tx.select().from(productVariants).where(eq(productVariants.productId, id)).orderBy(productVariants.position);
    const variantIds = new Map<string, string>();
    for (const v of variants) {
      const { id: oldId, createdAt: _c, updatedAt: _u, ...rest } = v;
      const [inserted] = await tx.insert(productVariants).values({ ...rest, productId: copy!.id, sku: await freeSku(tx, `${v.sku}-copy`) }).returning({ id: productVariants.id });
      variantIds.set(oldId, inserted!.id);
    }
    const prices = variants.length ? await tx.select().from(variantPrices).where(inArray(variantPrices.variantId, [...variantIds.keys()])) : [];
    if (prices.length) {
      await tx.insert(variantPrices).values(prices.map(({ id: _id, createdAt: _c, updatedAt: _u, ...p }) => ({ ...p, variantId: variantIds.get(p.variantId)! })));
    }
    const media = await tx.select().from(productMedia).where(eq(productMedia.productId, id));
    if (media.length) {
      await tx.insert(productMedia).values(media.map(({ id: _id, createdAt: _c, ...m }) => ({ ...m, productId: copy!.id, variantId: m.variantId ? (variantIds.get(m.variantId) ?? null) : null })));
    }
    const links = await tx.select().from(productCategories).where(eq(productCategories.productId, id));
    if (links.length) await tx.insert(productCategories).values(links.map((l) => ({ ...l, productId: copy!.id })));
    const listings = await tx.select().from(productChannelListings).where(eq(productChannelListings.productId, id));
    if (listings.length) await tx.insert(productChannelListings).values(listings.map((l) => ({ ...l, productId: copy!.id, isPublished: false, publishedAt: null })));
    await reindexProducts(tx, [copy!.id]);
    await emit(tx, { type: "product.created", aggregateType: "Product", aggregateId: copy!.id });
    return copy!;
  });

/** All categories depth first in position order, optionally only those whose name matches. */
export const listCategoriesFlat = async (db: Database, query?: string | null) => {
  const all = await db.select().from(categories).orderBy(asc(categories.position), asc(categories.id));
  const byParent = new Map<string | null, Category[]>();
  for (const c of all) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const ordered: Category[] = [];
  const walk = (parentId: string | null) => {
    for (const c of byParent.get(parentId) ?? []) {
      ordered.push(c);
      walk(c.id);
    }
  };
  walk(null);
  if (!query?.trim()) return ordered;
  const pattern = `%${query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const matching = new Set((await db.select({ id: categoryTranslations.categoryId }).from(categoryTranslations).where(ilike(categoryTranslations.name, pattern))).map((r) => r.id));
  return ordered.filter((c) => matching.has(c.id));
};

// ---------------------------------------------------------------- redirects

const pathSchema = z.string().trim().regex(/^\/[^\s?#]*$/, "Start with / and leave out the domain and query string").max(500);
const redirectSchema = z.object({
  fromPath: pathSchema,
  toPath: z.union([pathSchema, z.url().max(1000)]),
  statusCode: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(301),
});

export const listRedirects = async (db: Database, filter: { query?: string | null }, page: { limit: number; offset: number }) => {
  const where = filter.query ? or(ilike(redirects.fromPath, `%${filter.query}%`), ilike(redirects.toPath, `%${filter.query}%`)) : undefined;
  const rows = await db.select().from(redirects).where(where).orderBy(asc(redirects.fromPath)).limit(page.limit).offset(page.offset);
  const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(redirects).where(where)) as [{ total: number }];
  return { rows, total };
};

export const createRedirect = async (db: Database, input: unknown) => {
  const data = parseInput(redirectSchema, input, ["input"]);
  if (data.fromPath === data.toPath) throw new ValidationError("A redirect cannot point at itself", [{ path: ["input", "toPath"], message: "Use a different target" }]);
  if (await db.query.redirects.findFirst({ where: eq(redirects.fromPath, data.fromPath) })) {
    throw new ValidationError("Path already redirected", [{ path: ["input", "fromPath"], message: `${data.fromPath} already has a redirect` }]);
  }
  const [row] = await db.insert(redirects).values(data).returning();
  return row!;
};

export const deleteRedirect = async (db: Database, id: string) => {
  const [row] = await db.delete(redirects).where(eq(redirects.id, id)).returning({ id: redirects.id });
  if (!row) throw new NotFoundError("Redirect", id);
  return id;
};

// ---------------------------------------------------------------- variant search

export type VariantSearchFilter = { query?: string | null; productId?: string | null; maxOnHand?: number | null; trackInventory?: boolean | null };

/** SKU, barcode or product-name search across variants, for inventory screens and order entry. */
export const searchVariants = async (db: Database, filter: VariantSearchFilter, page: { limit: number; offset: number }) => {
  const conditions = [];
  if (filter.query?.trim()) {
    const q = `%${filter.query.trim()}%`;
    conditions.push(
      or(
        ilike(productVariants.sku, q),
        ilike(productVariants.barcode, q),
        sql`exists (select 1 from product_translations t where t.product_id = ${productVariants.productId} and t.name ilike ${q})`,
      ),
    );
  }
  if (filter.productId) conditions.push(eq(productVariants.productId, filter.productId));
  if (filter.trackInventory != null) conditions.push(eq(productVariants.trackInventory, filter.trackInventory));
  if (filter.maxOnHand != null) {
    conditions.push(sql`(select coalesce(sum(s.quantity), 0) from stock_levels s where s.variant_id = ${productVariants.id}) <= ${filter.maxOnHand}`);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db.select().from(productVariants).where(where).orderBy(asc(productVariants.sku)).limit(page.limit).offset(page.offset);
  const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(productVariants).where(where)) as [{ total: number }];
  return { rows, total };
};
