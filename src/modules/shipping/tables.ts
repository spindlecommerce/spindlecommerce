import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, localized, textArray, updatedAt, uuidArray } from "../../db/columns.ts";
import { taxClasses } from "../tax/tables.ts";

export const shippingZones = pgTable("shipping_zones", {
  id: id(),
  name: text("name").notNull(),
  countries: textArray("countries"),
  createdAt: createdAt(),
});

export type FlatRateConfig = { kind: "flat_rate"; amounts: Record<string, number>; per: "order" | "item" };
export type TableRateConfig = {
  kind: "table_rate";
  basis: "weight" | "subtotal" | "quantity";
  /** The tier with the highest `from` the basis reaches applies. Weight in grams. */
  tiers: { from: number; amounts: Record<string, number> }[];
};
export type FreeShippingConfig = { kind: "free"; minimumSubtotals: Record<string, number> };
export type BuiltInShippingConfig = FlatRateConfig | TableRateConfig | FreeShippingConfig;
/** `kind` is a plugin provider's code; `options` holds values for its methodOptions. */
export type ProviderShippingConfig = { kind: string; options: Record<string, unknown> };
export type ShippingMethodConfig = BuiltInShippingConfig | ProviderShippingConfig;

export const shippingMethods = pgTable("shipping_methods", {
  id: id(),
  code: text("code").notNull().unique(),
  name: localized("name"),
  description: localized("description"),
  zoneId: uuid("zone_id").notNull().references(() => shippingZones.id, { onDelete: "cascade" }),
  channelIds: uuidArray("channel_ids"),
  config: jsonb("config").$type<ShippingMethodConfig>().notNull(),
  minDeliveryDays: integer("min_delivery_days"),
  maxDeliveryDays: integer("max_delivery_days"),
  taxClassId: uuid("tax_class_id").references(() => taxClasses.id),
  isActive: boolean("is_active").notNull().default(true),
  position: integer("position").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Live rates by rateCacheKey, so cart reads and checkout do not call the carrier each time. */
export const shippingRateCache = pgTable(
  "shipping_rate_cache",
  {
    key: text("key").primaryKey(),
    rates: jsonb("rates").$type<unknown[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("shipping_rate_cache_expires_idx").on(t.expiresAt)],
);
