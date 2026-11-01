import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, localized, money, textArray, updatedAt, uuidArray } from "../../db/columns.ts";

export type PaymentMethodConfig = {
  /** `authorize`: capture later from the admin API. `authorize_capture`: capture at checkout. */
  captureMode?: "authorize" | "authorize_capture";
  instructions?: Record<string, string>;
  minimumTotals?: Record<string, number>;
  maximumTotals?: Record<string, number>;
};

export const paymentMethods = pgTable("payment_methods", {
  id: id(),
  code: text("code").notNull().unique(),
  name: localized("name"),
  /** Provider code, e.g. `offline` or `test_gateway`. */
  provider: text("provider").notNull(),
  channelIds: uuidArray("channel_ids"),
  countries: textArray("countries"),
  config: jsonb("config").$type<PaymentMethodConfig>().notNull().default(sql`'{}'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type TransactionKind = "authorization" | "capture" | "refund" | "void";

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: id(),
    orderId: uuid("order_id").notNull(),
    paymentMethodCode: text("payment_method_code").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").$type<TransactionKind>().notNull(),
    status: text("status").$type<"succeeded" | "failed" | "pending">().notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    pspReference: text("psp_reference"),
    errorMessage: text("error_message"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Dedupe key, e.g. `stripe:evt_…` for a webhook event, so a redelivery changes nothing. */
    referenceKey: text("reference_key"),
    createdAt: createdAt(),
  },
  (t) => [index("payment_transactions_order_idx").on(t.orderId), uniqueIndex("payment_transactions_reference_uq").on(t.referenceKey)],
);
