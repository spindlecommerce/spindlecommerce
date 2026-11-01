import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { toDecimalString } from "../../lib/money.ts";
import { formatDocumentNumber, nextSequenceValue } from "../channels/service.ts";
import { emit } from "../integrations/outbox.ts";
import type { Order } from "../orders/read.ts";
import { appendOrderEvent, orderEvent } from "../orders/service.ts";
import { invoices, orderEvents, orderLines, orders, refunds } from "../orders/tables.ts";
import { recordTransaction } from "./service.ts";
import { paymentTransactions } from "./tables.ts";

/**
 * Payment state as the PSP reports it. Run each function in a transaction on an order locked with
 * lockOrderForPayment: it records only what is new, so a payment reported twice counts once.
 */

export type PaymentEntry = {
  method: { code: string; provider: string };
  pspReference: string | null;
  raw?: Record<string, unknown>;
  /** Makes the transaction unique (payment_transactions.reference_key), e.g. `stripe:evt_…`. */
  referenceKey?: string | null;
  /** Who reported it, appended to order event messages, e.g. "reported by stripe". */
  source?: string;
};

export const lockOrderForPayment = async (db: Database, orderId: string): Promise<Order | null> =>
  (await db.select().from(orders).where(eq(orders.id, orderId)).for("update"))[0] ?? null;

const save = async (db: Database, id: string, patch: Partial<typeof orders.$inferInsert>) =>
  (await db.update(orders).set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: new Date() }).where(eq(orders.id, id)).returning())[0]!;

const suffix = (entry: PaymentEntry) => (entry.source ? ` (${entry.source})` : "");
const amountText = (amount: number, currency: string) => `${toDecimalString(amount, currency)} ${currency}`;

const transactionBase = (order: Order, entry: PaymentEntry) => ({
  orderId: order.id,
  paymentMethodCode: entry.method.code,
  provider: entry.method.provider,
  currency: order.currency,
  pspReference: entry.pspReference,
  raw: entry.raw ?? {},
  referenceKey: entry.referenceKey ?? null,
});

/** As after a capture in the admin: paid in full with nothing left to ship completes the order. */
const completeIfDone = async (db: Database, order: Order) => {
  if (order.status !== "open" || order.paymentStatus !== "paid") return order;
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  if (lines.some((l) => l.isShippable && l.quantityFulfilled + l.quantityCanceled + l.quantityRefunded < l.quantity)) return order;
  const completed = await save(db, order.id, { status: "completed", completedAt: new Date() });
  await appendOrderEvent(db, order.id, { type: "completed", message: "Order completed" });
  await emit(db, orderEvent("order.completed", completed));
  return completed;
};

export const isRecorded = async (db: Database, referenceKey: string) =>
  (await db.select({ id: paymentTransactions.id }).from(paymentTransactions).where(eq(paymentTransactions.referenceKey, referenceKey)).limit(1)).length > 0;

/** Not settled yet, e.g. a bank debit; webhooks find the order by the pending pspReference. */
export const recordPending = async (db: Database, order: Order, entry: PaymentEntry) => {
  if (entry.pspReference) await recordTransaction(db, { ...transactionBase(order, entry), kind: "authorization", status: "pending", amount: order.grandTotal });
  await appendOrderEvent(db, order.id, { type: "payment_pending", message: `Awaiting ${entry.method.code} payment${suffix(entry)}` });
  return order;
};

export const recordAuthorized = async (db: Database, order: Order, entry: PaymentEntry & { amount: number }) => {
  if (order.paymentStatus !== "pending") return order;
  const transaction = await recordTransaction(db, { ...transactionBase(order, entry), kind: "authorization", status: "succeeded", amount: entry.amount });
  const saved = await save(db, order.id, { paymentStatus: "authorized", amountAuthorized: entry.amount });
  await appendOrderEvent(db, order.id, { type: "payment_authorized", message: `Payment authorized via ${entry.method.code}${suffix(entry)}`, data: { transactionId: transaction.id } });
  await emit(db, orderEvent("order.payment_authorized", saved, { amount: entry.amount }));
  return saved;
};

/** `capturedTotal` is the PSP's total so far; only the part not yet recorded is added. */
export const recordCaptured = async (db: Database, order: Order, entry: PaymentEntry & { capturedTotal: number }) => {
  const current = order.paymentStatus === "pending" ? await recordAuthorized(db, order, { ...entry, referenceKey: null, amount: order.grandTotal }) : order;
  const amount = entry.capturedTotal - current.amountCaptured;
  if (amount <= 0) return current;
  const capture = await recordTransaction(db, { ...transactionBase(current, entry), kind: "capture", status: "succeeded", amount });
  const invoiceNumber = formatDocumentNumber("INV-", await nextSequenceValue(db, "invoice"));
  await db.insert(invoices).values({ orderId: order.id, number: invoiceNumber, amount, transactionId: capture.id });
  const captured = current.amountCaptured + amount;
  const saved = await save(db, order.id, { amountCaptured: captured, amountAuthorized: Math.max(current.amountAuthorized, captured), paymentStatus: captured >= current.grandTotal ? "paid" : "partially_paid" });
  await appendOrderEvent(db, order.id, {
    type: "payment_captured",
    message: `Captured ${amountText(amount, order.currency)} (${invoiceNumber})${suffix(entry)}`,
    data: { transactionId: capture.id, invoiceNumber, amount },
  });
  await emit(db, orderEvent("order.payment_captured", saved, { amount, invoiceNumber }));
  return completeIfDone(db, saved);
};

