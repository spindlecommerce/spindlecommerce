import { toGlobalId } from "../../lib/ids.ts";
import { listChannels } from "../../modules/channels/service.ts";
import {
  abandonedCarts,
  attention,
  customerSales,
  customerSignups,
  lowStock,
  newCustomerCount,
  previousRange,
  productSales,
  promotionUsage,
  resolveTimeZone,
  salesOverTime,
  salesTotals,
  type AbandonedCartRow,
  type Attention,
  type CustomerSalesRow,
  type Granularity,
  type ProductSalesRow,
  type PromotionUsageRow,
  type ReportRange,
  type SalesFigures,
  type SalesPeriod,
} from "../../modules/reports/service.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import { ChannelRef, CustomerRef, MoneyRef, ProductRef, ProductVariantRef, PromotionRef, StockLocationRef } from "../refs.ts";
import { money } from "./common.ts";

const DateRangeInput = builder.inputType("DateRangeInput", {
  subGraphs: ADMIN,
  description: "Half-open: from ≤ t < to. Compute local-day boundaries on the client.",
  fields: (t) => ({ from: t.field({ type: "DateTime", required: true }), to: t.field({ type: "DateTime", required: true }) }),
});

const Granularity = builder.enumType("ReportGranularity", { subGraphs: ADMIN, values: { DAY: { value: "day" }, WEEK: { value: "week" }, MONTH: { value: "month" } } as const });
const ProductSalesSort = builder.enumType("ProductSalesSort", { subGraphs: ADMIN, values: { QUANTITY: { value: "quantity" }, REVENUE: { value: "revenue" } } as const });

type Types = typeof builder.$inferSchemaTypes;

const figureFields = <T extends SalesFigures>(t: PothosSchemaTypes.ObjectFieldBuilder<Types, T>) => ({
  currencyCode: t.field({ type: "CurrencyCode", resolve: (f) => f.currency }),
  orders: t.int({ description: "Orders placed, excluding canceled ones.", resolve: (f) => f.orders }),
  canceledOrders: t.int({ resolve: (f) => f.canceledOrders }),
  itemsSold: t.int({ description: "Units, net of canceled quantities.", resolve: (f) => f.itemsSold }),
  gross: t.field({ type: MoneyRef, description: "Order totals including tax and shipping.", resolve: (f) => money(f.gross, f.currency) }),
  subtotal: t.field({ type: MoneyRef, resolve: (f) => money(f.subtotal, f.currency) }),
  discounts: t.field({ type: MoneyRef, resolve: (f) => money(f.discounts, f.currency) }),
  shipping: t.field({ type: MoneyRef, resolve: (f) => money(f.shipping, f.currency) }),
  tax: t.field({ type: MoneyRef, resolve: (f) => money(f.tax, f.currency) }),
  refunded: t.field({ type: MoneyRef, description: "Refunded so far on orders placed in the period.", resolve: (f) => money(f.refunded, f.currency) }),
  net: t.field({ type: MoneyRef, description: "Gross minus refunded.", resolve: (f) => money(f.net, f.currency) }),
  averageOrderValue: t.field({ type: MoneyRef, resolve: (f) => money(f.averageOrderValue, f.currency) }),
});

const SalesFiguresRef = builder.objectRef<SalesFigures>("SalesFigures").implement({ subGraphs: ADMIN, description: "Sales in one currency.", fields: (t) => figureFields(t) });
const SalesPeriodRef = builder.objectRef<SalesPeriod>("SalesPeriod").implement({
  subGraphs: ADMIN,
  fields: (t) => ({ period: t.string({ description: "First day of the period, YYYY-MM-DD, in the report's time zone.", resolve: (p) => p.period }), ...figureFields(t) }),
});

const AttentionRef = builder.objectRef<Attention>("DashboardAttention").implement({
  subGraphs: ADMIN,
  description: "Work waiting for someone.",
  fields: (t) => ({
    awaitingFulfillment: t.int({ description: "Open, paid or authorized orders with items left to ship.", resolve: (a) => a.awaitingFulfillment }),
    awaitingPayment: t.int({ description: "Open orders whose payment is pending or authorized.", resolve: (a) => a.awaitingPayment }),
    failedWebhookDeliveries: t.int({ description: "Deliveries that gave up retrying.", resolve: (a) => a.failedWebhookDeliveries }),
    lowStockVariants: t.int({ resolve: (a) => a.lowStockVariants }),
  }),
});

