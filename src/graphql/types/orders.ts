import { CartNotReadyError, InsufficientStockError, InvalidStateError, NotFoundError, PaymentDeclinedError, PermissionDeniedError } from "../../lib/errors.ts";
import { toGlobalId } from "../../lib/ids.ts";
import type { OrderUpdate } from "../../platform.ts";
import { findOrderByNumber, getOrder, listOrders, type Order } from "../../modules/orders/read.ts";
import { quoteProviders } from "../../modules/carts/quote.ts";
import { placeDraftOrder, quoteDraftOrder, type DraftOrderQuote } from "../../modules/orders/draft.ts";
import { addOrderNote, cancelOrder, capturePayment, refundOrder, shipOrder, updateOrderAddresses } from "../../modules/orders/service.ts";
import type { FulfillmentShipment } from "../../modules/orders/tables.ts";
import { listTransactions } from "../../modules/payments/service.ts";
import { ADMIN, BOTH, builder, connectionComplexity, rawId, STOREFRONT } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { keysetConnection } from "../pagination.ts";
import {
  AddressRef,
  ChannelRef,
  CustomerRef,
  FulfillmentRef,
  InvoiceRef,
  MoneyRef,
  OrderEventRef,
  OrderLineRef,
  OrderRef,
  PaymentTransactionRef,
  ProductRef,
  ProductVariantRef,
  RefundRef,
  StockLocationRef,
} from "../refs.ts";
import { AppliedDiscountRef, CartCouponRef, CartLineIssueRef, PaymentMethodOptionRef, ShippingRateRef, TaxLineRef } from "./carts.ts";
import { AddressInput, CartRequirement, money } from "./common.ts";
import { FulfillmentStatusEnum, OrderStatusEnum, PaymentStatusEnum } from "./order-enums.ts";
import { ShippingProviderRef } from "./shipping.ts";

const canSeeOrder = (ctx: GraphQLContext, order: Order | null) =>
  !!order && (ctx.api === "admin" || (ctx.customer !== null && order.customerId === ctx.customer.id));

// ---------------------------------------------------------------- order documents

OrderLineRef.implement({
  fields: (t) => ({
    id: t.id({ resolve: (l) => toGlobalId("OrderLine", l.id) }),
    sku: t.exposeString("sku"),
    name: t.exposeString("name"),
    variantAttributes: t.field({ type: "JSON", description: "Snapshot of the variant's options when ordered.", resolve: (l) => l.variantAttributes }),
    quantity: t.exposeInt("quantity"),
    quantityFulfilled: t.exposeInt("quantityFulfilled"),
    quantityRefunded: t.exposeInt("quantityRefunded"),
    quantityCanceled: t.exposeInt("quantityCanceled"),
    unitPrice: t.field({ type: MoneyRef, resolve: async (l, _a, ctx) => money(l.unitPrice, (await ctx.loaders.order.load(l.orderId))!.currency) }),
    subtotal: t.field({ type: MoneyRef, resolve: async (l, _a, ctx) => money(l.subtotal, (await ctx.loaders.order.load(l.orderId))!.currency) }),
    discount: t.field({ type: MoneyRef, resolve: async (l, _a, ctx) => money(l.discountTotal, (await ctx.loaders.order.load(l.orderId))!.currency) }),
    tax: t.field({ type: MoneyRef, resolve: async (l, _a, ctx) => money(l.taxTotal, (await ctx.loaders.order.load(l.orderId))!.currency) }),
    total: t.field({ type: MoneyRef, resolve: async (l, _a, ctx) => money(l.total, (await ctx.loaders.order.load(l.orderId))!.currency) }),
    taxRate: t.float({ resolve: (l) => Number(l.taxRate) }),
    variant: t.field({ type: ProductVariantRef, nullable: true, description: "Null if the variant was deleted since.", resolve: (l, _a, ctx) => (l.variantId ? ctx.loaders.variant.load(l.variantId) : null) }),
    product: t.field({ type: ProductRef, nullable: true, resolve: (l, _a, ctx) => (l.productId ? ctx.loaders.product.load(l.productId) : null) }),
  }),
});

