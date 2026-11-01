import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { NotFoundError } from "../../lib/errors.ts";
import { isUuid } from "../../lib/ids.ts";
import type { Platform } from "../../platform.ts";
import type { PluginEvent } from "../../plugins/sdk.ts";
import { matchesEventPattern } from "../integrations/outbox.ts";
import { outboxEvents } from "../integrations/tables.ts";
import { nextRetryDelayMs } from "../integrations/webhooks.ts";
import { pluginEventDeliveries, type PluginDeliveryStatus } from "./tables.ts";
import { errorMessage, withTimeout } from "./timeout.ts";

/** A handler that runs longer fails the delivery, which is retried. */
export const EVENT_HANDLER_TIMEOUT_MS = 30_000;

export type PluginDelivery = typeof pluginEventDeliveries.$inferSelect;
export type PluginEventHandlerKey = { plugin: string; handler: string };

/** Call before the outbox transaction opens: settings reads must not wait on it. */
export const activeEventHandlers = async (platform: Platform): Promise<PluginEventHandlerKey[]> => {
  const keys: PluginEventHandlerKey[] = [];
  for (const definition of platform.plugins.definitions) {
    if (!definition.events || !(await platform.plugins.isActive(definition.name))) continue;
    for (const handler of Object.keys(definition.events)) keys.push({ plugin: definition.name, handler });
  }
  return keys;
};

/** Events that arrive while a plugin is inactive are never delivered to it. */
export const fanOutPluginEvents = async (tx: Database, handlers: readonly PluginEventHandlerKey[], events: readonly { id: string; type: string }[]) => {
  const rows = events.flatMap((event) => handlers.filter((h) => matchesEventPattern(h.handler, event.type)).map((h) => ({ plugin: h.plugin, handler: h.handler, eventId: event.id })));
  if (rows.length) await tx.insert(pluginEventDeliveries).values(rows).onConflictDoNothing();
  return rows.length;
};

/** Leases the next due delivery, as webhook deliveries are. */
const claimDueDelivery = async (db: Database, now: Date, leaseMs: number): Promise<PluginDelivery | null> => {
  const due = db
    .select({ id: pluginEventDeliveries.id })
    .from(pluginEventDeliveries)
    .where(and(inArray(pluginEventDeliveries.status, ["pending", "failed"]), lte(pluginEventDeliveries.nextAttemptAt, now)))
    .orderBy(asc(pluginEventDeliveries.nextAttemptAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const [claimed] = await db
    .update(pluginEventDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() + leaseMs) })
    .where(inArray(pluginEventDeliveries.id, due))
    .returning();
  return claimed ?? null;
};

export const toPluginEvent = (event: typeof outboxEvents.$inferSelect): PluginEvent => ({
  id: event.id,
  type: event.type,
  aggregateType: event.aggregateType,
  aggregateId: event.aggregateId,
  payload: event.payload,
  occurredAt: event.occurredAt,
});

/**
 * Retried with backoff up to `config.worker.maxWebhookAttempts`. A delivery whose plugin was
 * disabled meanwhile fails and retries, so re-enabling the plugin in time still delivers it.
 */
export const deliverDuePluginEvents = async (
  platform: Platform,
  options: { deadline?: number; now?: Date; batchSize?: number } = {},
): Promise<{ delivered: number; failed: number }> => {
  const { db, config } = platform;
  let delivered = 0;
  let failed = 0;
  if (!platform.plugins.definitions.some((d) => d.events)) return { delivered, failed };
  const now = options.now ?? new Date();
  for (let i = 0; i < (options.batchSize ?? config.worker.batchSize); i++) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    const delivery = await claimDueDelivery(db, now, EVENT_HANDLER_TIMEOUT_MS + 30_000);
    if (!delivery) break;
    const handler = platform.plugins.get(delivery.plugin)?.events?.[delivery.handler];
    const event = handler ? await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, delivery.eventId) }) : undefined;
    if (!handler || !event) {
      const reason = !handler ? `the plugin ${delivery.plugin} or its handler for ${delivery.handler} is no longer installed` : "the event is missing";
      await db.update(pluginEventDeliveries).set({ status: "dead", lastError: reason, updatedAt: new Date() }).where(eq(pluginEventDeliveries.id, delivery.id));
      failed++;
      continue;
    }
    const attempts = delivery.attempts + 1;
    let error: string | null = null;
    try {
      const ctx = await platform.plugins.context(delivery.plugin);
      await withTimeout(handler(toPluginEvent(event), ctx), EVENT_HANDLER_TIMEOUT_MS, `The handler for ${delivery.handler}`);
    } catch (e) {
      error = errorMessage(e).slice(0, 2000);
      platform.logger.warn({ err: e, plugin: delivery.plugin, handler: delivery.handler, eventId: event.id, attempts }, "plugin event handler failed");
      void platform.plugins.reportError(e, {
        source: "plugin-event",
        plugin: delivery.plugin,
        details: { eventType: event.type, eventId: event.id, handler: delivery.handler, attempt: attempts },
      });
    }
    if (!error) {
      delivered++;
      await db.update(pluginEventDeliveries).set({ status: "succeeded", attempts, lastError: null, updatedAt: new Date() }).where(eq(pluginEventDeliveries.id, delivery.id));
    } else {
      failed++;
      const dead = attempts >= config.worker.maxWebhookAttempts;
      await db
        .update(pluginEventDeliveries)
        .set({ status: dead ? "dead" : "failed", attempts, lastError: error, nextAttemptAt: new Date(now.getTime() + nextRetryDelayMs(attempts)), updatedAt: new Date() })
        .where(eq(pluginEventDeliveries.id, delivery.id));
    }
  }
  return { delivered, failed };
};

export const listPluginDeliveries = async (db: Database, plugin: string, filter: { status?: PluginDeliveryStatus | null; limit: number }) => {
  const conditions = [eq(pluginEventDeliveries.plugin, plugin)];
  if (filter.status) conditions.push(eq(pluginEventDeliveries.status, filter.status));
  const rows = await db
    .select({ delivery: pluginEventDeliveries, eventType: outboxEvents.type })
    .from(pluginEventDeliveries)
    .leftJoin(outboxEvents, eq(outboxEvents.id, pluginEventDeliveries.eventId))
    .where(and(...conditions))
    .orderBy(desc(pluginEventDeliveries.id))
    .limit(filter.limit);
  return rows.map((r) => ({ ...r.delivery, eventType: r.eventType }));
};

/** Due now, attempts kept: a dead delivery retried this way gets one more attempt. */
export const retryPluginDelivery = async (db: Database, id: string) => {
  if (!isUuid(id)) throw new NotFoundError("PluginDelivery", id);
  const [row] = await db.update(pluginEventDeliveries).set({ status: "pending", nextAttemptAt: new Date(), updatedAt: new Date() }).where(eq(pluginEventDeliveries.id, id)).returning();
  if (!row) throw new NotFoundError("PluginDelivery", id);
  const event = await db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, row.eventId) });
  return { ...row, eventType: event?.type ?? null };
};
