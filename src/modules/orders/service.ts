import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { addressSchema } from "../../lib/address.ts";
import { InvalidStateError, PermissionDeniedError, ValidationError } from "../../lib/errors.ts";
import { fromDecimalString, roundHalfUp, toDecimalString } from "../../lib/money.ts";
import { parseInput } from "../../lib/validation.ts";
import type { Platform } from "../../platform.ts";
import type { ShipmentRequest } from "../../plugins/sdk.ts";
import { productVariants } from "../catalog/tables.ts";
import { formatDocumentNumber, getChannel, nextSequenceValue } from "../channels/service.ts";
import { emit, type DomainEvent, type EventType } from "../integrations/outbox.ts";
import { compensateReservations, deductStockForFulfillment, getStockLocationIds, listStockLocations, restock } from "../inventory/service.ts";
import { findPaymentMethod, recordTransaction } from "../payments/service.ts";
import { reindexProducts } from "../search/projector.ts";
import { isBuiltInConfig, type ShippingProvider } from "../shipping/providers.ts";
import { shipFromLocation } from "../shipping/rates.ts";
import { findShippingMethodByCode } from "../shipping/service.ts";
import { getOrder, toPluginOrder, type Order } from "./read.ts";
import { fulfillments, invoices, orderEvents, orderLines, orders, refunds, type ActorType, type FulfillmentShipment, type TrackingNumber } from "./tables.ts";

export type Actor = { type: ActorType; id: string | null };
const SYSTEM: Actor = { type: "system", id: null };

/** Snapshots the order's statuses, so subscribers and webhooks see each step. */
export const orderEvent = (type: EventType, order: Order, payload: Record<string, unknown> = {}): DomainEvent => ({
  type,
  aggregateType: "Order",
  aggregateId: order.id,
  payload: { number: order.number, status: order.status, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus, ...payload },
});

export const appendOrderEvent = async (
  db: Database,
  orderId: string,
  event: { type: string; message: string; actor?: Actor; data?: Record<string, unknown> },
) => {
  const actor = event.actor ?? SYSTEM;
  await db.insert(orderEvents).values({ orderId, type: event.type, message: event.message, actorType: actor.type, actorId: actor.id, data: event.data ?? {} });
};

const saveOrder = async (db: Database, id: string, patch: Partial<typeof orders.$inferInsert>) => {
  const [row] = await db.update(orders).set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: new Date() }).where(eq(orders.id, id)).returning();
  return row!;
};

const lockOrder = async (db: Database, id: string) => {
  await getOrder(db, id);
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).for("update");
  return order!;
};

const completeIfDone = async (db: Database, order: Order) => {
  if (order.status !== "open" || order.paymentStatus !== "paid") return order;
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  const outstanding = lines.some((l) => l.isShippable && l.quantityFulfilled + l.quantityCanceled + l.quantityRefunded < l.quantity);
  if (outstanding) return order;
  const completed = await saveOrder(db, order.id, { status: "completed", completedAt: new Date() });
  await appendOrderEvent(db, order.id, { type: "completed", message: "Order completed" });
  await emit(db, orderEvent("order.completed", completed));
  return completed;
};

const provider = async (platform: Platform, order: Order) => {
  const method = await findPaymentMethod(platform.db, order.paymentMethodCode);
  const impl = platform.payments.get(method.provider);
  if (!impl) throw new InvalidStateError(`Payment provider ${method.provider} is not installed`);
  return { method, impl };
};

/** The payment's PSP reference, never a refund's own id. */
const latestPspReference = async (db: Database, orderId: string) => {
  const row = await db.query.paymentTransactions.findFirst({
    where: (t, { and: all, eq: e, inArray: within, isNotNull }) => all(e(t.orderId, orderId), e(t.status, "succeeded"), within(t.kind, ["authorization", "capture"]), isNotNull(t.pspReference)),
    // Ids are time-ordered (UUIDv7).
    orderBy: (t, { desc: newest }) => newest(t.id),
  });
  return row?.pspReference ?? null;
};