const DocumentLineRef = builder.objectRef<{ orderId: string; orderLineId: string; quantity: number }>("DocumentLine").implement({
  fields: (t) => ({
    orderLine: t.field({ type: OrderLineRef, resolve: async (d, _a, ctx) => (await ctx.loaders.orderLines.load(d.orderId)).find((l) => l.id === d.orderLineId)! }),
    quantity: t.exposeInt("quantity"),
  }),
});

const TrackingRef = builder.objectRef<{ carrier: string; number: string; url?: string | null }>("TrackingNumber").implement({
  fields: (t) => ({ carrier: t.exposeString("carrier"), number: t.exposeString("number"), url: t.string({ nullable: true, resolve: (x) => x.url ?? null }) }),
});

const FulfillmentShipmentRef = builder.objectRef<FulfillmentShipment & { title: string }>("FulfillmentShipment").implement({
  subGraphs: ADMIN,
  description: "What a shipping provider booked for a fulfilment: the label and its cost.",
  fields: (t) => ({
    provider: t.exposeString("provider", { description: "The shipping provider's code." }),
    providerTitle: t.exposeString("title"),
    labelUrl: t.string({ nullable: true, resolve: (s) => s.labelUrl }),
    cost: t.field({ type: MoneyRef, nullable: true, description: "What the label cost the store.", resolve: (s) => (s.cost ? money(s.cost.amount, s.cost.currency) : null) }),
  }),
});

FulfillmentRef.implement({
  description: "A shipment of some or all of an order's items.",
  fields: (t) => ({
    id: t.id({ resolve: (f) => toGlobalId("Fulfillment", f.id) }),
    number: t.exposeString("number"),
    status: t.exposeString("status"),
    tracking: t.field({ type: [TrackingRef], resolve: (f) => f.tracking }),
    shipment: t.field({
      type: FulfillmentShipmentRef,
      nullable: true,
      subGraphs: ADMIN,
      description: "The label a shipping provider booked (orderFulfill createShipment).",
      resolve: (f, _a, ctx) => (f.shipment ? { ...f.shipment, title: ctx.platform.shipping.get(f.shipment.provider)?.title ?? f.shipment.provider } : null),
    }),
    lines: t.field({ type: [DocumentLineRef], resolve: (f) => f.lines.map((l) => ({ ...l, orderId: f.orderId })) }),
    location: t.field({ type: StockLocationRef, subGraphs: ADMIN, resolve: async (f, _a, ctx) => (await ctx.db.query.stockLocations.findFirst({ where: (l, { eq }) => eq(l.id, f.locationId) }))! }),
    createdAt: t.field({ type: "DateTime", resolve: (f) => f.createdAt }),
  }),
});

InvoiceRef.implement({
  description: "An invoice: a captured payment.",
  fields: (t) => ({
    id: t.id({ resolve: (i) => toGlobalId("Invoice", i.id) }),
    number: t.exposeString("number"),
    amount: t.field({ type: MoneyRef, resolve: async (i, _a, ctx) => money(i.amount, (await ctx.loaders.order.load(i.orderId))!.currency) }),
    createdAt: t.field({ type: "DateTime", resolve: (i) => i.createdAt }),
  }),
});

const RefundLineRef = builder.objectRef<{ orderId: string; orderLineId: string; quantity: number; amount: number; restock: boolean }>("RefundLine").implement({
  fields: (t) => ({
    orderLine: t.field({ type: OrderLineRef, resolve: async (d, _a, ctx) => (await ctx.loaders.orderLines.load(d.orderId)).find((l) => l.id === d.orderLineId)! }),
    quantity: t.exposeInt("quantity"),
    amount: t.field({ type: MoneyRef, resolve: async (d, _a, ctx) => money(d.amount, (await ctx.loaders.order.load(d.orderId))!.currency) }),
    restocked: t.boolean({ resolve: (d) => d.restock }),
  }),
});

RefundRef.implement({
  description: "A refund: money returned to the customer.",
  fields: (t) => ({
    id: t.id({ resolve: (r) => toGlobalId("Refund", r.id) }),
    number: t.exposeString("number"),
    amount: t.field({ type: MoneyRef, resolve: async (r, _a, ctx) => money(r.amount, (await ctx.loaders.order.load(r.orderId))!.currency) }),
    shippingAmount: t.field({ type: MoneyRef, resolve: async (r, _a, ctx) => money(r.shippingAmount, (await ctx.loaders.order.load(r.orderId))!.currency) }),
    reason: t.exposeString("reason", { nullable: true }),
    lines: t.field({ type: [RefundLineRef], resolve: (r) => r.lines.map((l) => ({ ...l, orderId: r.orderId })) }),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
  }),
});

