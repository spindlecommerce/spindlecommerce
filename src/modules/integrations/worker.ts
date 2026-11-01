import { createHash, timingSafeEqual } from "node:crypto";
import { asc, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { queryRows } from "../../db/query.ts";
import { publishDuePages } from "../builder/pages.ts";
import { publishDueReleases } from "../builder/releases.ts";
import { getOrdersByIds } from "../orders/read.ts";
import type { Platform } from "../../platform.ts";
import { productVariants } from "../catalog/tables.ts";
import { activeEventHandlers, deliverDuePluginEvents, fanOutPluginEvents } from "../plugins/events.ts";
import { runDuePluginTasks } from "../plugins/tasks.ts";
import { outboxEvents } from "./tables.ts";
import { deliverDueWebhooks, fanOutEvent, type FetchLike } from "./webhooks.ts";

type OutboxEvent = typeof outboxEvents.$inferSelect;

/** Entities whose cached GraphQL results an event invalidates. */
const invalidationsFor = async (platform: Platform, events: OutboxEvent[]) => {
  const entities: { typename: string; id?: string }[] = [];
  const variantIds: string[] = [];
  for (const event of events) {
    if (event.aggregateType === "Product") entities.push({ typename: "Product", id: event.aggregateId });
    if (event.aggregateType === "Category") entities.push({ typename: "Category", id: event.aggregateId });
    if (event.aggregateType === "Page") {
      entities.push({ typename: "Page", id: event.aggregateId });
      // Publishing or assigning a template can move any product or category page to another one.
      if (event.payload.templateFor === "product") entities.push({ typename: "Product" });
      if (event.payload.templateFor === "category") entities.push({ typename: "Category" });
      // A product's or category's own sections, which its cached results include.
      if (typeof event.payload.productId === "string") entities.push({ typename: "Product", id: event.payload.productId });
      if (typeof event.payload.categoryId === "string") entities.push({ typename: "Category", id: event.payload.categoryId });
    }
    if (event.aggregateType === "ProductVariant") {
      variantIds.push(event.aggregateId);
      entities.push({ typename: "ProductVariant", id: event.aggregateId });
    }
  }
  if (variantIds.length) {
    const rows = await platform.db.select({ productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, variantIds));
    for (const r of rows) entities.push({ typename: "Product", id: r.productId });
  }
  return entities;
};

/** Process one outbox batch. SKIP LOCKED lets several workers share the queue. */
export const processOutbox = async (platform: Platform, batchSize = platform.config.worker.batchSize): Promise<number> => {
  const { db } = platform;
  // Before the transaction: reading plugin settings must not wait on it.
  const handlers = await activeEventHandlers(platform);
  const processed = await db.transaction(async (tx) => {
    const events = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.processedAt))
      .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const event of events) await fanOutEvent(tx, event);
    if (handlers.length) await fanOutPluginEvents(tx, handlers, events);
    if (events.length) {
      await tx.update(outboxEvents).set({ processedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` }).where(inArray(outboxEvents.id, events.map((e) => e.id)));
    }
    return events;
  });
  if (processed.length === 0) return 0;

  const orderEvents = processed.filter((e) => e.aggregateType === "Order");
  if (orderEvents.length) {
    const ordersById = new Map((await getOrdersByIds(db, [...new Set(orderEvents.map((e) => e.aggregateId))])).map((o) => [o.id, o]));
    for (const event of orderEvents) {
      const order = ordersById.get(event.aggregateId);
      if (!order) continue;
      // Statuses snapshotted when the event was written, not as of processing.
      const at = event.payload as Partial<Record<"status" | "paymentStatus" | "fulfillmentStatus", string>>;
      const update = {
        orderId: order.id,
        type: event.type,
        status: at.status ?? order.status,
        paymentStatus: at.paymentStatus ?? order.paymentStatus,
        fulfillmentStatus: at.fulfillmentStatus ?? order.fulfillmentStatus,
        occurredAt: event.occurredAt.toISOString(),
      };
      platform.pubsub.publish("orderUpdated", order.id, update);
      platform.pubsub.publish("orderActivity", update);
    }
  }
  const entities = await invalidationsFor(platform, processed);
  if (entities.length) {
    // Before delivering webhooks, so a storefront revalidating on them never reads a stale response.
    if (platform.responseCache?.shared) await platform.responseCache.invalidate(entities);
    platform.pubsub.publish("invalidate", entities);
  }
  return processed.length;
};

export type WorkerRunOptions = {
  fetch?: FetchLike;
  /** Epoch ms after which no new batch or delivery starts, for hosts that cap a run's duration. */
  deadline?: number;
};
export type DrainResult = { events: number; webhooks: { delivered: number; failed: number }; plugins: { delivered: number; failed: number } };
export type TickResult = DrainResult & { published: { pages: number; releases: number }; tasks: { ran: number; failed: number } };

const expired = (deadline: number | undefined) => deadline !== undefined && Date.now() >= deadline;

/** Process the outbox until it is empty, then deliver due webhooks and plugin events. */
export const drainOutbox = async (platform: Platform, options: WorkerRunOptions = {}): Promise<DrainResult> => {
  const { worker } = platform.config;
  let events = 0;
  while (!expired(options.deadline)) {
    const processed = await processOutbox(platform);
    events += processed;
    if (processed === 0) break;
  }
  const webhooks = await deliverDueWebhooks(platform.db, {
    fetch: options.fetch,
    timeoutMs: worker.webhookTimeoutMs,
    maxAttempts: worker.maxWebhookAttempts,
    batchSize: worker.batchSize,
    deadline: options.deadline,
  });
  const plugins = await deliverDuePluginEvents(platform, { deadline: options.deadline });
  return { events, webhooks, plugins };
};

/** One worker at a time, or two would both publish a page and emit its events twice. */
const publishScheduledContent = (platform: Platform) =>
  platform.db.transaction(async (tx) => {
    const [lock] = await queryRows<{ locked: boolean }>(tx, sql`select pg_try_advisory_xact_lock(hashtextextended('ecom:scheduled-publishing', 0)) as locked`);
    if (!lock?.locked) return { pages: 0, releases: 0 };
    return { pages: await publishDuePages(tx), releases: await publishDueReleases(tx) };
  });

/** One worker run. Safe to run in several processes at once: each step claims its work under a lock. */
export const runWorkerTick = async (platform: Platform, options: WorkerRunOptions = {}): Promise<TickResult> => {
  const published = await publishScheduledContent(platform);
  const drained = await drainOutbox(platform, options);
  // After the drain, so a long task holds up no webhook in this tick.
  const tasks = await runDuePluginTasks(platform, { deadline: options.deadline });
  return { published, ...drained, tasks };
};

export type Worker = { stop: () => Promise<void>; tick: () => Promise<void> };

/** Polls from a long-running process; serverless hosts use the worker route instead. */
export const startWorker = (platform: Platform, options: { fetch?: FetchLike; intervalMs?: number } = {}): Worker => {
  const { worker } = platform.config;
  let running = true;
  let current: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      await runWorkerTick(platform, { fetch: options.fetch });
    } catch (error) {
      platform.logger.error({ err: error }, "outbox worker tick failed");
      void platform.plugins.reportError(error, { source: "worker", details: { worker: "loop" } });
    }
  };
  const loop = async () => {
    while (running) {
      current = tick();
      await current;
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? worker.pollIntervalMs));
    }
  };
  void loop();
  return {
    tick,
    stop: async () => {
      running = false;
      await current;
    },
  };
};

export const WORKER_PATH = "/internal/worker";
/** Vercel stops this function at 300 seconds. */
const WORKER_ROUTE_BUDGET_MS = 240_000;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Vercel Cron sends `Bearer <CRON_SECRET>`. Returns the refusal, or null to proceed. */
export const authorizeWorkerRequest = (
  authorization: string | undefined,
  config: Pick<Config, "production"> & { worker: Pick<Config["worker"], "cronSecret"> },
): { status: 401 | 403; code: string; message: string } | null => {
  const secret = config.worker.cronSecret;
  if (!secret) return config.production ? { status: 403, code: "FORBIDDEN", message: "Set CRON_SECRET to use the worker route" } : null;
  const given = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim() ?? "";
  // Digests have one length, so the comparison takes the same time whatever was sent.
  if (timingSafeEqual(digest(given), digest(secret))) return null;
  return { status: 401, code: "UNAUTHENTICATED", message: "Send Authorization: Bearer <CRON_SECRET>" };
};

/** Runs one worker tick per request: the target for Vercel Cron or any external scheduler. */
export const mountWorkerRoute = (app: Hono, options: { platform: Platform; base: string }) => {
  const { platform } = options;
  app.on(["GET", "POST"], `${options.base}${WORKER_PATH}`, async (c) => {
    const refused = authorizeWorkerRequest(c.req.header("authorization"), platform.config);
    if (refused) return c.json({ error: { code: refused.code, message: refused.message } }, refused.status);
    const started = Date.now();
    try {
      const result = await runWorkerTick(platform, { deadline: started + WORKER_ROUTE_BUDGET_MS });
      return c.json({ ok: true, ...result, durationMs: Date.now() - started }, 200, { "cache-control": "no-store" });
    } catch (error) {
      platform.logger.error({ err: error }, "worker route tick failed");
      void platform.plugins.reportError(error, { source: "worker", details: { worker: "route" } });
      return c.json({ error: { code: "INTERNAL_SERVER_ERROR", message: "The worker tick failed; see the logs" } }, 500);
    }
  });
};