export const capturePayment = async (platform: Platform, orderId: string, input: { amount?: string | null }, actor: Actor) => {
  const order = await getOrder(platform.db, orderId);
  if (order.status === "canceled") throw new InvalidStateError("The order is canceled");
  if (!["pending", "authorized", "partially_paid"].includes(order.paymentStatus)) throw new InvalidStateError(`Payment is ${order.paymentStatus}`);
  const outstanding = order.grandTotal - order.amountCaptured;
  const amount = input.amount ? fromDecimalString(input.amount, order.currency) : outstanding;
  if (amount <= 0 || amount > outstanding) throw new ValidationError("Invalid capture amount", [{ path: ["input", "amount"], message: `Between 0 and ${outstanding} minor units` }]);
  const { method, impl } = await provider(platform, order);
  const result = await impl.capture({ orderId, amount, currency: order.currency, pspReference: await latestPspReference(platform.db, orderId) });
  return platform.db.transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    const capture = await recordTransaction(tx, { orderId, paymentMethodCode: method.code, provider: method.provider, kind: "capture", status: "succeeded", amount, currency: order.currency, pspReference: result.pspReference, raw: result.raw ?? {} });
    const number = formatDocumentNumber("INV-", await nextSequenceValue(tx, "invoice"));
    await tx.insert(invoices).values({ orderId, number, amount, transactionId: capture.id });
    const captured = locked.amountCaptured + amount;
    const saved = await saveOrder(tx, orderId, { amountCaptured: captured, amountAuthorized: Math.max(locked.amountAuthorized, captured), paymentStatus: captured >= locked.grandTotal ? "paid" : "partially_paid" });
    await appendOrderEvent(tx, orderId, { type: "payment_captured", message: `Captured ${toDecimalString(amount, order.currency)} ${order.currency} (${number})`, actor, data: { invoiceNumber: number, amount } });
    await emit(tx, orderEvent("order.payment_captured", saved, { amount, invoiceNumber: number }));
    return completeIfDone(tx, saved);
  });
};

const documentLinesSchema = z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().positive() }));

type OrderLine = typeof orderLines.$inferSelect;
const unshipped = (l: OrderLine) => l.quantity - l.quantityFulfilled - l.quantityCanceled - l.quantityRefunded;

const unitsToShip = (lines: OrderLine[], requestedLines: { orderLineId: string; quantity: number }[] | null | undefined) => {
  const requested = requestedLines
    ? parseInput(documentLinesSchema, requestedLines, ["input", "lines"])
    : lines.filter((l) => l.isShippable && unshipped(l) > 0).map((l) => ({ orderLineId: l.id, quantity: unshipped(l) }));
  if (requested.length === 0) throw new InvalidStateError("Nothing left to fulfill");
  const errors = requested.flatMap((r, i) => {
    const line = lines.find((l) => l.id === r.orderLineId);
    if (!line) return [{ path: ["input", "lines", String(i), "orderLineId"], message: "Not a line of this order" }];
    if (requested.findIndex((o) => o.orderLineId === r.orderLineId) < i) return [{ path: ["input", "lines", String(i), "orderLineId"], message: "Listed more than once" }];
    if (r.quantity > unshipped(line)) return [{ path: ["input", "lines", String(i), "quantity"], message: `Only ${unshipped(line)} left to fulfill` }];
    return [];
  });
  if (errors.length) throw new ValidationError("Invalid fulfillment", errors);
  return requested;
};

const fulfillmentLocation = async (db: Database, channelId: string, locationId: string | null | undefined) => {
  const channel = await getChannel(db, channelId);
  const id = locationId ?? (channel.stockId ? (await getStockLocationIds(db, channel.stockId))[0] : undefined);
  if (!id) throw new ValidationError("A stock location is required", [{ path: ["input", "locationId"], message: "Required" }]);
  return id;
};

export type FulfillInput = {
  locationId?: string | null;
  lines?: { orderLineId: string; quantity: number }[] | null;
  tracking?: TrackingNumber[] | null;
  /** Set by shipOrder when a shipping provider booked the shipment. */
  shipment?: FulfillmentShipment | null;
};