OrderEventRef.implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    type: t.exposeString("type"),
    message: t.exposeString("message"),
    actorType: t.exposeString("actorType"),
    actorId: t.id({ nullable: true, resolve: (e) => e.actorId }),
    data: t.field({ type: "JSON", resolve: (e) => e.data }),
    createdAt: t.field({ type: "DateTime", resolve: (e) => e.createdAt }),
  }),
});

PaymentTransactionRef.implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    id: t.id({ resolve: (x) => toGlobalId("PaymentTransaction", x.id) }),
    kind: t.exposeString("kind"),
    status: t.exposeString("status"),
    provider: t.exposeString("provider"),
    paymentMethodCode: t.exposeString("paymentMethodCode"),
    amount: t.field({ type: MoneyRef, resolve: (x) => money(x.amount, x.currency) }),
    pspReference: t.exposeString("pspReference", { nullable: true }),
    errorMessage: t.exposeString("errorMessage", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (x) => x.createdAt }),
  }),
});

const OrderTotalsRef = builder.objectRef<Order>("OrderTotals").implement({
  fields: (t) => ({
    subtotal: t.field({ type: MoneyRef, resolve: (o) => money(o.subtotal, o.currency) }),
    discountTotal: t.field({ type: MoneyRef, resolve: (o) => money(o.discountTotal, o.currency) }),
    shipping: t.field({ type: MoneyRef, resolve: (o) => money(o.shippingTotal, o.currency) }),
    tax: t.field({ type: MoneyRef, resolve: (o) => money(o.taxTotal, o.currency) }),
    total: t.field({ type: MoneyRef, resolve: (o) => money(o.grandTotal, o.currency) }),
    paid: t.field({ type: MoneyRef, resolve: (o) => money(o.amountCaptured, o.currency) }),
    refunded: t.field({ type: MoneyRef, resolve: (o) => money(o.amountRefunded, o.currency) }),
    pricesIncludeTax: t.exposeBoolean("pricesIncludeTax"),
    taxLines: t.field({
      type: [builder.objectRef<{ name: string; rate: number; amount: number; currency: string }>("OrderTaxLine").implement({
        fields: (f) => ({ name: f.exposeString("name"), rate: f.exposeFloat("rate"), amount: f.field({ type: MoneyRef, resolve: (x) => money(x.amount, x.currency) }) }),
      })],
      resolve: (o) => o.totals.taxLines.map((x) => ({ ...x, currency: o.currency })),
    }),
    discounts: t.field({
      type: [builder.objectRef<{ name: string; couponCode: string | null; amount: number; currency: string }>("OrderDiscount").implement({
        fields: (f) => ({ name: f.exposeString("name"), couponCode: f.exposeString("couponCode", { nullable: true }), amount: f.field({ type: MoneyRef, resolve: (x) => money(x.amount, x.currency) }) }),
      })],
      resolve: (o) => o.totals.discounts.map((d) => ({ name: d.name, couponCode: d.couponCode, amount: d.amount, currency: o.currency })),
    }),
  }),
});

const OrderShippingMethodRef = builder.objectRef<NonNullable<Order["shippingMethod"]> & { currency: string }>("OrderShippingMethod").implement({
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    carrier: t.exposeString("carrier"),
    price: t.field({ type: MoneyRef, resolve: (s) => money(s.amount, s.currency) }),
    provider: t.string({ nullable: true, subGraphs: ADMIN, description: "The shipping provider behind the rate (null on orders placed before providers).", resolve: (s) => s.details?.provider ?? null }),
  }),
});