const ProductSalesRowRef = builder.objectRef<ProductSalesRow>("ProductSalesRow").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    sku: t.string({ resolve: (r) => r.sku }),
    name: t.string({ description: "Name when ordered.", resolve: (r) => r.name }),
    variant: t.field({ type: ProductVariantRef, nullable: true, resolve: (r, _a, ctx) => (r.variantId ? ctx.loaders.variant.load(r.variantId) : null) }),
    product: t.field({ type: ProductRef, nullable: true, resolve: (r, _a, ctx) => (r.productId ? ctx.loaders.product.load(r.productId) : null) }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (r) => r.currency }),
    quantity: t.int({ resolve: (r) => r.quantity }),
    refundedQuantity: t.int({ resolve: (r) => r.refundedQuantity }),
    revenue: t.field({ type: MoneyRef, description: "Line totals after discounts.", resolve: (r) => money(r.revenue, r.currency) }),
    orders: t.int({ resolve: (r) => r.orders }),
  }),
});

const CustomerSalesRowRef = builder.objectRef<CustomerSalesRow>("CustomerSalesRow").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    customer: t.field({ type: CustomerRef, nullable: true, description: "Null for guest checkouts.", resolve: (r, _a, ctx) => (r.customerId ? ctx.loaders.customer.load(r.customerId) : null) }),
    email: t.field({ type: "EmailAddress", resolve: (r) => r.email }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (r) => r.currency }),
    orders: t.int({ resolve: (r) => r.orders }),
    total: t.field({ type: MoneyRef, resolve: (r) => money(r.total, r.currency) }),
    lastOrderAt: t.field({ type: "DateTime", resolve: (r) => r.lastOrderAt }),
  }),
});

const PeriodCountRef = builder.objectRef<{ period: string; count: number }>("PeriodCount").implement({
  subGraphs: ADMIN,
  fields: (t) => ({ period: t.string({ resolve: (p) => p.period }), count: t.int({ resolve: (p) => p.count }) }),
});

const PromotionUsageRowRef = builder.objectRef<PromotionUsageRow>("PromotionUsageRow").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    promotion: t.field({ type: PromotionRef, nullable: true, description: "Null if the promotion was deleted.", resolve: async (r, _a, ctx) => (r.promotionId ? ((await ctx.loaders.promotion.load(r.promotionId)) ?? null) : null) }),
    name: t.string({ description: "Name when applied.", resolve: (r) => r.name }),
    couponCode: t.string({ nullable: true, resolve: (r) => r.couponCode }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (r) => r.currency }),
    orders: t.int({ resolve: (r) => r.orders }),
    discount: t.field({ type: MoneyRef, resolve: (r) => money(r.discount, r.currency) }),
  }),
});

const LowStockRowRef = builder.objectRef<{ variantId: string; onHand: number }>("LowStockRow").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    variant: t.field({ type: ProductVariantRef, resolve: async (r, _a, ctx) => (await ctx.loaders.variant.load(r.variantId))! }),
    onHand: t.int({ description: "At the location, or across all locations.", resolve: (r) => r.onHand }),
  }),
});

const AbandonedCartRef = builder.objectRef<AbandonedCartRow>("AbandonedCart").implement({
  subGraphs: ADMIN,
  description: "An active cart with items that has not changed for a while.",
  fields: (t) => ({
    id: t.id({ resolve: (c) => toGlobalId("Cart", c.cartId) }),
    email: t.field({ type: "EmailAddress", nullable: true, resolve: (c) => c.email }),
    customer: t.field({ type: CustomerRef, nullable: true, resolve: (c, _a, ctx) => (c.customerId ? ctx.loaders.customer.load(c.customerId) : null) }),
    channel: t.field({ type: ChannelRef, resolve: async (c, _a, ctx) => (await listChannels(ctx.db)).find((ch) => ch.id === c.channelId)! }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (c) => c.currency }),
    lines: t.int({ resolve: (c) => c.lines }),
    items: t.int({ resolve: (c) => c.items }),
    subtotal: t.field({ type: MoneyRef, description: "At current prices.", resolve: async (c, _a, ctx) => money((await ctx.loaders.quote.load(c.cartId)).totals.subtotal, c.currency) }),
    updatedAt: t.field({ type: "DateTime", resolve: (c) => c.updatedAt }),
  }),
});

