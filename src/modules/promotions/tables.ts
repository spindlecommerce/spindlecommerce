import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt, uuidArray } from "../../db/columns.ts";
import { customers } from "../customers/tables.ts";
import type { Action, Condition } from "./rules.ts";

/** Empty channel and group arrays mean all. */
export const promotions = pgTable(
  "promotions",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    channelIds: uuidArray("channel_ids"),
    customerGroupIds: uuidArray("customer_group_ids"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Lower runs first. */
    priority: integer("priority").notNull().default(0),
    stopFurtherRules: boolean("stop_further_rules").notNull().default(false),
    requiresCoupon: boolean("requires_coupon").notNull().default(false),
    conditions: jsonb("conditions").$type<Condition>().notNull().default(sql`'{"type":"all","conditions":[]}'::jsonb`),
    action: jsonb("action").$type<Action>().notNull(),
    usageLimit: integer("usage_limit"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    timesUsed: integer("times_used").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("promotions_active_idx").on(t.isActive, t.priority)],
);

export const coupons = pgTable(
  "coupons",
  {
    id: id(),
    promotionId: uuid("promotion_id").notNull().references(() => promotions.id, { onDelete: "cascade" }),
    /** Stored uppercased; matching is case-insensitive. */
    code: text("code").notNull(),
    usageLimit: integer("usage_limit"),
    timesUsed: integer("times_used").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("coupons_code_uq").on(t.code), index("coupons_promotion_idx").on(t.promotionId)],
);

export const promotionUsages = pgTable(
  "promotion_usages",
  {
    id: id(),
    promotionId: uuid("promotion_id").notNull().references(() => promotions.id, { onDelete: "cascade" }),
    couponId: uuid("coupon_id").references(() => coupons.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    orderId: uuid("order_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("promotion_usages_customer_idx").on(t.promotionId, t.customerId)],
);