builder.node(OrderRef, {
  id: { resolve: (o) => o.id },
  loadMany: async (ids, ctx) => (await ctx.loaders.order.loadMany(ids)).map((o) => (o instanceof Error || !canSeeOrder(ctx, o) ? null : o)),
  fields: (t) => ({
    number: t.exposeString("number"),
    status: t.field({ type: OrderStatusEnum, resolve: (o) => o.status }),
    paymentStatus: t.field({ type: PaymentStatusEnum, resolve: (o) => o.paymentStatus }),
    fulfillmentStatus: t.field({ type: FulfillmentStatusEnum, resolve: (o) => o.fulfillmentStatus }),
    email: t.field({ type: "EmailAddress", resolve: (o) => o.email }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (o) => o.currency }),
    locale: t.field({ type: "LocaleCode", resolve: (o) => o.locale }),
    placedAt: t.field({ type: "DateTime", resolve: (o) => o.placedAt }),
    canceledAt: t.field({ type: "DateTime", nullable: true, resolve: (o) => o.canceledAt }),
    completedAt: t.field({ type: "DateTime", nullable: true, resolve: (o) => o.completedAt }),
    lines: t.field({ type: [OrderLineRef], complexity: { field: 1, multiplier: 10 }, resolve: (o, _a, ctx) => ctx.loaders.orderLines.load(o.id) }),
    totals: t.field({ type: OrderTotalsRef, resolve: (o) => o }),
    shippingAddress: t.field({ type: AddressRef, nullable: true, resolve: (o) => o.shippingAddress }),
    billingAddress: t.field({ type: AddressRef, resolve: (o) => o.billingAddress }),
    shippingMethod: t.field({ type: OrderShippingMethodRef, nullable: true, resolve: (o) => (o.shippingMethod ? { ...o.shippingMethod, currency: o.currency } : null) }),
    paymentMethodCode: t.exposeString("paymentMethodCode"),
    couponCodes: t.exposeStringList("couponCodes"),
    fulfillments: t.field({ type: [FulfillmentRef], resolve: (o, _a, ctx) => ctx.loaders.orderFulfillments.load(o.id) }),
    invoices: t.field({ type: [InvoiceRef], resolve: (o, _a, ctx) => ctx.loaders.orderInvoices.load(o.id) }),
    refunds: t.field({ type: [RefundRef], resolve: (o, _a, ctx) => ctx.loaders.orderRefunds.load(o.id) }),
    canCancel: t.boolean({
      description: "Open, unshipped and not yet charged.",
      resolve: (o) => o.status === "open" && o.fulfillmentStatus === "unfulfilled" && o.amountCaptured === 0,
    }),
    customer: t.field({ type: CustomerRef, nullable: true, subGraphs: ADMIN, resolve: (o, _a, ctx) => (o.customerId ? ctx.loaders.customer.load(o.customerId) : null) }),
    channel: t.field({ type: ChannelRef, subGraphs: ADMIN, resolve: async (o, _a, ctx) => (await ctx.db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, o.channelId) }))! }),
    timeline: t.field({ type: [OrderEventRef], subGraphs: ADMIN, resolve: (o, _a, ctx) => ctx.loaders.orderEvents.load(o.id) }),
    transactions: t.field({ type: [PaymentTransactionRef], subGraphs: ADMIN, resolve: (o, _a, ctx) => listTransactions(ctx.db, o.id) }),
    amountAuthorized: t.field({ type: MoneyRef, subGraphs: ADMIN, resolve: (o) => money(o.amountAuthorized, o.currency) }),
    shipmentProviders: t.field({
      type: [ShippingProviderRef],
      subGraphs: ADMIN,
      description: "Active shipping providers that can book a shipment (buy a label) for orderFulfill, the one behind the order's rate first.",
      resolve: async (o, _a, ctx) => {
        const own = o.shippingMethod?.details?.provider;
        const candidates = [...ctx.platform.shipping.values()].filter((p) => p.createShipment).sort((a, b) => Number(b.code === own) - Number(a.code === own));
        const active = await Promise.all(candidates.map((p) => (p.isActive ? p.isActive().catch(() => false) : true)));
        return candidates.filter((_, i) => active[i]);
      },
    }),
    metadata: t.field({ type: "JSON", subGraphs: ADMIN, resolve: (o) => o.metadata }),
  }),
});

// ---------------------------------------------------------------- queries

const OrderFilterInput = builder.inputType("OrderFilter", {
  subGraphs: ADMIN,
  fields: (t) => ({
    status: t.field({ type: OrderStatusEnum }),
    paymentStatus: t.field({ type: PaymentStatusEnum }),
    fulfillmentStatus: t.field({ type: FulfillmentStatusEnum }),
    customerId: t.globalID({ for: [CustomerRef] }),
    channelId: t.globalID({ for: [ChannelRef] }),
    placedAfter: t.field({ type: "DateTime" }),
    placedBefore: t.field({ type: "DateTime" }),
    query: t.string({ description: "Order number or email." }),
  }),
});

