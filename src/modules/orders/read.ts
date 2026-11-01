import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { NotFoundError } from "../../lib/errors.ts";
import type { PluginOrder } from "../../plugins/sdk.ts";
import { fulfillments, invoices, orderEvents, orderLines, orders, refunds, type FulfillmentStatus, type OrderStatus, type PaymentStatus } from "./tables.ts";

export type Order = typeof orders.$inferSelect;
export type OrderLine = typeof orderLines.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Fulfillment = typeof fulfillments.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type OrderEvent = typeof orderEvents.$inferSelect;

export const getOrder = async (db: Database, id: string): Promise<Order> => {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id) });
  if (!order) throw new NotFoundError("Order", id);
  return order;
};

export const findOrderByNumber = (db: Database, number: string) => db.query.orders.findFirst({ where: eq(orders.number, number) });

export const getOrdersByIds = (db: Database, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(orders).where(inArray(orders.id, [...ids]));

const byOrder = async <T extends { orderId: string }>(rows: Promise<T[]>) => {
  const map = new Map<string, T[]>();
  for (const row of await rows) map.set(row.orderId, [...(map.get(row.orderId) ?? []), row]);
  return map;
};

export const getLinesByOrderIds = (db: Database, ids: readonly string[]) =>
  byOrder(ids.length ? db.select().from(orderLines).where(inArray(orderLines.orderId, [...ids])).orderBy(asc(orderLines.position)) : Promise.resolve([]));
export const getInvoicesByOrderIds = (db: Database, ids: readonly string[]) =>
  byOrder(ids.length ? db.select().from(invoices).where(inArray(invoices.orderId, [...ids])).orderBy(asc(invoices.id)) : Promise.resolve([]));
export const getFulfillmentsByOrderIds = (db: Database, ids: readonly string[]) =>
  byOrder(ids.length ? db.select().from(fulfillments).where(inArray(fulfillments.orderId, [...ids])).orderBy(asc(fulfillments.id)) : Promise.resolve([]));
export const getRefundsByOrderIds = (db: Database, ids: readonly string[]) =>
  byOrder(ids.length ? db.select().from(refunds).where(inArray(refunds.orderId, [...ids])).orderBy(asc(refunds.id)) : Promise.resolve([]));
export const getEventsByOrderIds = (db: Database, ids: readonly string[]) =>
  byOrder(ids.length ? db.select().from(orderEvents).where(inArray(orderEvents.orderId, [...ids])).orderBy(asc(orderEvents.id)) : Promise.resolve([]));

export const toPluginOrder = async (db: Database, order: Order): Promise<PluginOrder> => {
  const lines = (await getLinesByOrderIds(db, [order.id])).get(order.id) ?? [];
  const shipped = (await getFulfillmentsByOrderIds(db, [order.id])).get(order.id) ?? [];
  return {
    id: order.id,
    number: order.number,
    channelId: order.channelId,
    customerId: order.customerId,
    email: order.email,
    locale: order.locale,
    currency: order.currency,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    shippingTotal: order.shippingTotal,
    taxTotal: order.taxTotal,
    grandTotal: order.grandTotal,
    pricesIncludeTax: order.pricesIncludeTax,
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    shippingMethod: order.shippingMethod,
    paymentMethodCode: order.paymentMethodCode,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      variantId: l.variantId,
      sku: l.sku,
      name: l.name,
      variantAttributes: l.variantAttributes,
      quantity: l.quantity,
      quantityFulfilled: l.quantityFulfilled,
      unitPrice: l.unitPrice,
      total: l.total,
      weightGrams: l.weightGrams,
      isShippable: l.isShippable,
    })),
    fulfillments: shipped.map((f) => ({ id: f.id, number: f.number, tracking: f.tracking, lines: f.lines, createdAt: f.createdAt })),
    couponCodes: order.couponCodes ?? [],
    metadata: order.metadata,
    createdAt: order.createdAt,
  };
};

export const getPluginOrder = async (db: Database, id: string): Promise<PluginOrder | null> => {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id) });
  return order ? toPluginOrder(db, order) : null;
};

export type OrderFilter = {
  customerId?: string | null;
  channelId?: string | null;
  status?: OrderStatus | null;
  paymentStatus?: PaymentStatus | null;
  fulfillmentStatus?: FulfillmentStatus | null;
  placedAfter?: Date | null;
  placedBefore?: Date | null;
  query?: string | null;
};

/** Keyset pagination on the time-ordered id, newest first. */
export const listOrders = async (db: Database, filter: OrderFilter, page: { limit: number; afterId?: string | null }) => {
  const where: SQL[] = [];
  if (filter.customerId) where.push(eq(orders.customerId, filter.customerId));
  if (filter.channelId) where.push(eq(orders.channelId, filter.channelId));
  if (filter.status) where.push(eq(orders.status, filter.status));
  if (filter.paymentStatus) where.push(eq(orders.paymentStatus, filter.paymentStatus));
  if (filter.fulfillmentStatus) where.push(eq(orders.fulfillmentStatus, filter.fulfillmentStatus));
  if (filter.placedAfter) where.push(gte(orders.placedAt, filter.placedAfter));
  if (filter.placedBefore) where.push(lte(orders.placedAt, filter.placedBefore));
  if (filter.query) {
    const pattern = `%${filter.query.replace(/[%_]/g, "\\$&")}%`;
    where.push(or(ilike(orders.number, pattern), ilike(orders.email, pattern))!);
  }
  const total = await db.$count(orders, where.length ? and(...where) : undefined);
  if (page.afterId) where.push(lt(orders.id, page.afterId));
  const rows = await db.select().from(orders).where(where.length ? and(...where) : undefined).orderBy(desc(orders.id)).limit(page.limit);
  return { rows, total };
};
