import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { queryRows } from "../../db/query.ts";
import { ValidationError } from "../../lib/errors.ts";

/** Reports read live data. Amounts stay per currency; sums across currencies mean nothing. */
export type ReportRange = { from: Date; to: Date; channelId?: string | null; currency?: string | null; timeZone?: string | null };
export type Granularity = "day" | "week" | "month";

const MAX_RANGE_DAYS = 3 * 366;

/** IANA zone or UTC; also guards the value that reaches SQL. */
export const resolveTimeZone = (timeZone: string | null | undefined): string => {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    throw new ValidationError("Unknown time zone", [{ path: ["timeZone"], message: "Use an IANA zone such as Europe/Berlin" }]);
  }
};

const checkRange = (range: ReportRange) => {
  if (!(range.from < range.to)) throw new ValidationError("Invalid range", [{ path: ["range", "to"], message: "Must be after `from`" }]);
  if (range.to.getTime() - range.from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw new ValidationError("Range too long", [{ path: ["range"], message: `At most ${MAX_RANGE_DAYS} days` }]);
  }
};

const orderScope = (range: ReportRange, alias = "o"): SQL => {
  const o = sql.raw(alias);
  const parts = [sql`${o}.placed_at >= ${range.from.toISOString()}::timestamptz`, sql`${o}.placed_at < ${range.to.toISOString()}::timestamptz`];
  if (range.channelId) parts.push(sql`${o}.channel_id = ${range.channelId}::uuid`);
  if (range.currency) parts.push(sql`${o}.currency = ${range.currency}`);
  return sql.join(parts, sql` and `);
};

const n = (value: unknown) => Number(value ?? 0);

export type SalesFigures = {
  currency: string;
  orders: number;
  canceledOrders: number;
  itemsSold: number;
  gross: number;
  subtotal: number;
  discounts: number;
  shipping: number;
  tax: number;
  refunded: number;
  net: number;
  averageOrderValue: number;
};

type SalesRow = { currency: string; orders: unknown; canceled: unknown; gross: unknown; subtotal: unknown; discounts: unknown; shipping: unknown; tax: unknown; refunded: unknown };

const salesColumns = sql`
  count(*) filter (where o.status <> 'canceled')::int as orders,
  count(*) filter (where o.status = 'canceled')::int as canceled,
  coalesce(sum(o.grand_total) filter (where o.status <> 'canceled'), 0)::bigint as gross,
  coalesce(sum(o.subtotal) filter (where o.status <> 'canceled'), 0)::bigint as subtotal,
  coalesce(sum(o.discount_total) filter (where o.status <> 'canceled'), 0)::bigint as discounts,
  coalesce(sum(o.shipping_total) filter (where o.status <> 'canceled'), 0)::bigint as shipping,
  coalesce(sum(o.tax_total) filter (where o.status <> 'canceled'), 0)::bigint as tax,
  coalesce(sum(o.amount_refunded), 0)::bigint as refunded`;

const toFigures = (row: SalesRow, items: number): SalesFigures => {
  const orders = n(row.orders);
  const gross = n(row.gross);
  const refunded = n(row.refunded);
  return {
    currency: row.currency,
    orders,
    canceledOrders: n(row.canceled),
    itemsSold: items,
    gross,
    subtotal: n(row.subtotal),
    discounts: n(row.discounts),
    shipping: n(row.shipping),
    tax: n(row.tax),
    refunded,
    net: gross - refunded,
    averageOrderValue: orders ? Math.round(gross / orders) : 0,
  };
};

/** For orders placed in the range; refunds count against the order's period. */
export const salesTotals = async (db: Database, range: ReportRange): Promise<SalesFigures[]> => {
  checkRange(range);
  const rows = await queryRows<SalesRow>(db, sql`select o.currency, ${salesColumns} from orders o where ${orderScope(range)} group by o.currency order by o.currency`);
  const items = await queryRows<{ currency: string; items: unknown }>(
    db,
    sql`select o.currency, coalesce(sum(l.quantity - l.quantity_canceled), 0)::int as items
        from order_lines l join orders o on o.id = l.order_id
        where ${orderScope(range)} and o.status <> 'canceled' group by o.currency`,
  );
  return rows.map((row) => toFigures(row, n(items.find((i) => i.currency === row.currency)?.items)));
};

const periods = async (db: Database, range: ReportRange, granularity: Granularity, timeZone: string) =>
  (
    await queryRows<{ period: string }>(
      db,
      sql`select to_char(p, 'YYYY-MM-DD') as period from generate_series(
            date_trunc(${granularity}, ${range.from.toISOString()}::timestamptz at time zone ${timeZone}),
            date_trunc(${granularity}, (${range.to.toISOString()}::timestamptz - interval '1 microsecond') at time zone ${timeZone}),
            ('1 ' || ${granularity})::interval) p`,
    )
  ).map((r) => r.period);

export type SalesPeriod = SalesFigures & { period: string };