builder.queryFields((t) => ({
  orders: t.connection({
    type: OrderRef,
    subGraphs: ADMIN,
    authScopes: { permission: "orders:read" },
    args: { filter: t.arg({ type: OrderFilterInput }) },
    complexity: connectionComplexity,
    resolve: (_r, { filter, ...args }, ctx) =>
      keysetConnection(args, (page) =>
        listOrders(
          ctx.db,
          {
            status: filter?.status,
            paymentStatus: filter?.paymentStatus,
            fulfillmentStatus: filter?.fulfillmentStatus,
            customerId: filter?.customerId ? rawId(filter.customerId) : null,
            channelId: filter?.channelId ? rawId(filter.channelId) : null,
            placedAfter: filter?.placedAfter,
            placedBefore: filter?.placedBefore,
            query: filter?.query,
          },
          page,
        ),
      ),
  }),
  order: t.field({
    type: OrderRef,
    nullable: true,
    description: "By number. Storefront: the signed-in customer's orders only.",
    args: { number: t.arg.string({ required: true }) },
    authScopes: (_r, _a, ctx) => (ctx.api === "admin" ? { permission: "orders:read" } : { customer: true }),
    resolve: async (_r, { number }, ctx) => {
      const order = await findOrderByNumber(ctx.db, number);
      return order && canSeeOrder(ctx, order) ? order : null;
    },
  }),
  guestOrder: t.field({
    type: OrderRef,
    nullable: true,
    subGraphs: STOREFRONT,
    description: "Order status for guests: all three values must match.",
    args: { number: t.arg.string({ required: true }), email: t.arg({ type: "EmailAddress", required: true }), postalCode: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => {
      const order = await findOrderByNumber(ctx.db, args.number);
      const postal = (order?.billingAddress.postalCode ?? "").replace(/\s/g, "").toLowerCase();
      if (!order || order.customerId || order.email !== args.email || postal !== args.postalCode.replace(/\s/g, "").toLowerCase()) return null;
      ctx.loaders.order.prime(order.id, order);
      return order;
    },
  }),
}));

// ---------------------------------------------------------------- mutations

const OrderPayload = builder.simpleObject("OrderPayload", { fields: (t) => ({ order: t.field({ type: OrderRef }) }) });

const TrackingInput = builder.inputType("TrackingNumberInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ carrier: t.string({ required: true }), number: t.string({ required: true }), url: t.string() }),
});
const OrderLineQuantityInput = builder.inputType("OrderLineQuantityInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ orderLineId: t.id({ required: true }), quantity: t.int({ required: true }) }),
});
const OrderFulfillInput = builder.inputType("OrderFulfillInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    locationId: t.globalID({ for: [StockLocationRef], description: "Defaults to the channel stock's first location." }),
    lines: t.field({ type: [OrderLineQuantityInput], description: "Defaults to everything not yet shipped." }),
    tracking: t.field({ type: [TrackingInput] }),
    createShipment: t.boolean({ description: "Book the shipment with a shipping provider first (e.g. buy a label); its tracking is added. See Order.shipmentProviders." }),
    shipmentProvider: t.string({ description: "With createShipment: the provider's code. Defaults to the one behind the order's shipping rate." }),
  }),
});
const RefundLineInput = builder.inputType("RefundLineInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ orderLineId: t.id({ required: true }), quantity: t.int({ required: true }), restock: t.boolean({ description: "Default true." }) }),
});
const OrderRefundInput = builder.inputType("OrderRefundInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ lines: t.field({ type: [RefundLineInput] }), shippingAmount: t.field({ type: "Decimal" }), reason: t.string() }),
});

const orderLineIdOf = (gid: string | number) => {
  const value = String(gid);
  return value.startsWith("gid://ecom/OrderLine/") ? value.slice("gid://ecom/OrderLine/".length) : value;
};