/** A failed attempt while awaiting payment; the order stays open for staff to follow up. */
export const recordPaymentFailed = async (db: Database, order: Order, entry: PaymentEntry & { amount: number; reason: string | null }) => {
  if (order.paymentStatus !== "pending") return order;
  await recordTransaction(db, { ...transactionBase(order, entry), kind: "authorization", status: "failed", amount: entry.amount, errorMessage: entry.reason });
  await appendOrderEvent(db, order.id, { type: "payment_failed", message: `Payment failed${entry.reason ? `: ${entry.reason}` : ""}${suffix(entry)}` });
  await emit(db, orderEvent("order.payment_failed", order, { reason: entry.reason }));
  return order;
};

/** Authorization expired or canceled at the PSP: nothing is left to capture. */
export const recordPaymentCanceled = async (db: Database, order: Order, entry: PaymentEntry & { reason: string | null }) => {
  if (!["pending", "authorized"].includes(order.paymentStatus) || order.amountCaptured > 0) return order;
  await recordTransaction(db, { ...transactionBase(order, entry), kind: "void", status: "succeeded", amount: order.amountAuthorized });
  const saved = await save(db, order.id, { paymentStatus: "voided" });
  await appendOrderEvent(db, order.id, { type: "payment_voided", message: `The payment was canceled at the PSP${entry.reason ? ` (${entry.reason})` : ""}${suffix(entry)}` });
  await emit(db, orderEvent("order.updated", saved, { fields: ["paymentStatus"] }));
  return saved;
};

/** A refund made at the PSP, without lines or restocking; skipped if its reference is recorded. */
export const recordExternalRefund = async (db: Database, order: Order, entry: PaymentEntry & { amount: number; refundReference: string; reason: string | null }) => {
  const [known] = await db
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.orderId, order.id), eq(paymentTransactions.kind, "refund"), eq(paymentTransactions.pspReference, entry.refundReference)))
    .limit(1);
  if (known || entry.amount <= 0) return order;
  const transaction = await recordTransaction(db, { ...transactionBase(order, { ...entry, pspReference: entry.refundReference }), kind: "refund", status: "succeeded", amount: entry.amount });
  const number = formatDocumentNumber("REF-", await nextSequenceValue(db, "refund"));
  const reason = entry.reason ?? `Refunded at ${entry.method.provider}`;
  await db.insert(refunds).values({ orderId: order.id, number, amount: entry.amount, shippingAmount: 0, reason, lines: [], transactionId: transaction.id });
  const refunded = order.amountRefunded + entry.amount;
  const saved = await save(db, order.id, { amountRefunded: refunded, paymentStatus: refunded >= order.amountCaptured ? "refunded" : "partially_refunded" });
  await appendOrderEvent(db, order.id, {
    type: "refunded",
    message: `Refund ${number}: ${amountText(entry.amount, order.currency)}, made at ${entry.method.provider}${suffix(entry)}`,
    data: { refundNumber: number, amount: entry.amount, reason, pspReference: entry.refundReference },
  });
  await emit(db, orderEvent("order.refunded", saved, { amount: entry.amount, refundNumber: number, external: true }));
  return saved;
};

/** Chargebacks are answered in the PSP's dashboard; the order's history only notes them. */
export const recordDispute = async (
  db: Database,
  order: Order,
  entry: PaymentEntry & { referenceKey: string; opened: boolean; amount: number | null; reason: string | null },
) => {
  // No transaction to dedupe on; under the order's lock, an event with this reference suffices.
  const [seen] = await db
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, order.id), sql`${orderEvents.data}->>'referenceKey' = ${entry.referenceKey}`))
    .limit(1);
  if (seen) return order;
  const amount = entry.amount === null ? "" : ` for ${amountText(entry.amount, order.currency)}`;
  const message = entry.opened
    ? `Payment disputed${amount}${entry.reason ? ` (${entry.reason})` : ""}: respond in the ${entry.method.provider} dashboard`
    : `Payment dispute closed${entry.reason ? `: ${entry.reason}` : ""}`;
  await appendOrderEvent(db, order.id, {
    type: entry.opened ? "payment_disputed" : "payment_dispute_closed",
    message: `${message}${suffix(entry)}`,
    data: { referenceKey: entry.referenceKey, pspReference: entry.pspReference, amount: entry.amount, reason: entry.reason },
  });
  if (entry.opened) await emit(db, orderEvent("order.payment_disputed", order, { amount: entry.amount, reason: entry.reason, pspReference: entry.pspReference }));
  return order;
};
