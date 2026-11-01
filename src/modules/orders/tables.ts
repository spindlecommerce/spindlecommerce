import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, money, textArray, updatedAt } from "../../db/columns.ts";
import type { Address } from "../../lib/address.ts";
import type { ShippingRateDetails } from "../../plugins/sdk.ts";
import { channels } from "../channels/tables.ts";
import { customers } from "../customers/tables.ts";

export type OrderStatus = "open" | "completed" | "canceled";
export type PaymentStatus = "pending" | "authorized" | "partially_paid" | "paid" | "partially_refunded" | "refunded" | "voided";
export type FulfillmentStatus = "unfulfilled" | "partially_fulfilled" | "fulfilled";

export type OrderTotalsBreakdown = {
  taxLines: { name: string; rate: number; amount: number }[];
  discounts: { promotionId: string; name: string; couponCode: string | null; amount: number }[];
  shippingDiscount: number;
};

/** `details`: provider, method and rate, for providers that book shipments. */
export type OrderShippingMethod = { code: string; name: string; carrier: string; amount: number; details?: ShippingRateDetails | null };

export const orders = pgTable(
  "orders",
  {
    id: id(),
    number: text("number").notNull(),
    channelId: uuid("channel_id").notNull().references(() => channels.id),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    cartId: uuid("cart_id"),
    email: text("email").notNull(),
    status: text("status").$type<OrderStatus>().notNull().default("open"),
    paymentStatus: text("payment_status").$type<PaymentStatus>().notNull().default("pending"),
    fulfillmentStatus: text("fulfillment_status").$type<FulfillmentStatus>().notNull().default("unfulfilled"),
    currency: text("currency").notNull(),
    locale: text("locale").notNull(),
    customerGroupId: uuid("customer_group_id"),
    shippingAddress: jsonb("shipping_address").$type<Address>(),
    billingAddress: jsonb("billing_address").$type<Address>().notNull(),
    shippingMethod: jsonb("shipping_method").$type<OrderShippingMethod>(),
    paymentMethodCode: text("payment_method_code").notNull(),
    pricesIncludeTax: boolean("prices_include_tax").notNull(),
    subtotal: money("subtotal").notNull(),
    discountTotal: money("discount_total").notNull(),
    shippingTotal: money("shipping_total").notNull(),
    taxTotal: money("tax_total").notNull(),
    grandTotal: money("grand_total").notNull(),
    amountAuthorized: money("amount_authorized").notNull().default(0),
    amountCaptured: money("amount_captured").notNull().default(0),
    amountRefunded: money("amount_refunded").notNull().default(0),
    totals: jsonb("totals").$type<OrderTotalsBreakdown>().notNull(),
    couponCodes: textArray("coupon_codes"),
    idempotencyKey: text("idempotency_key"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_number_uq").on(t.number),
    uniqueIndex("orders_idempotency_uq").on(t.idempotencyKey),
    index("orders_customer_idx").on(t.customerId, t.placedAt),
    index("orders_placed_idx").on(t.placedAt),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id"),
    productId: uuid("product_id"),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    variantAttributes: jsonb("variant_attributes").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    quantity: integer("quantity").notNull(),
    quantityFulfilled: integer("quantity_fulfilled").notNull().default(0),
    quantityRefunded: integer("quantity_refunded").notNull().default(0),
    quantityCanceled: integer("quantity_canceled").notNull().default(0),
    unitPrice: money("unit_price").notNull(),
    subtotal: money("subtotal").notNull(),
    discountTotal: money("discount_total").notNull(),
    taxTotal: money("tax_total").notNull(),
    total: money("total").notNull(),
    taxRate: numeric("tax_rate", { precision: 9, scale: 4 }).notNull().default("0"),
    isShippable: boolean("is_shippable").notNull().default(true),
    weightGrams: integer("weight_grams"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("order_lines_order_idx").on(t.orderId)],
);

export type DocumentLine = { orderLineId: string; quantity: number };

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    amount: money("amount").notNull(),
    transactionId: uuid("transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invoices_number_uq").on(t.number), index("invoices_order_idx").on(t.orderId)],
);

export type TrackingNumber = { carrier: string; number: string; url?: string | null };
export type FulfillmentShipment = { provider: string; labelUrl: string | null; cost: { amount: number; currency: string } | null; data: Record<string, unknown> };

export const fulfillments = pgTable(
  "fulfillments",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    locationId: uuid("location_id").notNull(),
    status: text("status").$type<"shipped" | "delivered">().notNull().default("shipped"),
    tracking: jsonb("tracking").$type<TrackingNumber[]>().notNull().default(sql`'[]'::jsonb`),
    lines: jsonb("lines").$type<DocumentLine[]>().notNull(),
    /** Label and cost, when staff booked the shipment with a provider. */
    shipment: jsonb("shipment").$type<FulfillmentShipment>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fulfillments_number_uq").on(t.number), index("fulfillments_order_idx").on(t.orderId)],
);

export type RefundLine = DocumentLine & { amount: number; restock: boolean };

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    number: text("number").notNull(),
    amount: money("amount").notNull(),
    shippingAmount: money("shipping_amount").notNull().default(0),
    reason: text("reason"),
    lines: jsonb("lines").$type<RefundLine[]>().notNull(),
    transactionId: uuid("transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("refunds_number_uq").on(t.number), index("refunds_order_idx").on(t.orderId)],
);

export type ActorType = "customer" | "staff" | "api_key" | "system";

export const orderEvents = pgTable(
  "order_events",
  {
    id: id(),
    orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    actorType: text("actor_type").$type<ActorType>().notNull().default("system"),
    actorId: uuid("actor_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.createdAt)],
);