type Dashboard = { range: ReportRange; lowStockThreshold: number };
const DashboardRef = builder.objectRef<Dashboard>("Dashboard").implement({
  subGraphs: ADMIN,
  description: "Live figures for the range, with the equally long range before it for comparison.",
  fields: (t) => ({
    from: t.field({ type: "DateTime", resolve: (d) => d.range.from }),
    to: t.field({ type: "DateTime", resolve: (d) => d.range.to }),
    totals: t.field({ type: [SalesFiguresRef], resolve: (d, _a, ctx) => salesTotals(ctx.db, d.range) }),
    previousTotals: t.field({ type: [SalesFiguresRef], resolve: (d, _a, ctx) => salesTotals(ctx.db, previousRange(d.range)) }),
    series: t.field({
      type: [SalesPeriodRef],
      description: "Daily figures per currency.",
      resolve: async (d, _a, ctx) => (await salesOverTime(ctx.db, d.range, "day")).rows,
    }),
    newCustomers: t.int({ resolve: (d, _a, ctx) => newCustomerCount(ctx.db, d.range) }),
    previousNewCustomers: t.int({ resolve: (d, _a, ctx) => newCustomerCount(ctx.db, previousRange(d.range)) }),
    topProducts: t.field({ type: [ProductSalesRowRef], args: { first: t.arg.int({ defaultValue: 5 }) }, resolve: (d, { first }, ctx) => productSales(ctx.db, d.range, { sortBy: "revenue", limit: Math.min(first ?? 5, 50) }) }),
    attention: t.field({ type: AttentionRef, resolve: (d, _a, ctx) => attention(ctx.db, { lowStockThreshold: d.lowStockThreshold }) }),
  }),
});

const SalesReportRef = builder.objectRef<{ range: ReportRange; granularity: Granularity }>("SalesReport").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    periods: t.stringList({ description: "Every period in the range, YYYY-MM-DD.", resolve: async (r, _a, ctx) => (await salesOverTime(ctx.db, r.range, r.granularity)).periods }),
    rows: t.field({ type: [SalesPeriodRef], description: "One row per period and currency, empty periods included.", resolve: async (r, _a, ctx) => (await salesOverTime(ctx.db, r.range, r.granularity)).rows }),
    totals: t.field({ type: [SalesFiguresRef], resolve: (r, _a, ctx) => salesTotals(ctx.db, r.range) }),
  }),
});

const rangeOf = (args: { range: { from: Date; to: Date }; channelId?: { id: string } | string | null; currency?: string | null; timeZone?: string | null }): ReportRange => ({
  from: args.range.from,
  to: args.range.to,
  channelId: args.channelId ? rawId(args.channelId) : null,
  currency: args.currency ?? null,
  timeZone: resolveTimeZone(args.timeZone),
});

const cap = (value: number | null | undefined, fallback: number, max: number) => Math.min(Math.max(value ?? fallback, 1), max);