/** A row per period and currency, empty ones included. Periods start at midnight in `timeZone`. */
export const salesOverTime = async (db: Database, range: ReportRange, granularity: Granularity): Promise<{ periods: string[]; rows: SalesPeriod[] }> => {
  checkRange(range);
  const timeZone = resolveTimeZone(range.timeZone);
  const bucket = sql`to_char(date_trunc(${granularity}, o.placed_at at time zone ${timeZone}), 'YYYY-MM-DD')`;
  const rows = await queryRows<SalesRow & { period: string }>(
    db,
    sql`select ${bucket} as period, o.currency, ${salesColumns} from orders o where ${orderScope(range)} group by 1, 2`,
  );
  const items = await queryRows<{ period: string; currency: string; items: unknown }>(
    db,
    sql`select ${bucket} as period, o.currency, coalesce(sum(l.quantity - l.quantity_canceled), 0)::int as items
        from order_lines l join orders o on o.id = l.order_id
        where ${orderScope(range)} and o.status <> 'canceled' group by 1, 2`,
  );
  const all = await periods(db, range, granularity, timeZone);
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  const empty: SalesRow = { currency: "", orders: 0, canceled: 0, gross: 0, subtotal: 0, discounts: 0, shipping: 0, tax: 0, refunded: 0 };
  return {
    periods: all,
    rows: currencies.flatMap((currency) =>
      all.map((period) => {
        const row = rows.find((r) => r.period === period && r.currency === currency) ?? { ...empty, currency };
        const itemCount = n(items.find((i) => i.period === period && i.currency === currency)?.items);
        return { period, ...toFigures(row, itemCount) };
      }),
    ),
  };
};

export type ProductSalesRow = { variantId: string | null; productId: string | null; sku: string; name: string; currency: string; quantity: number; refundedQuantity: number; revenue: number; orders: number };

/** Best sellers: units net of cancellations, and line revenue after discounts. */
export const productSales = async (db: Database, range: ReportRange, options: { sortBy: "quantity" | "revenue"; limit: number }): Promise<ProductSalesRow[]> => {
  checkRange(range);
  const order = options.sortBy === "revenue" ? sql`revenue desc, quantity desc` : sql`quantity desc, revenue desc`;
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`select l.variant_id, l.product_id, l.sku, max(l.name) as name, o.currency,
          coalesce(sum(l.quantity - l.quantity_canceled), 0)::int as quantity,
          coalesce(sum(l.quantity_refunded), 0)::int as refunded_quantity,
          coalesce(sum(l.total), 0)::bigint as revenue,
          count(distinct o.id)::int as orders
        from order_lines l join orders o on o.id = l.order_id
        where ${orderScope(range)} and o.status <> 'canceled'
        group by l.variant_id, l.product_id, l.sku, o.currency
        order by ${order}, l.sku limit ${options.limit}`,
  );
  return rows.map((r) => ({
    variantId: (r.variant_id as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    sku: String(r.sku),
    name: String(r.name),
    currency: String(r.currency),
    quantity: n(r.quantity),
    refundedQuantity: n(r.refunded_quantity),
    revenue: n(r.revenue),
    orders: n(r.orders),
  }));
};

export type CustomerSalesRow = { customerId: string | null; email: string; currency: string; orders: number; total: number; lastOrderAt: Date };

/** Top buyers by spend; guests are grouped by email. */
export const customerSales = async (db: Database, range: ReportRange, limit: number): Promise<CustomerSalesRow[]> => {
  checkRange(range);
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`select (array_agg(o.customer_id))[1] as customer_id, max(o.email) as email, o.currency,
          count(*)::int as orders, coalesce(sum(o.grand_total), 0)::bigint as total, max(o.placed_at) as last_order_at
        from orders o where ${orderScope(range)} and o.status <> 'canceled'
        group by coalesce(o.customer_id::text, 'guest:' || o.email), o.currency
        order by total desc limit ${limit}`,
  );
  return rows.map((r) => ({
    customerId: (r.customer_id as string | null) ?? null,
    email: String(r.email),
    currency: String(r.currency),
    orders: n(r.orders),
    total: n(r.total),
    lastOrderAt: new Date(r.last_order_at as string),
  }));
};

export const customerSignups = async (db: Database, range: ReportRange, granularity: Granularity) => {
  checkRange(range);
  const timeZone = resolveTimeZone(range.timeZone);
  const rows = await queryRows<{ period: string; count: unknown }>(
    db,
    sql`select to_char(date_trunc(${granularity}, c.created_at at time zone ${timeZone}), 'YYYY-MM-DD') as period, count(*)::int as count
        from customers c where c.created_at >= ${range.from.toISOString()}::timestamptz and c.created_at < ${range.to.toISOString()}::timestamptz
        group by 1`,
  );
  const all = await periods(db, range, granularity, timeZone);
  return all.map((period) => ({ period, count: n(rows.find((r) => r.period === period)?.count) }));
};

export type PromotionUsageRow = { promotionId: string | null; name: string; couponCode: string | null; currency: string; orders: number; discount: number };

