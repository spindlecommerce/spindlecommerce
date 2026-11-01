import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { completeAddress } from "../../lib/address.ts";
import { CartNotReadyError, InsufficientStockError, InvalidStateError, NotFoundError, PaymentDeclinedError, ValidationError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import type { Platform } from "../../platform.ts";
import type { CheckoutValidateInput } from "../../plugins/sdk.ts";
import { buildQuote, quoteProviders, type Quote } from "../carts/quote.ts";
import { getCartForActor, updateCart, type Cart, type CartUpdate } from "../carts/service.ts";
import { carts, type CartPaymentSession } from "../carts/tables.ts";
import { formatDocumentNumber, nextSequenceValue } from "../channels/service.ts";
import { emit } from "../integrations/outbox.ts";
import { compensateReservations, reserveStock } from "../inventory/service.ts";
import { getOrder, type Order } from "../orders/read.ts";
import { appendOrderEvent, orderEvent } from "../orders/service.ts";
import { orderLines, orders } from "../orders/tables.ts";
import { lockOrderForPayment, recordAuthorized, recordCaptured, recordPending } from "../payments/ledger.ts";
import { withoutAvailabilityChecks, type PaymentProvider } from "../payments/providers.ts";
import { findPaymentMethod, recordTransaction } from "../payments/service.ts";
import { coupons, promotions, promotionUsages } from "../promotions/tables.ts";
import { recordPromotionUsage } from "../promotions/service.ts";
import { reindexProducts } from "../search/projector.ts";

export type CheckoutActor = { customerId: string | null };

const scopedKey = (cartId: string, key: string) => `${cartId}:${key}`;

/** The cart can't become an order as it is; its session's payment is then released. */
const refusesCart = (error: unknown) => error instanceof CartNotReadyError || error instanceof InsufficientStockError || error instanceof ValidationError;

/**
 * Slow checks run first, outside any transaction. One transaction locks the cart, reserves stock
 * and writes the order; payment is authorized after it, and a decline reverses it (stock, promotion
 * usage, the cart). The same idempotency key, or any key once the cart is an order, returns that
 * order. `details` are saved to the cart first and stay there if no order is placed.
 */
export const placeOrder = async (
  platform: Platform,
  input: { cartId: string; idempotencyKey: string; paymentData?: Record<string, unknown> | null; details?: CartUpdate | null },
  actor: CheckoutActor,
): Promise<Order> => {
  const { db } = platform;
  const key = scopedKey(input.cartId, input.idempotencyKey);
  const replay = await db.query.orders.findFirst({ where: eq(orders.idempotencyKey, key) });
  if (replay) return replay;

  let cart = await getCartForActor(db, input.cartId, actor);
  if (cart.status === "converted" && cart.convertedOrderId) return getOrder(db, cart.convertedOrderId);
  if (cart.status !== "active") throw new InvalidStateError(`The cart is ${cart.status}`);

  let placed: Awaited<ReturnType<typeof writeOrder>>;
  try {
    if (input.details) cart = await updateCart(db, cart.id, input.details, actor, quoteProviders(platform));
    await checkCart(platform, cart);
    placed = await writeOrder(platform, cart.id, key, actor);
  } catch (error) {
    if (refusesCart(error)) await releaseSessionPayment(platform, cart, (error as Error).message);
    throw error;
  }
  if (!placed.created) return placed.order;
  return authorizePayment(platform, placed.order, placed.session, input.paymentData ?? {});
};

const validateInput = (quote: Quote): CheckoutValidateInput => ({
  cartId: quote.cart.id,
  channelId: quote.channel.id,
  customerId: quote.cart.customerId,
  email: quote.cart.email,
  currency: quote.cart.currency,
  grandTotal: quote.totals.grandTotal,
  shippingAddress: quote.requiresShipping ? completeAddress(quote.cart.shippingAddress) : null,
  billingAddress: completeAddress(quote.billingAddress),
  shippingMethodCode: quote.selectedShippingRate?.code ?? null,
  paymentMethodCode: quote.cart.paymentMethodCode,
  lines: quote.lines.map((l) => ({ productId: l.product.id, variantId: l.variant.id, sku: l.variant.sku, quantity: l.line.quantity, unitPrice: l.unitPrice ?? 0 })),
});

/** Checks completeness, payment method availability and plugins; issues become field errors. */
const checkCart = async (platform: Platform, cart: Cart) => {
  const quote = await buildQuote(platform.db, cart, quoteProviders(platform, { liveRates: false }));
  if (quote.missing.length > 0) throw new CartNotReadyError(quote.missing, quote.missingFields);
  const issues = await platform.plugins.checkoutValidate(validateInput(quote));
  if (issues.length > 0) {
    throw new ValidationError(issues.length === 1 ? issues[0]!.message : "The order cannot be placed", issues.map((i) => ({ path: i.field ?? ["cartId"], message: i.message })));
  }
};

const writeOrder = (platform: Platform, cartId: string, key: string, actor: CheckoutActor) =>
  platform.db.transaction(async (tx): Promise<{ order: Order; created: boolean; session: CartPaymentSession | null }> => {
    const [cart] = await tx.select().from(carts).where(eq(carts.id, cartId)).for("update");
    if (!cart || (cart.customerId && cart.customerId !== actor.customerId)) throw new NotFoundError("Cart", cartId);
    // Placed meanwhile by another request, such as the PSP's webhook.
    if (cart.status === "converted" && cart.convertedOrderId) return { order: await getOrder(tx, cart.convertedOrderId), created: false, session: null };
    if (cart.status !== "active") throw new InvalidStateError(`The cart is ${cart.status}`);
    // Nothing slow while the cart row is locked: cached shipping rates, no availability checks.
    const quote = await buildQuote(tx, cart, { ...quoteProviders(platform, { liveRates: false }), payments: withoutAvailabilityChecks(platform.payments) });
    if (quote.missing.length > 0) throw new CartNotReadyError(quote.missing, quote.missingFields);
    const { channel, totals } = quote;
    const orderId = newId();
    if (channel.stockId) {
      await reserveStock(
        tx,
        channel.stockId,
        quote.lines.map((l) => ({ variantId: l.variant.id, sku: l.variant.sku, quantity: l.line.quantity, trackInventory: l.variant.trackInventory, allowBackorder: l.variant.allowBackorder })),
        orderId,
      );
    }
    const number = formatDocumentNumber(channel.orderNumberPrefix, await nextSequenceValue(tx, `order:${channel.id}`));
    const [created] = await tx
      .insert(orders)
      .values({
        id: orderId,
        number,
        channelId: channel.id,
        customerId: cart.customerId,
        cartId: cart.id,
        email: cart.email!,
        currency: cart.currency,
        locale: cart.locale,
        customerGroupId: quote.customerGroupId,
        // Complete: nothing is missing.
        shippingAddress: quote.requiresShipping ? completeAddress(cart.shippingAddress)! : null,
        billingAddress: completeAddress(quote.billingAddress)!,
        shippingMethod: quote.selectedShippingRate
          ? {
              code: quote.selectedShippingRate.code,
              name: quote.selectedShippingRate.name,
              carrier: quote.selectedShippingRate.carrier,
              amount: totals.shippingTotal,
              details: quote.selectedShippingRate.details ?? null,
            }
          : null,
        paymentMethodCode: cart.paymentMethodCode!,
        pricesIncludeTax: channel.pricesIncludeTax,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal + totals.shippingDiscount,
        shippingTotal: totals.shippingTotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        totals: { taxLines: totals.taxLines, discounts: totals.discounts, shippingDiscount: totals.shippingDiscount },
        couponCodes: quote.coupons.filter((c) => c.applied).map((c) => c.code),
        idempotencyKey: key,
      })
      .returning();
    await tx.insert(orderLines).values(
      quote.lines.map((l, position) => ({
        orderId,
        variantId: l.variant.id,
        productId: l.product.id,
        sku: l.variant.sku,
        name: l.name,
        variantAttributes: Object.fromEntries(Object.entries(l.variant.attributes).map(([k, v]) => [k, String(v)])),
        quantity: l.line.quantity,
        unitPrice: l.unitPrice!,
        subtotal: l.totals!.subtotal,
        discountTotal: l.totals!.discount,
        taxTotal: l.totals!.tax,
        total: l.totals!.total,
        taxRate: String(l.totals!.taxRate),
        isShippable: quote.requiresShipping,
        weightGrams: l.variant.weightGrams,
        position,
      })),
    );
    await recordPromotionUsage(tx, {
      orderId,
      customerId: cart.customerId,
      applied: [...new Map(totals.discounts.map((d) => [d.promotionId, d])).values()].map((d) => ({ promotionId: d.promotionId, couponCode: d.couponCode })),
    });
    await tx.update(carts).set({ status: "converted", convertedOrderId: orderId, updatedAt: new Date() }).where(eq(carts.id, cart.id));
    await appendOrderEvent(tx, orderId, { type: "placed", message: `Order ${number} placed`, actor: { type: actor.customerId ? "customer" : "system", id: actor.customerId } });
    await emit(
      tx,
      orderEvent("order.placed", created!, { grandTotal: totals.grandTotal, currency: cart.currency }),
      { type: "cart.converted", aggregateType: "Cart", aggregateId: cart.id, payload: { orderId } },
    );
    await reindexProducts(tx, quote.lines.map((l) => l.product.id));
    return { order: created!, created: true, session: cart.paymentSession };
  });

const authorizePayment = async (platform: Platform, order: Order, session: CartPaymentSession | null, paymentData: Record<string, unknown>): Promise<Order> => {
  const { db } = platform;
  const method = await findPaymentMethod(db, order.paymentMethodCode);
  const provider = platform.payments.get(method.provider);
  if (!provider) throw new InvalidStateError(`Payment provider ${method.provider} is not installed`);
  const sessionData = session?.provider === method.provider ? session.data : null;
  let result;
  try {
    result = await provider.authorize({
      orderId: order.id,
      orderNumber: order.number,
      cartId: order.cartId,
      session: sessionData,
      amount: order.grandTotal,
      currency: order.currency,
      paymentData,
      captureImmediately: method.config.captureMode === "authorize_capture",
    });
  } catch (error) {
    if (error instanceof PaymentDeclinedError) {
      await rollbackDeclinedOrder(db, order, method.provider, error);
      // A session payment that does not match the order (the cart changed after paying) goes back.
      if (sessionData && order.cartId) await releasePayment(platform, provider, { cartId: order.cartId, session: sessionData }, `Payment declined (${error.declineCode})`);
    }
    throw error;
  }
  const entry = { method, pspReference: result.pspReference, raw: result.raw ?? {} };
  return db.transaction(async (tx) => {
    // The PSP's webhook may have recorded the payment meanwhile; the ledger records only the rest.
    const locked = (await lockOrderForPayment(tx, order.id))!;
    if (result.status === "pending") return recordPending(tx, locked, entry);
    if (result.status === "authorized") return recordAuthorized(tx, locked, { ...entry, amount: order.grandTotal });
    return recordCaptured(tx, locked, { ...entry, capturedTotal: order.grandTotal });
  });
};

const rollbackDeclinedOrder = async (db: Database, order: Order, provider: string, error: PaymentDeclinedError) =>
  db.transaction(async (tx) => {
    await recordTransaction(tx, {
      orderId: order.id,
      paymentMethodCode: order.paymentMethodCode,
      provider,
      kind: "authorization",
      status: "failed",
      amount: order.grandTotal,
      currency: order.currency,
      errorMessage: `${error.declineCode}: ${error.message}`,
    });
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    const channel = await tx.query.channels.findFirst({ where: (c, { eq: e }) => e(c.id, order.channelId) });
    if (channel?.stockId) await compensateReservations(tx, channel.stockId, lines.flatMap((l) => (l.variantId ? [{ variantId: l.variantId, quantity: l.quantity }] : [])), "order_canceled", order.id);
    const usages = await tx.select().from(promotionUsages).where(eq(promotionUsages.orderId, order.id));
    for (const usage of usages) {
      await tx.update(promotions).set({ timesUsed: sql`greatest(${promotions.timesUsed} - 1, 0)` }).where(eq(promotions.id, usage.promotionId));
      if (usage.couponId) await tx.update(coupons).set({ timesUsed: sql`greatest(${coupons.timesUsed} - 1, 0)` }).where(eq(coupons.id, usage.couponId));
    }
    await tx.delete(promotionUsages).where(eq(promotionUsages.orderId, order.id));
    const [canceled] = await tx
      .update(orders)
      .set({ status: "canceled", paymentStatus: "voided", canceledAt: new Date(), idempotencyKey: null, updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    if (order.cartId) await tx.update(carts).set({ status: "active", convertedOrderId: null, updatedAt: new Date() }).where(and(eq(carts.id, order.cartId), eq(carts.status, "converted")));
    await appendOrderEvent(tx, order.id, { type: "payment_failed", message: `Payment declined (${error.declineCode}); order canceled` });
    await emit(tx, orderEvent("order.payment_failed", canceled!, { declineCode: error.declineCode }), orderEvent("order.canceled", canceled!, { reason: "payment_declined" }));
    await reindexProducts(tx, lines.flatMap((l) => (l.productId ? [l.productId] : [])));
  });

/**
 * Best-effort release of what a checkout's payment secured when it placed no order. Logged either
 * way, as staff may have to act in the PSP's dashboard.
 */
export const releasePayment = async (
  platform: Platform,
  provider: PaymentProvider,
  payment: { cartId: string; pspReference?: string | null; session?: Record<string, unknown> | null },
  reason: string,
) => {
  const context = { cartId: payment.cartId, provider: provider.code, pspReference: payment.pspReference ?? null, reason };
  try {
    const result = await provider.void({ orderId: "", pspReference: payment.pspReference ?? null, session: payment.session ?? null });
    platform.logger.info({ ...context, result }, "Released the payment of a checkout that placed no order");
  } catch (error) {
    platform.logger.error({ ...context, err: error }, "Could not release the payment of a checkout that placed no order: release it with the PSP");
  }
};

const releaseSessionPayment = async (platform: Platform, cart: Cart, reason: string) => {
  const provider = cart.paymentSession ? platform.payments.get(cart.paymentSession.provider) : undefined;
  if (provider) await releasePayment(platform, provider, { cartId: cart.id, session: cart.paymentSession!.data }, reason);
};

export type CartPaymentSessionResult = { provider: string; methodCode: string; amount: number; currency: string; clientData: Record<string, unknown> };

/**
 * Start the PSP payment for the cart's total (e.g. a payment intent), or update it after the total
 * changes. Providers without sessions return no client data.
 */
export const createCartPaymentSession = async (platform: Platform, cartId: string, actor: CheckoutActor): Promise<CartPaymentSessionResult> => {
  const { db } = platform;
  const cart = await getCartForActor(db, cartId, actor);
  if (cart.status !== "active") throw new InvalidStateError(`The cart is ${cart.status}`);
  const quote = await buildQuote(db, cart, quoteProviders(platform));
  const option = quote.paymentMethods.find((m) => m.code === cart.paymentMethodCode);
  const missing = [...(quote.lines.length === 0 ? ["lines"] : []), ...(option ? [] : ["payment_method"])];
  if (missing.length > 0) throw new CartNotReadyError(missing);
  const method = await findPaymentMethod(db, option!.code);
  const provider = platform.payments.get(method.provider)!;
  const base = { provider: provider.code, methodCode: method.code, amount: quote.totals.grandTotal, currency: cart.currency };
  if (!provider.createSession) return { ...base, clientData: {} };
  const previous = cart.paymentSession?.provider === provider.code ? cart.paymentSession : null;
  const session = await provider.createSession({
    cartId: cart.id,
    methodCode: method.code,
    amount: base.amount,
    currency: cart.currency,
    locale: cart.locale,
    email: cart.email,
    customerId: cart.customerId,
    billingAddress: completeAddress(quote.billingAddress),
    shippingAddress: completeAddress(cart.shippingAddress),
    lines: quote.lines.flatMap((l) => (l.totals && l.unitPrice !== null ? [{ sku: l.variant.sku, name: l.name, quantity: l.line.quantity, unitPrice: l.unitPrice, total: l.totals.total }] : [])),
    captureImmediately: method.config.captureMode === "authorize_capture",
    previous: previous?.data ?? null,
  });
  const now = new Date().toISOString();
  const stored: CartPaymentSession = { ...base, data: session.data, createdAt: previous?.createdAt ?? now, updatedAt: now };
  // Not a change the shopper made, so the cart's version stays.
  const [saved] = await db.update(carts).set({ paymentSession: stored, updatedAt: new Date() }).where(and(eq(carts.id, cart.id), eq(carts.status, "active"))).returning({ id: carts.id });
  if (!saved) throw new InvalidStateError("The cart is no longer open");
  return { ...base, clientData: session.clientData };
};
