import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "../../db/columns.ts";
import type { Address } from "../../lib/address.ts";
import { productVariants } from "../catalog/tables.ts";

/** A physical place that holds stock. */
export const stockLocations = pgTable("stock_locations", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  address: jsonb("address").$type<Partial<Address>>().notNull().default(sql`'{}'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A virtual aggregate of locations that channels sell from. */
export const stocks = pgTable("stocks", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const stockSources = pgTable(
  "stock_sources",
  {
    stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").notNull().references(() => stockLocations.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.stockId, t.locationId] })],
);

export const stockLevels = pgTable(
  "stock_levels",
  {
    variantId: uuid("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").notNull().references(() => stockLocations.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.locationId] })],
);

/**
 * Append-only. An order inserts a negative row; fulfillment and cancellation insert compensating
 * positive rows. Salable = Σ levels + Σ reservations.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: id(),
    stockId: uuid("stock_id").notNull().references(() => stocks.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    reason: text("reason").$type<"order_placed" | "order_canceled" | "order_fulfilled" | "order_refunded" | "manual">().notNull(),
    referenceId: uuid("reference_id"),
    createdAt: createdAt(),
  },
  (t) => [index("stock_reservations_lookup_idx").on(t.stockId, t.variantId)],
);
