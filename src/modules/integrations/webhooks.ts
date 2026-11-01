import { lookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { hmacSha256, randomToken, safeEqual } from "../../lib/crypto.ts";
import { NotFoundError } from "../../lib/errors.ts";
import { parseInput, patchSchema } from "../../lib/validation.ts";
import { isPluginOnlyEvent, knownEventTypes, matchesEventPattern } from "./outbox.ts";
import { outboxEvents, webhookDeliveries, webhookSubscriptions, type DeliveryStatus } from "./tables.ts";

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** Plugins' events (`emits`) are valid too, so external systems can subscribe to them. */
const eventPattern = z.string().refine((p) => p === "*" || knownEventTypes().some((t) => matchesEventPattern(p, t)), "Matches no known event");

const privateTargetsAllowed = () => process.env.ALLOW_PRIVATE_WEBHOOK_URLS === "true";

/** Loopback, private, link-local (cloud metadata), multicast and the other ranges off the public internet. */
const nonPublic = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) {
  nonPublic.addSubnet(net, bits, "ipv4");
  // The same range through NAT64. IPv4-mapped addresses (::ffff:10.0.0.1) are checked as IPv4.
  nonPublic.addSubnet(`64:ff9b::${net}`, 96 + bits, "ipv6");
}
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) nonPublic.addSubnet(net, bits, "ipv6");

const isPublicAddress = (ip: string) => !nonPublic.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/**
 * SSRF guard for saved URLs; sending also checks what a host resolves to. ALLOW_PRIVATE_WEBHOOK_URLS=true
 * turns both off for local development.
 */
export const isPublicWebhookUrl = (value: string): boolean => {
  if (privateTargetsAllowed()) return true;
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  return !isIP(host) || isPublicAddress(host);
};

const subscriptionSchema = z.object({
  name: z.string().min(1).max(200),
  url: z
    .url()
    .refine((u) => /^https?:\/\//.test(u), "Use an http(s) URL")
    .refine(isPublicWebhookUrl, "Webhook URLs must not point at loopback, link-local or private networks"),
  events: z.array(eventPattern).min(1),
  isActive: z.boolean().default(true),
});

/** Generates the signing secret. This is the only time it is returned. */
export const createWebhookSubscription = async (db: Database, input: unknown) => {
  const data = parseInput(subscriptionSchema, input);
  const secret = `whsec_${randomToken(24)}`;
  const [row] = await db.insert(webhookSubscriptions).values({ ...data, secret }).returning();
  return row!;
};

export const updateWebhookSubscription = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(patchSchema(subscriptionSchema), input);
  const [row] = await db.update(webhookSubscriptions).set({ ...data, updatedAt: new Date() }).where(eq(webhookSubscriptions.id, id)).returning();
  if (!row) throw new NotFoundError("WebhookSubscription", id);
  return row;
};

export const deleteWebhookSubscription = async (db: Database, id: string) => {
  const [row] = await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).returning({ id: webhookSubscriptions.id });
  if (!row) throw new NotFoundError("WebhookSubscription", id);
  return id;
};

export const listWebhookSubscriptions = (db: Database) => db.query.webhookSubscriptions.findMany({ orderBy: asc(webhookSubscriptions.name) });

export const listWebhookDeliveries = (db: Database, subscriptionId: string, limit = 50) =>
  db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subscriptionId)).orderBy(desc(webhookDeliveries.id)).limit(limit);