/** Defaults to every unshipped unit, from the channel's first location. */
export const fulfillOrder = async (db: Database, orderId: string, input: FulfillInput, actor: Actor) =>
  db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "open") throw new InvalidStateError(`The order is ${order.status}`);
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const requested = unitsToShip(lines, input.lines);
    const channel = await getChannel(tx, order.channelId);
    const locationId = await fulfillmentLocation(tx, order.channelId, input.locationId);
    const variantIds = requested.map((r) => lines.find((l) => l.id === r.orderLineId)!.variantId).filter((v): v is string => !!v);
    const tracked = new Set((variantIds.length ? await tx.select().from(productVariants).where(inArray(productVariants.id, variantIds)) : []).filter((v) => v.trackInventory).map((v) => v.id));
    const stockLines = requested.flatMap((r) => {
      const variantId = lines.find((l) => l.id === r.orderLineId)!.variantId;
      return variantId && tracked.has(variantId) ? [{ variantId, quantity: r.quantity }] : [];
    });
    if (channel.stockId && stockLines.length) await deductStockForFulfillment(tx, { stockId: channel.stockId, locationId, lines: stockLines, orderId });
    for (const r of requested) {
      await tx.update(orderLines).set({ quantityFulfilled: sql`${orderLines.quantityFulfilled} + ${r.quantity}` }).where(eq(orderLines.id, r.orderLineId));
    }
    const number = formatDocumentNumber("FUL-", await nextSequenceValue(tx, "fulfillment"));
    const tracking = input.tracking ?? [];
    const [fulfillment] = await tx.insert(fulfillments).values({ orderId, number, locationId, tracking, lines: requested, shipment: input.shipment ?? null }).returning();
    const after = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const allDone = after.filter((l) => l.isShippable).every((l) => unshipped(l) === 0);
    const saved = await saveOrder(tx, orderId, { fulfillmentStatus: allDone ? "fulfilled" : "partially_fulfilled" });
    const label = input.shipment ? { provider: input.shipment.provider, labelUrl: input.shipment.labelUrl } : null;
    await appendOrderEvent(tx, orderId, { type: "fulfilled", message: `Shipment ${number} created`, actor, data: { fulfillmentId: fulfillment!.id, tracking, ...(label ? { shipment: label } : {}) } });
    await emit(tx, orderEvent("order.fulfilled", saved, { fulfillmentNumber: number, lines: requested, tracking }));
    await reindexProducts(tx, lines.flatMap((l) => (l.productId ? [l.productId] : [])));
    return completeIfDone(tx, saved);
  });

/** Fills missing tracking URLs from the preferred provider, else any that knows the carrier. */
const withTrackingUrls = (platform: Platform, tracking: TrackingNumber[], preferred: ShippingProvider | undefined) => {
  const providers = [...(preferred ? [preferred] : []), ...platform.shipping.values()].filter((p) => p.trackingUrl);
  const urlFor = (t: TrackingNumber) => {
    for (const p of providers) {
      try {
        const url = p.trackingUrl!({ carrier: t.carrier, number: t.number });
        if (url) return url;
      } catch (error) {
        platform.logger.warn({ err: error, provider: p.code }, "trackingUrl failed");
      }
    }
    return null;
  };
  return tracking.map((t) => (t.url ? t : { ...t, url: urlFor(t) }));
};

const trackingSchema = z.object({ carrier: z.string().min(1), number: z.string().min(1), url: z.string().nullish() });
/** Lenient: a label may already be paid for, so keep whatever part of the answer is valid. */
const shipmentResultSchema = z
  .object({
    tracking: z
      .array(z.unknown())
      .catch([])
      .transform((list) => list.flatMap((t) => (trackingSchema.safeParse(t).success ? [trackingSchema.parse(t)] : []))),
    labelUrl: z.string().nullish().catch(null),
    cost: z.object({ amount: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) }).nullish().catch(null),
    data: z.record(z.string(), z.unknown()).catch({}),
  })
  .catch({ tracking: [], labelUrl: null, cost: null, data: {} });

export type ShipInput = FulfillInput & {
  /** Buy a label with a shipping provider first. */
  createShipment?: boolean | null;
  /** Defaults to the provider behind the order's shipping rate. */
  shipmentProvider?: string | null;
};

/**
 * fulfillOrder, optionally booking the shipment first (outside any transaction). If booking fails
 * nothing is written; if the write fails after a label was bought, a note says to void it.
 */
