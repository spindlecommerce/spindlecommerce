import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tsvector, uuidArray } from "../../db/columns.ts";
import { products } from "../catalog/tables.ts";
import { channels } from "../channels/tables.ts";

/** One row per published product, channel and locale, kept current in each write's transaction. */
export const productSearch = pgTable(
  "product_search",
  {
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    document: tsvector("document").notNull(),
    /** Filterable attribute values across product and variants: `{ color: ["red","blue"] }`. */
    facets: jsonb("facets").$type<Record<string, string[]>>().notNull().default(sql`'{}'::jsonb`),
    /** Assigned categories plus all their ancestors, so a parent category matches descendants. */
    categoryIds: uuidArray("category_ids"),
    /** Where category listings pin the product (category_merchandising): `{ <category id>: 0 }`. */
    pinPositions: jsonb("pin_positions").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    hiddenInCategoryIds: uuidArray("hidden_in_category_ids"),
    /** Base price range per currency in minor units: `{ USD: { min: 1999, max: 2999 } }`. */
    prices: jsonb("prices").$type<Record<string, { min: number; max: number }>>().notNull().default(sql`'{}'::jsonb`),
    inStock: boolean("in_stock").notNull().default(false),
    visibleInListings: boolean("visible_in_listings").notNull().default(true),
    productCreatedAt: timestamp("product_created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.channelId, t.locale] }),
    index("product_search_document_gin").using("gin", t.document),
    index("product_search_facets_gin").using("gin", t.facets),
    index("product_search_categories_gin").using("gin", t.categoryIds),
  ],
);
