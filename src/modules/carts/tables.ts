import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, textArray, updatedAt } from "../../db/columns.ts";
import type { AddressDraft } from "../../lib/address.ts";
import { productVariants } from "../catalog/tables.ts";
import { channels } from "../channels/tables.ts";
import { customers } from "../customers/tables.ts";

export type CartPaymentSession = { provider: string; methodCode: string; amount: number; currency: string; data: Record<string, unknown>; createdAt: string; updatedAt: string };

export const carts = pgTable(
  "carts",
  {
    id: id(),
    channelId: uuid("channel_id").notNull().references(() => channels.id),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    currency: text("currency").notNull(),
    locale: text("locale").notNull(),
    email: text("email"),
    status: text("status").$type<"active" | "converted" | "abandoned">().notNull().default("active"),
    couponCodes: textArray("coupon_codes"),
    /** May be incomplete until checkout. Null billing address: bills to the shipping address. */
    shippingAddress: jsonb("shipping_address").$type<AddressDraft>(),
    billingAddress: jsonb("billing_address").$type<AddressDraft>(),
    shippingMethodCode: text("shipping_method_code"),
    paymentMethodCode: text("payment_method_code"),
    /** The PSP's session for this cart, e.g. a payment intent. Server-side only. */
    paymentSession: jsonb("payment_session").$type<CartPaymentSession>(),
    note: text("note"),
    /** Incremented on every change; mutations can pass it for optimistic concurrency. */
    version: integer("version").notNull().default(0),
    convertedOrderId: uuid("converted_order_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("carts_customer_idx").on(t.customerId, t.status)],
);

export const cartLines = pgTable(
  "cart_lines",
  {
    id: id(),
    cartId: uuid("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cart_lines_variant_uq").on(t.cartId, t.variantId)],
);