export const promotionUsage = async (db: Database, range: ReportRange): Promise<PromotionUsageRow[]> => {
  checkRange(range);
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`select d->>'promotionId' as promotion_id, d->>'name' as name, nullif(d->>'couponCode', '') as coupon_code, o.currency,
          count(distinct o.id)::int as orders, coalesce(sum((d->>'amount')::bigint), 0)::bigint as discount
        from orders o cross join lateral jsonb_array_elements(coalesce(o.totals->'discounts', '[]'::jsonb)) d
        where ${orderScope(range)} and o.status <> 'canceled'
        group by 1, 2, 3, 4 order by discount desc`,
  );
  return rows.map((r) => ({
    promotionId: (r.promotion_id as string | null) ?? null,
    name: String(r.name ?? ""),
    couponCode: (r.coupon_code as string | null) ?? null,
    currency: String(r.currency),
    orders: n(r.orders),
    discount: n(r.discount),
  }));
};

/** Active, tracked variants at or below the threshold, at one location or across all. */
export const lowStock = async (db: Database, options: { threshold: number; locationId?: string | null; limit: number }) => {
  const location = options.locationId ? sql`and s.location_id = ${options.locationId}::uuid` : sql``;
  const rows = await queryRows<{ variant_id: string; on_hand: unknown }>(
    db,
    sql`select v.id as variant_id, coalesce(sum(s.quantity), 0)::int as on_hand
        from product_variants v
        join products p on p.id = v.product_id
        left join stock_levels s on s.variant_id = v.id ${location}
        where v.track_inventory and v.is_active and p.status = 'active'
        group by v.id, v.sku having coalesce(sum(s.quantity), 0) <= ${options.threshold}
        order by on_hand asc, v.sku limit ${options.limit}`,
  );
  return rows.map((r) => ({ variantId: r.variant_id, onHand: n(r.on_hand) }));
};

export type AbandonedCartRow = { cartId: string; email: string | null; customerId: string | null; channelId: string; currency: string; lines: number; items: number; updatedAt: Date };

/** Active carts with items that have not changed for `idleMinutes`, newest first. */
export const abandonedCarts = async (db: Database, options: { idleMinutes: number; since: Date; limit: number }): Promise<AbandonedCartRow[]> => {
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`select c.id, c.email, c.customer_id, c.channel_id, c.currency, c.updated_at, count(l.id)::int as lines, coalesce(sum(l.quantity), 0)::int as items
        from carts c join cart_lines l on l.cart_id = c.id
        where c.status = 'active' and c.updated_at < now() - (${options.idleMinutes}::int * interval '1 minute') and c.updated_at >= ${options.since.toISOString()}::timestamptz
        group by c.id order by c.updated_at desc limit ${options.limit}`,
  );
  return rows.map((r) => ({
    cartId: String(r.id),
    email: (r.email as string | null) ?? null,
    customerId: (r.customer_id as string | null) ?? null,
    channelId: String(r.channel_id),
    currency: String(r.currency),
    lines: n(r.lines),
    items: n(r.items),
    updatedAt: new Date(r.updated_at as string),
  }));
};

export type Attention = { awaitingFulfillment: number; awaitingPayment: number; failedWebhookDeliveries: number; lowStockVariants: number };

/** Work waiting for someone: shown on the dashboard. */
export const attention = async (db: Database, options: { lowStockThreshold: number }): Promise<Attention> => {
  const [orders] = await queryRows<{ fulfillment: unknown; payment: unknown }>(
    db,
    sql`select count(*) filter (where fulfillment_status <> 'fulfilled' and payment_status in ('paid', 'partially_paid', 'authorized'))::int as fulfillment,
               count(*) filter (where payment_status in ('pending', 'authorized'))::int as payment
        from orders where status = 'open'`,
  );
  const [webhooks] = await queryRows<{ count: unknown }>(db, sql`select count(*)::int as count from webhook_deliveries where status = 'dead'`);
  const [stock] = await queryRows<{ count: unknown }>(
    db,
    sql`select count(*)::int as count from (
          select v.id from product_variants v join products p on p.id = v.product_id left join stock_levels s on s.variant_id = v.id
          where v.track_inventory and v.is_active and p.status = 'active'
          group by v.id having coalesce(sum(s.quantity), 0) <= ${options.lowStockThreshold}) low`,
  );
  return {
    awaitingFulfillment: n(orders?.fulfillment),
    awaitingPayment: n(orders?.payment),
    failedWebhookDeliveries: n(webhooks?.count),
    lowStockVariants: n(stock?.count),
  };
};

export const newCustomerCount = async (db: Database, range: ReportRange) => {
  const [row] = await queryRows<{ count: unknown }>(
    db,
    sql`select count(*)::int as count from customers where created_at >= ${range.from.toISOString()}::timestamptz and created_at < ${range.to.toISOString()}::timestamptz`,
  );
  return n(row?.count);
};

/** The equally long range just before this one, for period-over-period comparison. */
export const previousRange = (range: ReportRange): ReportRange => {
  const length = range.to.getTime() - range.from.getTime();
  return { ...range, from: new Date(range.from.getTime() - length), to: range.from };
};