builder.queryFields((t) => ({
  dashboard: t.field({
    type: DashboardRef,
    subGraphs: ADMIN,
    authScopes: { permission: "reports:read" },
    args: {
      range: t.arg({ type: DateRangeInput, required: true }),
      channelId: t.arg.globalID({ for: [ChannelRef] }),
      timeZone: t.arg.string({ description: "IANA zone for daily buckets, e.g. Europe/Berlin. Default UTC." }),
      lowStockThreshold: t.arg.int({ defaultValue: 5 }),
    },
    resolve: (_r, args, ctx) => ({ range: rangeOf(args), lowStockThreshold: args.lowStockThreshold ?? 5 }),
  }),
  salesReport: t.field({
    type: SalesReportRef,
    subGraphs: ADMIN,
    description: "Orders, revenue, discounts, tax, shipping and refunds by period.",
    authScopes: { permission: "reports:read" },
    args: {
      range: t.arg({ type: DateRangeInput, required: true }),
      granularity: t.arg({ type: Granularity, defaultValue: "day" }),
      channelId: t.arg.globalID({ for: [ChannelRef] }),
      currency: t.arg({ type: "CurrencyCode" }),
      timeZone: t.arg.string(),
    },
    resolve: (_r, args, ctx) => ({ range: rangeOf(args), granularity: args.granularity ?? "day" }),
  }),
  productSalesReport: t.field({
    type: [ProductSalesRowRef],
    subGraphs: ADMIN,
    description: "Best sellers.",
    authScopes: { permission: "reports:read" },
    args: {
      range: t.arg({ type: DateRangeInput, required: true }),
      channelId: t.arg.globalID({ for: [ChannelRef] }),
      currency: t.arg({ type: "CurrencyCode" }),
      sortBy: t.arg({ type: ProductSalesSort, defaultValue: "quantity" }),
      first: t.arg.int({ defaultValue: 20 }),
    },
    resolve: (_r, args, ctx) => productSales(ctx.db, rangeOf(args), { sortBy: args.sortBy ?? "quantity", limit: cap(args.first, 20, 200) }),
  }),
  customerSalesReport: t.field({
    type: [CustomerSalesRowRef],
    subGraphs: ADMIN,
    description: "Top customers by spend.",
    authScopes: { permission: "reports:read" },
    args: { range: t.arg({ type: DateRangeInput, required: true }), channelId: t.arg.globalID({ for: [ChannelRef] }), currency: t.arg({ type: "CurrencyCode" }), first: t.arg.int({ defaultValue: 20 }) },
    resolve: (_r, args, ctx) => customerSales(ctx.db, rangeOf(args), cap(args.first, 20, 200)),
  }),
  customerSignupsReport: t.field({
    type: [PeriodCountRef],
    subGraphs: ADMIN,
    description: "New accounts by period.",
    authScopes: { permission: "reports:read" },
    args: { range: t.arg({ type: DateRangeInput, required: true }), granularity: t.arg({ type: Granularity, defaultValue: "day" }), timeZone: t.arg.string() },
    resolve: (_r, args, ctx) => customerSignups(ctx.db, rangeOf(args), args.granularity ?? "day"),
  }),
  promotionUsageReport: t.field({
    type: [PromotionUsageRowRef],
    subGraphs: ADMIN,
    description: "Discount granted per promotion and coupon.",
    authScopes: { permission: "reports:read" },
    args: { range: t.arg({ type: DateRangeInput, required: true }), channelId: t.arg.globalID({ for: [ChannelRef] }), currency: t.arg({ type: "CurrencyCode" }) },
    resolve: (_r, args, ctx) => promotionUsage(ctx.db, rangeOf(args)),
  }),
  lowStockReport: t.field({
    type: [LowStockRowRef],
    subGraphs: ADMIN,
    description: "Active, tracked variants at or below the threshold.",
    authScopes: { permission: "inventory:read" },
    args: { threshold: t.arg.int({ defaultValue: 5 }), locationId: t.arg.globalID({ for: [StockLocationRef] }), first: t.arg.int({ defaultValue: 50 }) },
    resolve: (_r, args, ctx) => lowStock(ctx.db, { threshold: args.threshold ?? 5, locationId: args.locationId ? rawId(args.locationId) : null, limit: cap(args.first, 50, 500) }),
  }),
  abandonedCartsReport: t.field({
    type: [AbandonedCartRef],
    subGraphs: ADMIN,
    authScopes: { permission: "reports:read" },
    args: {
      idleMinutes: t.arg.int({ defaultValue: 60, description: "Minimum time since the cart last changed." }),
      since: t.arg({ type: "DateTime", description: "Ignore carts last changed before this. Default: 30 days ago." }),
      first: t.arg.int({ defaultValue: 50 }),
    },
    resolve: (_r, args, ctx) =>
      abandonedCarts(ctx.db, { idleMinutes: Math.max(args.idleMinutes ?? 60, 0), since: args.since ?? new Date(Date.now() - 30 * 86_400_000), limit: cap(args.first, 50, 200) }),
  }),
}));