builder.mutationFields((t) => ({
  orderCancel: t.field({
    type: OrderPayload,
    description: "Cancel an unshipped, uncaptured order (customers: their own). Voids the authorization and releases reserved stock.",
    authScopes: (_r, _a, ctx) => (ctx.api === "admin" ? { permission: "orders:write" } : { customer: true }),
    errors: { types: [InvalidStateError] },
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }), reason: t.arg.string() },
    resolve: async (_r, args, ctx) => {
      const order = await getOrder(ctx.db, rawId(args.orderId));
      if (!canSeeOrder(ctx, order)) throw new NotFoundError("Order", args.orderId.id);
      return { order: await cancelOrder(ctx.platform, order.id, { reason: args.reason }, ctx.actor) };
    },
  }),
  orderCapturePayment: t.field({
    type: OrderPayload,
    subGraphs: ADMIN,
    description: "Capture all or part of the outstanding amount and create an invoice.",
    authScopes: { permission: "orders:write" },
    errors: { types: [InvalidStateError] },
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }), amount: t.arg({ type: "Decimal", description: "Defaults to the outstanding amount." }) },
    resolve: async (_r, args, ctx) => ({ order: await capturePayment(ctx.platform, rawId(args.orderId), { amount: args.amount }, ctx.actor) }),
  }),
  orderFulfill: t.field({
    type: OrderPayload,
    subGraphs: ADMIN,
    description:
      "Ship items: deducts stock at the location and turns the reservation into a shipment. With createShipment a provider books it first; if that fails, nothing ships (InvalidStateError).",
    authScopes: { permission: "orders:write" },
    errors: { types: [InvalidStateError] },
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }), input: t.arg({ type: OrderFulfillInput }) },
    resolve: async (_r, { orderId, input }, ctx) => ({
      order: await shipOrder(
        ctx.platform,
        rawId(orderId),
        {
          locationId: input?.locationId ? rawId(input.locationId) : null,
          lines: input?.lines?.map((l) => ({ orderLineId: orderLineIdOf(l.orderLineId), quantity: l.quantity })) ?? null,
          tracking: input?.tracking?.map((x) => ({ carrier: x.carrier, number: x.number, url: x.url ?? null })) ?? null,
          createShipment: input?.createShipment ?? false,
          shipmentProvider: input?.shipmentProvider ?? null,
        },
        ctx.actor,
      ),
    }),
  }),
  orderRefund: t.field({
    type: OrderPayload,
    subGraphs: ADMIN,
    description: "Refund lines (prorated from what was paid) and/or shipping, up to the captured amount.",
    authScopes: { permission: "orders:write" },
    errors: { types: [InvalidStateError] },
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }), input: t.arg({ type: OrderRefundInput, required: true }) },
    resolve: async (_r, { orderId, input }, ctx) => ({
      order: await refundOrder(
        ctx.platform,
        rawId(orderId),
        {
          lines: input.lines?.map((l) => ({ orderLineId: orderLineIdOf(l.orderLineId), quantity: l.quantity, restock: l.restock })) ?? null,
          shippingAmount: input.shippingAmount,
          reason: input.reason,
        },
        ctx.actor,
      ),
    }),
  }),
  orderNoteAdd: t.field({
    type: OrderPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "orders:write" },
    errors: {},
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }), message: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => ({ order: await addOrderNote(ctx.db, rawId(args.orderId), args.message, ctx.actor) }),
  }),
}));

// ---------------------------------------------------------------- subscriptions

const OrderUpdateRef = builder.objectRef<OrderUpdate>("OrderUpdate").implement({
  subGraphs: BOTH,
  fields: (t) => ({
    eventType: t.exposeString("type", { description: "e.g. order.fulfilled" }),
    occurredAt: t.field({ type: "DateTime", resolve: (u) => new Date(u.occurredAt) }),
    status: t.field({ type: OrderStatusEnum, description: "As of this event.", resolve: (u) => u.status as Order["status"] }),
    paymentStatus: t.field({ type: PaymentStatusEnum, description: "As of this event.", resolve: (u) => u.paymentStatus as Order["paymentStatus"] }),
    fulfillmentStatus: t.field({ type: FulfillmentStatusEnum, description: "As of this event.", resolve: (u) => u.fulfillmentStatus as Order["fulfillmentStatus"] }),
    order: t.field({ type: OrderRef, description: "The order now.", resolve: async (u, _a, ctx) => getOrder(ctx.db, u.orderId) }),
  }),
});

