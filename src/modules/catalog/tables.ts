import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createdAt, id, localized, textArray, updatedAt } from "../../db/columns.ts";
import type { LocalizedText } from "../../lib/i18n.ts";
import { channels } from "../channels/tables.ts";
import { taxClasses } from "../tax/tables.ts";

export const ATTRIBUTE_TYPES = ["text", "rich_text", "number", "boolean", "select", "multiselect", "date"] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];
export type AttributeOption = { code: string; label: LocalizedText; swatch?: string | null };
/** Scalars, option codes, or per-locale text when the attribute is localized. */
export type AttributeValue = string | number | boolean | string[] | LocalizedText;

export const attributeDefinitions = pgTable("attribute_definitions", {
  id: id(),
  code: text("code").notNull().unique(),
  label: localized("label"),
  type: text("type").$type<AttributeType>().notNull(),
  isLocalized: boolean("is_localized").notNull().default(false),
  isFilterable: boolean("is_filterable").notNull().default(false),
  isSearchable: boolean("is_searchable").notNull().default(false),
  isRequired: boolean("is_required").notNull().default(false),
  options: jsonb("options").$type<AttributeOption[]>().notNull().default(sql`'[]'::jsonb`),
  unit: text("unit"),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Which attributes a product has and which axes its variants use. */
export const productTypes = pgTable("product_types", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  attributeCodes: textArray("attribute_codes"),
  variantAttributeCodes: textArray("variant_attribute_codes"),
  isShippable: boolean("is_shippable").notNull().default(true),
  taxClassId: uuid("tax_class_id").references(() => taxClasses.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const products = pgTable(
  "products",
  {
    id: id(),
    productTypeId: uuid("product_type_id").notNull().references(() => productTypes.id),
    status: text("status").$type<ProductStatus>().notNull().default("draft"),
    attributes: jsonb("attributes").$type<Record<string, AttributeValue>>().notNull().default(sql`'{}'::jsonb`),
    taxClassId: uuid("tax_class_id").references(() => taxClasses.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("products_status_idx").on(t.status), index("products_attributes_gin").using("gin", t.attributes)],
);

export const productTranslations = pgTable(
  "product_translations",
  {
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
  },
  (t) => [primaryKey({ columns: [t.productId, t.locale] }), uniqueIndex("product_translations_slug_uq").on(t.locale, t.slug)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    sku: text("sku").notNull().unique(),
    attributes: jsonb("attributes").$type<Record<string, AttributeValue>>().notNull().default(sql`'{}'::jsonb`),
    position: integer("position").notNull().default(0),
    weightGrams: integer("weight_grams"),
    barcode: text("barcode"),
    isActive: boolean("is_active").notNull().default(true),
    trackInventory: boolean("track_inventory").notNull().default(true),
    allowBackorder: boolean("allow_backorder").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("product_variants_product_idx").on(t.productId), index("product_variants_attributes_gin").using("gin", t.attributes)],
);

export const productMedia = pgTable(
  "product_media",
  {
    id: id(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"image" | "video">().notNull().default("image"),
    url: text("url").notNull(),
    alt: localized("alt"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("product_media_product_idx").on(t.productId)],
);

export const categories = pgTable(
  "categories",
  {
    id: id(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, { onDelete: "cascade" }),
    /** Materialized path of ancestor ids including self, e.g. `/a/b/c/`. */
    path: text("path").notNull(),
    depth: integer("depth").notNull().default(0),
    position: integer("position").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("categories_parent_idx").on(t.parentId), index("categories_path_idx").on(t.path.op("text_pattern_ops"))],
);

export const categoryTranslations = pgTable(
  "category_translations",
  {
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.locale] }), uniqueIndex("category_translations_slug_uq").on(t.locale, t.slug)],
);

export const productCategories = pgTable(
  "product_categories",
  {
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.categoryId] }), index("product_categories_category_idx").on(t.categoryId)],
);

/**
 * Pinned and hidden products in a category's listing. Keyed by the listing's category, so a parent
 * can pin or hide a product from a subcategory.
 */
export const categoryMerchandising = pgTable(
  "category_merchandising",
  {
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    /** Order among the category's pinned products; null for a hidden product. */
    pinPosition: integer("pin_position"),
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.productId] }), index("category_merchandising_product_idx").on(t.productId)],
);

/** Whether a product is sold in a channel. */
export const productChannelListings = pgTable(
  "product_channel_listings",
  {
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    isPublished: boolean("is_published").notNull().default(true),
    visibleInListings: boolean("visible_in_listings").notNull().default(true),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.channelId] })],
);

/** SEO redirects; created automatically when a slug changes. */
export const redirects = pgTable(
  "redirects",
  {
    id: id(),
    fromPath: text("from_path").notNull(),
    toPath: text("to_path").notNull(),
    statusCode: integer("status_code").notNull().default(301),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("redirects_from_uq").on(t.fromPath)],
);