/** Plugin-only events get no deliveries, even for `*` or subscriptions saved before the change. */
export const fanOutEvent = async (db: Database, event: { id: string; type: string }) => {
  if (isPluginOnlyEvent(event.type)) return 0;
  const subscriptions = (await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.isActive, true))).filter((s) =>
    s.events.some((p) => matchesEventPattern(p, event.type)),
  );
  if (subscriptions.length === 0) return 0;
  await db.insert(webhookDeliveries).values(subscriptions.map((s) => ({ subscriptionId: s.id, eventId: event.id, eventType: event.type })));
  return subscriptions.length;
};

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` */
export const signPayload = (secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) =>
  `t=${timestamp},v1=${hmacSha256(secret, `${timestamp}.${body}`)}`;

export const verifySignature = (secret: string, body: string, header: string, toleranceSeconds = 300) => {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  // Constant-time, so timing reveals nothing about the expected signature.
  return typeof parts.v1 === "string" && safeEqual(parts.v1, hmacSha256(secret, `${timestamp}.${body}`));
};

/** Exponential backoff with jitter: ~30s, 1m, 2m, 4m … capped at 6h. */
export const nextRetryDelayMs = (attempts: number) => Math.min(6 * 3600_000, 30_000 * 2 ** Math.max(0, attempts - 1)) * (0.8 + Math.random() * 0.4);

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/** Resolves as connecting would, but fails if any of the host's addresses is not public. */
const publicLookup: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    const refused = addresses?.find((a) => !isPublicAddress(a.address));
    if (error || refused) callback(error ?? new Error(`${hostname} resolves to ${refused!.address}, which is not a public address`), []);
    else if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });

/**
 * Follows no redirects and, unless ALLOW_PRIVATE_WEBHOOK_URLS=true, connects only to public addresses,
 * checked as the host resolves, so DNS can't aim a webhook at a private network.
 */
const sendWebhook: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const checked = !privateTargetsAllowed();
    // Connecting to an IP literal skips the lookup.
    if (checked && isIP(host) && !isPublicAddress(host)) return reject(new Error(`${host} is not a public address`));
    const fail = (error: Error) => reject(init.signal.reason ?? error);
    const options = { method: init.method, headers: init.headers, signal: init.signal, lookup: checked ? publicLookup : undefined };
    const received = (response: IncomingMessage) => response.on("error", fail).on("end", () => resolve({ status: response.statusCode! })).resume();
    const request = target.protocol === "https:" ? httpsRequest(target, options, received) : httpRequest(target, options, received);
    request.on("error", fail).end(init.body);
  });

/** Leases the next due delivery; another worker picks it up if this one dies before recording. */
const claimDueDelivery = async (db: Database, now: Date, leaseMs: number): Promise<WebhookDelivery | null> => {
  const due = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.status, ["pending", "failed"]), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const [claimed] = await db
    .update(webhookDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() + leaseMs) })
    .where(inArray(webhookDeliveries.id, due))
    .returning();
  return claimed ?? null;
};

/** Several workers can run this at once: each delivery is leased first. `deadline` is epoch ms. */
export const deliverDueWebhooks = async (
  db: Database,
  options: { fetch?: FetchLike; timeoutMs: number; maxAttempts: number; batchSize: number; now?: Date; deadline?: number },
): Promise<{ delivered: number; failed: number }> => {
  const now = options.now ?? new Date();
  let delivered = 0;
  let failed = 0;
  const doFetch: FetchLike = options.fetch ?? sendWebhook;
  for (let i = 0; i < options.batchSize; i++) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    const delivery = await claimDueDelivery(db, now, options.timeoutMs + 30_000);
    if (!delivery) break;
    const [subscription, event] = await Promise.all([
      db.query.webhookSubscriptions.findFirst({ where: eq(webhookSubscriptions.id, delivery.subscriptionId) }),
      db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, delivery.eventId) }),
    ]);
    const markDead = (lastError: string) => db.update(webhookDeliveries).set({ status: "dead", lastError, updatedAt: new Date() }).where(eq(webhookDeliveries.id, delivery.id));
    if (!subscription || !event) {
      await markDead("subscription or event missing");
      continue;
    }
    // Queued before the event became plugin-only: it carries credentials, so it is never sent.
    if (isPluginOnlyEvent(event.type)) {
      await markDead("only plugins receive this event");
      continue;
    }
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      data: { aggregateType: event.aggregateType, aggregateId: event.aggregateId, ...event.payload },
    });
    const attempts = delivery.attempts + 1;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const response = await doFetch(subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "spindlecommerce-webhooks/1",
          "x-spindle-event": event.type,
          "x-spindle-delivery": delivery.id,
          "x-spindle-signature": signPayload(subscription.secret, body),
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      statusCode = response.status;
      if (response.status < 200 || response.status >= 300) error = `HTTP ${response.status}`;
    } catch (e) {
      error = (e as Error).message;
    }
    if (!error) {
      delivered++;
      await db.update(webhookDeliveries).set({ status: "succeeded", attempts, lastStatusCode: statusCode, lastError: null, deliveredAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, delivery.id));
    } else {
      failed++;
      const dead = attempts >= options.maxAttempts;
      await db
        .update(webhookDeliveries)
        .set({ status: dead ? "dead" : "failed", attempts, lastStatusCode: statusCode, lastError: error, nextAttemptAt: new Date(now.getTime() + nextRetryDelayMs(attempts)), updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
    }
  }
  return { delivered, failed };
};

export const retryWebhookDelivery = async (db: Database, id: string) => {
  const [row] = await db.update(webhookDeliveries).set({ status: "pending", nextAttemptAt: new Date(), updatedAt: new Date() }).where(eq(webhookDeliveries.id, id)).returning();
  if (!row) throw new NotFoundError("WebhookDelivery", id);
  return row;
};

export const searchWebhookDeliveries = async (
  db: Database,
  filter: { status?: DeliveryStatus | null; subscriptionId?: string | null },
  page: { limit: number; afterId?: string | null },
) => {
  const conditions = [];
  if (filter.status) conditions.push(eq(webhookDeliveries.status, filter.status));
  if (filter.subscriptionId) conditions.push(eq(webhookDeliveries.subscriptionId, filter.subscriptionId));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(page.afterId ? and(where, lt(webhookDeliveries.id, page.afterId)) : where)
    .orderBy(desc(webhookDeliveries.id))
    .limit(page.limit);
  const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(webhookDeliveries).where(where)) as [{ total: number }];
  return { rows, total };
};

export const getDeliveryEvent = (db: Database, eventId: string) => db.query.outboxEvents.findFirst({ where: eq(outboxEvents.id, eventId) });