builder.subscriptionField("orderUpdated", (t) =>
  t.field({
    type: OrderUpdateRef,
    subGraphs: STOREFRONT,
    description: "Status changes of one of the signed-in customer's orders, after they commit.",
    authScopes: { customer: true },
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }) },
    subscribe: async (_r, { orderId }, ctx) => {
      const order = await getOrder(ctx.db, rawId(orderId)).catch(() => null);
      if (!canSeeOrder(ctx, order)) throw new PermissionDeniedError("orders:read");
      return ctx.platform.pubsub.subscribe("orderUpdated", rawId(orderId));
    },
    resolve: (update) => update,
  }),
);

builder.subscriptionField("orderActivity", (t) =>
  t.field({
    type: OrderUpdateRef,
    subGraphs: ADMIN,
    description: "Every order event in the store as it commits: new orders, payments, shipments, refunds.",
    authScopes: { permission: "orders:read" },
    subscribe: (_r, _a, ctx) => ctx.platform.pubsub.subscribe("orderActivity"),
    resolve: (update) => update,
  }),
);

// ---------------------------------------------------------------- orders created by staff

const OrderDraftLineInput = builder.inputType("OrderDraftLineInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ variantId: t.globalID({ for: [ProductVariantRef], required: true }), quantity: t.int({ required: true }) }),
});

const OrderDraftInput = builder.inputType("OrderDraftInput", {
  subGraphs: ADMIN,
  description: "A complete draft. Send it to orderDraftQuote while editing and to orderCreate to place it.",
  fields: (t) => ({
    channelId: t.globalID({ for: [ChannelRef], required: true }),
    currency: t.field({ type: "CurrencyCode", description: "Defaults to the channel's." }),
    locale: t.field({ type: "LocaleCode", description: "Defaults to the channel's." }),
    customerId: t.globalID({ for: [CustomerRef], description: "Omit for a guest order (then email is required)." }),
    email: t.field({ type: "EmailAddress", description: "Defaults to the customer's." }),
    lines: t.field({ type: [OrderDraftLineInput], required: true }),
    shippingAddress: t.field({ type: AddressInput }),
    billingAddress: t.field({ type: AddressInput }),
    billingSameAsShipping: t.boolean(),
    shippingMethodCode: t.string(),
    paymentMethodCode: t.string(),
    couponCodes: t.stringList(),
    note: t.string({ description: "Added to the order timeline." }),
  }),
});

type DraftInputArgs = typeof OrderDraftInput.$inferInput;
const toDraft = (input: DraftInputArgs) => ({
  channelId: rawId(input.channelId),
  currency: input.currency ?? null,
  locale: input.locale ?? null,
  customerId: input.customerId ? rawId(input.customerId) : null,
  email: input.email ?? null,
  lines: input.lines.map((l) => ({ variantId: rawId(l.variantId), quantity: l.quantity })),
  shippingAddress: input.shippingAddress ?? null,
  billingAddress: input.billingAddress ?? null,
  billingSameAsShipping: input.billingSameAsShipping ?? null,
  shippingMethodCode: input.shippingMethodCode ?? null,
  paymentMethodCode: input.paymentMethodCode ?? null,
  couponCodes: input.couponCodes ?? null,
  note: input.note ?? null,
});

type QuoteLine = DraftOrderQuote["lines"][number] & { currency: string };
const optionalMoney = (amount: number | null, currency: string) => (amount === null ? null : money(amount, currency));

const OrderDraftQuoteLineRef = builder.objectRef<QuoteLine>("OrderDraftQuoteLine").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    variant: t.field({ type: ProductVariantRef, resolve: async (l, _a, ctx) => (await ctx.loaders.variant.load(l.variantId))! }),
    sku: t.string({ resolve: (l) => l.sku }),
    name: t.string({ resolve: (l) => l.name }),
    quantity: t.int({ resolve: (l) => l.quantity }),
    unitPrice: t.field({ type: MoneyRef, nullable: true, resolve: (l) => optionalMoney(l.unitPrice, l.currency) }),
    subtotal: t.field({ type: MoneyRef, nullable: true, resolve: (l) => optionalMoney(l.subtotal, l.currency) }),
    discount: t.field({ type: MoneyRef, nullable: true, resolve: (l) => optionalMoney(l.discount, l.currency) }),
    tax: t.field({ type: MoneyRef, nullable: true, resolve: (l) => optionalMoney(l.tax, l.currency) }),
    total: t.field({ type: MoneyRef, nullable: true, resolve: (l) => optionalMoney(l.total, l.currency) }),
    salableQuantity: t.int({ resolve: (l) => l.salableQuantity }),
    issue: t.field({ type: CartLineIssueRef, nullable: true, resolve: (l) => l.issue as { code: "UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | "NO_PRICE"; message: string } | null }),
  }),
});