export const shipOrder = async (platform: Platform, orderId: string, input: ShipInput, actor: Actor) => {
  const order = await getOrder(platform.db, orderId);
  const chosen = order.shippingMethod?.details ?? null;
  const { createShipment, shipmentProvider, ...fulfill } = input;
  if (!createShipment) {
    const provider = chosen ? platform.shipping.get(chosen.provider) : undefined;
    return fulfillOrder(platform.db, orderId, { ...fulfill, tracking: withTrackingUrls(platform, fulfill.tracking ?? [], provider) }, actor);
  }

  if (order.status !== "open") throw new InvalidStateError(`The order is ${order.status}`);
  const code = shipmentProvider ?? chosen?.provider;
  const provider = code ? platform.shipping.get(code) : undefined;
  if (!code) throw new InvalidStateError("Choose a shipping provider to book the shipment with");
  if (!provider) throw new InvalidStateError(`The shipping provider ${code} is not installed`);
  if (!provider.createShipment) throw new InvalidStateError(`${provider.title} cannot book shipments${shipmentProvider ? "" : ": choose a provider that can"}`);
  if (provider.isActive && !(await provider.isActive())) throw new InvalidStateError(`${provider.title} is not set up (Settings › Plugins)`);
  // Checked before anything is bought; fulfillOrder checks again under the order's lock.
  const lines = await platform.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
  const units = unitsToShip(lines, fulfill.lines);
  const locationId = await fulfillmentLocation(platform.db, order.channelId, fulfill.locationId);
  const location = (await listStockLocations(platform.db)).find((l) => l.id === locationId);
  const rate = chosen?.provider === provider.code ? chosen : null;
  const method = rate ? await findShippingMethodByCode(platform.db, rate.method) : undefined;
  const request: ShipmentRequest = {
    order: await toPluginOrder(platform.db, order),
    lines: units.map((u) => {
      const line = lines.find((l) => l.id === u.orderLineId)!;
      return { orderLineId: line.id, sku: line.sku, name: line.name, quantity: u.quantity, weightGrams: line.weightGrams };
    }),
    origin: location?.address.countryCode ? location.address : ((await shipFromLocation(platform.db, order.channelId))?.address ?? null),
    method: rate ? { code: rate.method, options: method && !isBuiltInConfig(method.config) ? (method.config.options ?? {}) : {} } : null,
    rate,
  };

  let answer: unknown;
  try {
    answer = await provider.createShipment(request);
  } catch (error) {
    throw new InvalidStateError(`${provider.title} could not book the shipment: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = shipmentResultSchema.parse(answer);
  const shipment: FulfillmentShipment = { provider: provider.code, labelUrl: result.labelUrl ?? null, cost: result.cost ?? null, data: result.data };
  const tracking = withTrackingUrls(platform, [...(fulfill.tracking ?? []), ...result.tracking.map((t) => ({ carrier: t.carrier, number: t.number, url: t.url ?? null }))], provider);
  try {
    return await fulfillOrder(platform.db, orderId, { ...fulfill, lines: units, locationId, tracking, shipment }, actor);
  } catch (error) {
    const bought = [tracking.map((t) => `${t.carrier} ${t.number}`).join(", "), shipment.labelUrl].filter(Boolean).join(", ") || "no tracking number";
    const why = error instanceof ValidationError ? `${error.message} (${error.fieldErrors.map((e) => e.message).join("; ")})` : error instanceof Error ? error.message : String(error);
    const note = `A ${provider.title} label was bought (${bought}) but the shipment could not be recorded: ${why}. Void the label with ${provider.title}, or record the shipment again.`;
    await addOrderNote(platform.db, orderId, note, SYSTEM).catch((noteError: unknown) => platform.logger.error({ err: noteError, orderId, shipment, tracking }, note));
    throw error;
  }
};

/**
 * Line amounts are prorated from the line's total; shipping is refunded only as given. Unshipped
 * units release their reservation; shipped ones return to stock if `restock`.
 */
export const refundOrder = async (
  platform: Platform,
  orderId: string,
  input: { lines?: { orderLineId: string; quantity: number; restock?: boolean | null }[] | null; shippingAmount?: string | null; reason?: string | null },
  actor: Actor,
) => {
  const order = await getOrder(platform.db, orderId);
  const lines = await platform.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
  const previous = await platform.db.select().from(refunds).where(eq(refunds.orderId, orderId));
  const requested = (input.lines ?? []).map((l, i) => ({ ...parseInput(documentLinesSchema.element, l, ["input", "lines", String(i)]), restock: l.restock ?? true }));
  const errors: { path: string[]; message: string }[] = [];
  const refundLines = requested.map((r, i) => {
    const line = lines.find((l) => l.id === r.orderLineId);
    if (!line) {
      errors.push({ path: ["input", "lines", String(i), "orderLineId"], message: "Not a line of this order" });
      return null;
    }
    if (requested.findIndex((o) => o.orderLineId === r.orderLineId) < i) errors.push({ path: ["input", "lines", String(i), "orderLineId"], message: "Listed more than once" });
    const refundable = line.quantity - line.quantityRefunded - line.quantityCanceled;
    if (r.quantity > refundable) errors.push({ path: ["input", "lines", String(i), "quantity"], message: `Only ${refundable} can be refunded` });
    return { ...r, amount: roundHalfUp((line.total * r.quantity) / line.quantity), line };
  });
  if (errors.length) throw new ValidationError("Invalid refund", errors);
  const shippingRefunded = previous.reduce((s, r) => s + r.shippingAmount, 0);
  const shippingAmount = input.shippingAmount ? fromDecimalString(input.shippingAmount, order.currency) : 0;
  if (shippingAmount > order.shippingTotal - shippingRefunded) {
    throw new ValidationError("Invalid shipping refund", [{ path: ["input", "shippingAmount"], message: `At most ${order.shippingTotal - shippingRefunded} minor units` }]);
  }
  const amount = refundLines.reduce((s, l) => s + (l?.amount ?? 0), 0) + shippingAmount;
  if (amount <= 0) throw new ValidationError("Nothing to refund", [{ path: ["input"], message: "Give lines or a shipping amount" }]);
  if (amount > order.amountCaptured - order.amountRefunded) throw new InvalidStateError(`Only ${order.amountCaptured - order.amountRefunded} minor units were captured and not yet refunded`);

  const { method, impl } = await provider(platform, order);
  const result = await impl.refund({ orderId, amount, currency: order.currency, pspReference: await latestPspReference(platform.db, orderId) });
  return platform.db.transaction(async (tx) => {
    const locked = await lockOrder(tx, orderId);
    const transaction = await recordTransaction(tx, { orderId, paymentMethodCode: method.code, provider: method.provider, kind: "refund", status: "succeeded", amount, currency: order.currency, pspReference: result.pspReference, raw: result.raw ?? {} });
    const number = formatDocumentNumber("REF-", await nextSequenceValue(tx, "refund"));
    const docLines = refundLines.map((l) => ({ orderLineId: l!.orderLineId, quantity: l!.quantity, amount: l!.amount, restock: l!.restock }));
    await tx.insert(refunds).values({ orderId, number, amount, shippingAmount, reason: input.reason ?? null, lines: docLines, transactionId: transaction.id });
    const channel = await getChannel(tx, order.channelId);
    const toRestock: { variantId: string; quantity: number }[] = [];
    const toRelease: { variantId: string; quantity: number }[] = [];
    for (const l of refundLines) {
      const line = l!.line;
      await tx.update(orderLines).set({ quantityRefunded: sql`${orderLines.quantityRefunded} + ${l!.quantity}` }).where(eq(orderLines.id, line.id));
      if (!line.variantId) continue;
      const unshipped = Math.max(0, line.quantity - line.quantityFulfilled - line.quantityRefunded - line.quantityCanceled);
      const released = Math.min(unshipped, l!.quantity);
      if (released > 0) toRelease.push({ variantId: line.variantId, quantity: released });
      if (l!.restock && l!.quantity - released > 0) toRestock.push({ variantId: line.variantId, quantity: l!.quantity - released });
    }
    if (channel.stockId && toRelease.length) await compensateReservations(tx, channel.stockId, toRelease, "order_refunded", orderId);
    if (channel.stockId && toRestock.length) {
      const [locationId] = await getStockLocationIds(tx, channel.stockId);
      if (locationId) await restock(tx, locationId, toRestock);
    }
    const refunded = locked.amountRefunded + amount;
    const saved = await saveOrder(tx, orderId, { amountRefunded: refunded, paymentStatus: refunded >= locked.amountCaptured ? "refunded" : "partially_refunded" });
    await appendOrderEvent(tx, orderId, { type: "refunded", message: `Refund ${number}: ${toDecimalString(amount, locked.currency)} ${locked.currency}`, actor, data: { refundNumber: number, amount, reason: input.reason ?? null } });
    await emit(tx, orderEvent("order.refunded", saved, { amount, refundNumber: number }));
    await reindexProducts(tx, lines.flatMap((l) => (l.productId ? [l.productId] : [])));
    return saved;
  });
};

/** For unshipped, uncaptured orders: voids the authorization and releases reserved stock. */
export const cancelOrder = async (platform: Platform, orderId: string, input: { reason?: string | null }, actor: Actor) => {
  const order = await getOrder(platform.db, orderId);
  if (actor.type === "customer" && order.customerId !== actor.id) throw new PermissionDeniedError("orders:write");
  if (order.status !== "open") throw new InvalidStateError(`The order is ${order.status}`);
  if (order.fulfillmentStatus !== "unfulfilled") throw new InvalidStateError("Shipped orders cannot be canceled; refund them instead");
  if (order.amountCaptured > 0) throw new InvalidStateError("Captured orders must be refunded before canceling");
  const { method, impl } = await provider(platform, order);
  if (order.paymentStatus === "authorized") await impl.void({ orderId, pspReference: await latestPspReference(platform.db, orderId) });
  return platform.db.transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId));
    const channel = await getChannel(tx, order.channelId);
    const release = lines.flatMap((l) => (l.variantId ? [{ variantId: l.variantId, quantity: l.quantity - l.quantityCanceled - l.quantityRefunded }] : []));
    if (channel.stockId) await compensateReservations(tx, channel.stockId, release, "order_canceled", orderId);
    for (const l of lines) await tx.update(orderLines).set({ quantityCanceled: l.quantity - l.quantityRefunded }).where(eq(orderLines.id, l.id));
    if (order.paymentStatus === "authorized") {
      await recordTransaction(tx, { orderId, paymentMethodCode: method.code, provider: method.provider, kind: "void", status: "succeeded", amount: order.amountAuthorized, currency: order.currency });
    }
    const saved = await saveOrder(tx, orderId, { status: "canceled", paymentStatus: "voided", canceledAt: new Date() });
    await appendOrderEvent(tx, orderId, { type: "canceled", message: `Order canceled${input.reason ? `: ${input.reason}` : ""}`, actor });
    await emit(tx, orderEvent("order.canceled", saved, { reason: input.reason ?? null }));
    await reindexProducts(tx, lines.flatMap((l) => (l.productId ? [l.productId] : [])));
    return saved;
  });
};

/** The shipping address is fixed once anything has shipped. */
export const updateOrderAddresses = async (db: Database, orderId: string, input: { shippingAddress?: unknown; billingAddress?: unknown }, actor: Actor) =>
  db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "open") throw new InvalidStateError(`The order is ${order.status}`);
    const patch: Partial<typeof orders.$inferInsert> = {};
    if (input.shippingAddress) {
      if (!order.shippingAddress) throw new InvalidStateError("This order has nothing to ship");
      if (order.fulfillmentStatus !== "unfulfilled") throw new InvalidStateError("Items have already shipped to the current address");
      patch.shippingAddress = parseInput(addressSchema, input.shippingAddress, ["input", "shippingAddress"]);
    }
    if (input.billingAddress) patch.billingAddress = parseInput(addressSchema, input.billingAddress, ["input", "billingAddress"]);
    if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to change", [{ path: ["input"], message: "Give a shipping or billing address" }]);
    const saved = await saveOrder(tx, orderId, patch);
    const changed = Object.keys(patch).map((k) => (k === "shippingAddress" ? "shipping" : "billing"));
    await appendOrderEvent(tx, orderId, { type: "address_updated", message: `Updated the ${changed.join(" and ")} address`, actor, data: { fields: changed } });
    await emit(tx, orderEvent("order.updated", saved, { fields: changed }));
    return saved;
  });

export const addOrderNote = async (db: Database, orderId: string, message: string, actor: Actor) => {
  const order = await getOrder(db, orderId);
  const text = parseInput(z.string().trim().min(1).max(5000), message, ["message"]);
  await appendOrderEvent(db, orderId, { type: "note", message: text, actor });
  await emit(db, orderEvent("order.note_added", order));
  return order;
};
