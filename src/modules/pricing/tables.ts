import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, money, updatedAt } from "../../db/columns.ts";
import { channels } from "../channels/tables.ts";
import { productVariants } from "../catalog/tables.ts";
import { customerGroups } from "../customers/tables.ts";

/** The list price has no group, tier or dates; group, tier and dated (special) prices narrow it. */
export const variantPrices = pgTable(
  "variant_prices",
  {
    id: id(),
    variantId: uuid("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    amount: money("amount").notNull(),
    compareAtAmount: money("compare_at_amount"),
    costAmount: money("cost_amount"),
    customerGroupId: uuid("customer_group_id").references(() => customerGroups.id, { onDelete: "cascade" }),
    minQuantity: integer("min_quantity").notNull().default(1),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("variant_prices_lookup_idx").on(t.variantId, t.channelId, t.currency)],
);