const OrderDraftQuoteRef = builder.objectRef<DraftOrderQuote>("OrderDraftQuote").implement({
  subGraphs: ADMIN,
  description: "The draft priced exactly as checkout would, without creating anything.",
  fields: (t) => ({
    currencyCode: t.field({ type: "CurrencyCode", resolve: (q) => q.currency }),
    requiresShipping: t.boolean({ resolve: (q) => q.requiresShipping }),
    lines: t.field({ type: [OrderDraftQuoteLineRef], resolve: (q) => q.lines.map((l) => ({ ...l, currency: q.currency })) }),
    subtotal: t.field({ type: MoneyRef, resolve: (q) => money(q.subtotal, q.currency) }),
    discountTotal: t.field({ type: MoneyRef, resolve: (q) => money(q.discountTotal, q.currency) }),
    shipping: t.field({ type: MoneyRef, resolve: (q) => money(q.shippingTotal, q.currency) }),
    tax: t.field({ type: MoneyRef, resolve: (q) => money(q.taxTotal, q.currency) }),
    total: t.field({ type: MoneyRef, resolve: (q) => money(q.grandTotal, q.currency) }),
    discounts: t.field({ type: [AppliedDiscountRef], resolve: (q) => q.discounts.map((d) => ({ name: d.name, couponCode: d.couponCode, amount: money(d.amount, q.currency) })) }),
    taxLines: t.field({ type: [TaxLineRef], resolve: (q) => q.taxLines.map((x) => ({ ...x, amount: money(x.amount, q.currency) })) }),
    shippingRates: t.field({ type: [ShippingRateRef], description: "Rates for the shipping address.", resolve: (q) => q.shippingRates.map((r) => ({ ...r, currency: q.currency })) }),
    selectedShippingMethodCode: t.string({ nullable: true, resolve: (q) => q.selectedShippingMethodCode }),
    paymentMethods: t.field({ type: [PaymentMethodOptionRef], resolve: (q) => q.paymentMethods }),
    coupons: t.field({ type: [CartCouponRef], resolve: (q) => q.coupons }),
    missing: t.field({ type: [CartRequirement], description: "What orderCreate still needs. Empty means ready.", resolve: (q) => q.missing as (typeof CartRequirement.$inferType)[] }),
  }),
});

builder.queryFields((t) => ({
  orderDraftQuote: t.field({
    type: OrderDraftQuoteRef,
    subGraphs: ADMIN,
    authScopes: { permission: "orders:write" },
    args: { input: t.arg({ type: OrderDraftInput, required: true }) },
    resolve: (_r, { input }, ctx) => quoteDraftOrder(ctx.db, toDraft(input), quoteProviders(ctx.platform)),
  }),
}));

builder.mutationFields((t) => ({
  orderCreate: t.field({
    type: OrderPayload,
    subGraphs: ADMIN,
    description: "Place an order for a customer or guest, through the same checkout as the storefront.",
    authScopes: { permission: "orders:write" },
    errors: { types: [CartNotReadyError, InsufficientStockError, PaymentDeclinedError, InvalidStateError] },
    args: { input: t.arg({ type: OrderDraftInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      order: await placeDraftOrder(ctx.platform, toDraft(input), ctx.actor, ctx.staff?.email ?? ctx.apiKey?.name ?? "an integration"),
    }),
  }),
  orderUpdateAddresses: t.field({
    type: OrderPayload,
    subGraphs: ADMIN,
    description: "Correct the addresses of an open order. The shipping address is fixed once anything has shipped.",
    authScopes: { permission: "orders:write" },
    errors: { types: [InvalidStateError] },
    args: { orderId: t.arg.globalID({ for: [OrderRef], required: true }), shippingAddress: t.arg({ type: AddressInput }), billingAddress: t.arg({ type: AddressInput }) },
    resolve: async (_r, args, ctx) => ({
      order: await updateOrderAddresses(ctx.db, rawId(args.orderId), { shippingAddress: args.shippingAddress ?? undefined, billingAddress: args.billingAddress ?? undefined }, ctx.actor),
    }),
  }),
}));
