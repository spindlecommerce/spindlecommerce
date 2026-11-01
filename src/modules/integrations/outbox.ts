import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "../../db/client.ts";
import { outboxEvents } from "./tables.ts";

/** Platform event types. Webhook subscriptions match them by name or `prefix.*`. */
export const EVENT_TYPES = [
  "product.created",
  "product.updated",
  "product.deleted",
  "category.created",
  "category.updated",
  "category.deleted",
  "inventory.level_changed",
  "price.updated",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "cart.converted",
  "order.placed",
  "order.payment_authorized",
  "order.payment_captured",
  "order.payment_failed",
  "order.payment_disputed",
  "order.fulfilled",
  "order.refunded",
  "order.canceled",
  "order.completed",
  "order.note_added",
  "order.updated",
  "promotion.created",
  "promotion.updated",
  "page.published",
  "page.unpublished",
  "page.targets_updated",
  "release.published",
  "component.updated",
] as const;

/**
 * Never sent to webhooks: the payloads carry reset links, which would let anyone with
 * integrations:write take over the account. The email plugin delivers them.
 */
export const PLUGIN_ONLY_EVENT_TYPES = ["customer.password_reset_requested", "staff.password_reset_requested"] as const;

export type EventType = (typeof EVENT_TYPES)[number] | (typeof PLUGIN_ONLY_EVENT_TYPES)[number];

export const isPluginOnlyEvent = (type: string): boolean => (PLUGIN_ONLY_EVENT_TYPES as readonly string[]).includes(type);

export type DomainEvent = {
  type: EventType;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
};

/** Plugins' `emits`, registered when a platform is created. Process-wide. */
const pluginEventTypes = new Set<string>();

export const registerPluginEventTypes = (types: Iterable<string>) => {
  for (const type of types) pluginEventTypes.add(type);
};

/** What webhook subscriptions may name. */
export const knownEventTypes = (): string[] => [...EVENT_TYPES, ...pluginEventTypes];

const drainRequests = new AsyncLocalStorage<{ drain: boolean }>();

/**
 * Runs a request and reports whether it asked for an outbox drain. Hosts without a polling worker
 * (Vercel) drain right after, so webhooks go out within seconds.
 */
export const trackOutboxWrites = async <T>(fn: () => Promise<T>): Promise<{ result: T; drain: boolean }> => {
  const scope = { drain: false };
  const result = await drainRequests.run(scope, fn);
  return { result, drain: scope.drain };
};

/** Ask the host to drain the outbox after the current request. */
export const requestOutboxDrain = () => {
  const scope = drainRequests.getStore();
  if (scope) scope.drain = true;
};

/** Pass the caller's transaction, so events commit or roll back with the state change. */
export const emit = (db: Database, ...events: DomainEvent[]): Promise<void> => emitAny(db, events);

/** For PluginContext.emit. The plugin runtime checks the types against the plugin's `emits`. */
export const emitPluginEvents = (db: Database, events: (Omit<DomainEvent, "type"> & { type: string })[]): Promise<void> => emitAny(db, events);

const emitAny = async (db: Database, events: (Omit<DomainEvent, "type"> & { type: string })[]): Promise<void> => {
  if (events.length === 0) return;
  await db.insert(outboxEvents).values(
    events.map((event) => ({
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload ?? {},
    })),
  );
  requestOutboxDrain();
};

export const matchesEventPattern = (pattern: string, type: string): boolean =>
  pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));
