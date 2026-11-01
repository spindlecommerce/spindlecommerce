import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { DomainError } from "../../lib/errors.ts";
import { isUuid } from "../../lib/ids.ts";
import type { Platform } from "../../platform.ts";
import type { PaymentWebhookEvent } from "../../plugins/sdk.ts";
import { carts } from "../carts/tables.ts";
import { placeOrder, releasePayment } from "../checkout/service.ts";
import type { Order } from "../orders/read.ts";
import { orders } from "../orders/tables.ts";
import {
  isRecorded,
  lockOrderForPayment,
  recordAuthorized,
  recordCaptured,
  recordDispute,
  recordExternalRefund,
  recordPaymentCanceled,
  recordPaymentFailed,
  type PaymentEntry,
} from "./ledger.ts";
import type { PaymentProvider } from "./providers.ts";
import { paymentMethods, paymentTransactions } from "./tables.ts";

/**
 * What makes an event's effect unique. Refunds go by their own reference: one PSP event may list
 * several, and later events list them again.
 */
export const eventReferenceKey = (provider: string, event: PaymentWebhookEvent) =>
  event.type === "refunded" && event.refundReference ? `${provider}:refund:${event.refundReference}` : `${provider}:${event.id}`;

const securesMoney = (event: PaymentWebhookEvent) => event.type === "authorized" || event.type === "captured";

/** Unexpected failures throw so the PSP retries; events already applied are skipped then. */
export const applyPaymentWebhookEvents = async (platform: Platform, provider: PaymentProvider, events: PaymentWebhookEvent[]) => {
  for (const event of events) await applyEvent(platform, provider, event);
};

const applyEvent = async (platform: Platform, provider: PaymentProvider, event: PaymentWebhookEvent) => {
  const { db } = platform;
  const referenceKey = eventReferenceKey(provider.code, event);
  if (await isRecorded(db, referenceKey)) return;
  const log = platform.logger.child({ provider: provider.code, eventId: event.id, eventType: event.type, pspReference: event.pspReference });
  const found = await findOrder(platform, provider, event);
  if (found === "foreign") {
    // A second payment for a cart whose order paid with another (e.g. from two tabs): nothing uses it.
    if (securesMoney(event)) await releasePayment(platform, provider, { cartId: event.cartId ?? "", pspReference: event.pspReference }, "The cart's order paid with another payment");
    return;
  }
  const order = found ?? (securesMoney(event) && event.cartId ? await placeFromCart(platform, provider, event, log) : null);
  if (!order) {
    log.info("No order for this payment event; ignored");
    return;
  }
  if (event.currency && event.currency.toUpperCase() !== order.currency) {
    log.warn({ orderId: order.id, currency: event.currency }, "The payment event is in another currency than its order; ignored");
    return;
  }
  const method = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.code, order.paymentMethodCode) });
  if (!method || method.provider !== provider.code) {
    log.warn({ orderId: order.id }, "The order pays with another provider; ignored");
    return;
  }
  const entry: PaymentEntry = { method, pspReference: event.pspReference, raw: event.raw ?? {}, referenceKey, source: `reported by ${provider.code}` };
  const reason = event.reason ?? null;
  await db.transaction(async (tx) => {
    const locked = await lockOrderForPayment(tx, order.id);
    // A concurrent delivery may have recorded it while this one waited for the lock.
    if (!locked || (await isRecorded(tx, referenceKey))) return;
    switch (event.type) {
      case "authorized":
        return recordAuthorized(tx, locked, { ...entry, amount: event.amount ?? locked.grandTotal });
      case "captured":
        return recordCaptured(tx, locked, { ...entry, capturedTotal: event.amount ?? locked.grandTotal });
      case "failed":
        return recordPaymentFailed(tx, locked, { ...entry, amount: event.amount ?? locked.grandTotal, reason });
      case "canceled":
        return recordPaymentCanceled(tx, locked, { ...entry, reason });
      case "refunded":
        if (!event.refundReference || event.amount === undefined) {
          log.warn("A refund event without a refund reference or amount; ignored");
          return;
        }
        return recordExternalRefund(tx, locked, { ...entry, amount: event.amount, refundReference: event.refundReference, reason });
      case "dispute_opened":
      case "dispute_closed":
        return recordDispute(tx, locked, { ...entry, referenceKey, opened: event.type === "dispute_opened", amount: event.amount ?? null, reason });
    }
  });
  log.info({ orderId: order.id }, "Applied a payment event");
};

const orderById = async (platform: Platform, id: string | null | undefined) =>
  id && isUuid(id) ? ((await platform.db.query.orders.findFirst({ where: eq(orders.id, id) })) ?? null) : null;

/**
 * By payment reference, else the order the cart became, else the PSP's metadata. "foreign": that
 * order paid with another payment of this provider, so the event is about an older or second one.
 */
const findOrder = async (platform: Platform, provider: PaymentProvider, event: PaymentWebhookEvent): Promise<Order | "foreign" | null> => {
  const { db } = platform;
  const payments = (orderId?: string) =>
    db
      .select({ orderId: paymentTransactions.orderId, pspReference: paymentTransactions.pspReference })
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, provider.code),
          inArray(paymentTransactions.kind, ["authorization", "capture"]),
          inArray(paymentTransactions.status, ["succeeded", "pending"]),
          orderId ? eq(paymentTransactions.orderId, orderId) : eq(paymentTransactions.pspReference, event.pspReference),
        ),
      );
  const [byPayment] = await payments();
  if (byPayment) return orderById(platform, byPayment.orderId);
  const cart = event.cartId && isUuid(event.cartId) ? await db.query.carts.findFirst({ where: eq(carts.id, event.cartId) }) : undefined;
  // An open cart has no order yet; without a cart, trust the metadata.
  const candidate = cart ? (cart.status === "converted" ? await orderById(platform, cart.convertedOrderId) : null) : await orderById(platform, event.orderId);
  if (!candidate) return null;
  const references = (await payments(candidate.id)).map((p) => p.pspReference).filter(Boolean);
  return references.length === 0 || references.includes(event.pspReference) ? candidate : "foreign";
};

/**
 * For shoppers who paid but never came back from the PSP: place the order as checkout would. The
 * idempotency key comes from the payment, so redeliveries place nothing twice.
 */
const placeFromCart = async (platform: Platform, provider: PaymentProvider, event: PaymentWebhookEvent, log: Logger): Promise<Order | null> => {
  const { db } = platform;
  const cart = await db.query.carts.findFirst({ where: eq(carts.id, event.cartId!) });
  if (!cart || cart.status !== "active") return null;
  const method = cart.paymentMethodCode ? await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.code, cart.paymentMethodCode) }) : undefined;
  if (method?.provider !== provider.code) {
    // The customer chose another way to pay after this payment: nothing will use it.
    await releasePayment(platform, provider, { cartId: cart.id, pspReference: event.pspReference }, "The cart no longer pays with this provider");
    return null;
  }
  try {
    const order = await placeOrder(
      platform,
      { cartId: cart.id, idempotencyKey: `${provider.code}:${event.pspReference}`, paymentData: { pspReference: event.pspReference } },
      { customerId: cart.customerId },
    );
    log.info({ orderId: order.id, cartId: cart.id }, "Placed the order of a customer who paid but did not come back");
    return order;
  } catch (error) {
    // Checkout refused it: placeOrder released the payment, and a retry would change nothing.
    if (error instanceof DomainError) {
      log.warn({ err: error, cartId: cart.id }, "Could not place the order of a paid cart");
      return null;
    }
    throw error;
  }
};
