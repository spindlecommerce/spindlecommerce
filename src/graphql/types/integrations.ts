import { toGlobalId } from "../../lib/ids.ts";
import { redact } from "../../modules/audit/service.ts";
import { knownEventTypes } from "../../modules/integrations/outbox.ts";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getDeliveryEvent,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  retryWebhookDelivery,
  searchWebhookDeliveries,
  updateWebhookSubscription,
} from "../../modules/integrations/webhooks.ts";
import { ADMIN, builder, connectionComplexity, rawId } from "../builder.ts";
import { keysetConnection } from "../pagination.ts";
import { WebhookDeliveryRef, WebhookSubscriptionRef } from "../refs.ts";
import { DeletePayload } from "./common.ts";

const RESET_LINK = new Set(["url"]);

const DeliveryStatus = builder.enumType("WebhookDeliveryStatus", {
  subGraphs: ADMIN,
  values: { PENDING: { value: "pending" }, SUCCEEDED: { value: "succeeded" }, FAILED: { value: "failed", description: "Will retry with backoff." }, DEAD: { value: "dead", description: "Gave up; retry manually." } } as const,
});

builder.node(WebhookDeliveryRef, {
  subGraphs: ADMIN,
  id: { resolve: (d) => d.id },
  loadMany: async (ids, ctx) => {
    const rows = await ctx.db.query.webhookDeliveries.findMany({ where: (d, { inArray }) => inArray(d.id, ids) });
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    eventId: t.id({ resolve: (d) => toGlobalId("Event", d.eventId) }),
    eventType: t.exposeString("eventType"),
    status: t.field({ type: DeliveryStatus, resolve: (d) => d.status }),
    attempts: t.exposeInt("attempts"),
    nextAttemptAt: t.field({ type: "DateTime", resolve: (d) => d.nextAttemptAt }),
    lastStatusCode: t.exposeInt("lastStatusCode", { nullable: true }),
    lastError: t.exposeString("lastError", { nullable: true }),
    deliveredAt: t.field({ type: "DateTime", nullable: true, resolve: (d) => d.deliveredAt }),
    createdAt: t.field({ type: "DateTime", resolve: (d) => d.createdAt }),
  }),
});

builder.node(WebhookSubscriptionRef, {
  subGraphs: ADMIN,
  id: { resolve: (s) => s.id },
  loadMany: async (ids, ctx) => {
    const rows = await listWebhookSubscriptions(ctx.db);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    name: t.exposeString("name"),
    url: t.exposeString("url"),
    events: t.exposeStringList("events"),
    isActive: t.exposeBoolean("isActive"),
    createdAt: t.field({ type: "DateTime", resolve: (s) => s.createdAt }),
    deliveries: t.field({
      type: [WebhookDeliveryRef],
      args: { limit: t.arg.int({ defaultValue: 20 }) },
      resolve: (s, { limit }, ctx) => listWebhookDeliveries(ctx.db, s.id, Math.min(limit ?? 20, 100)),
    }),
  }),
});

builder.queryFields((t) => ({
  webhookSubscriptions: t.field({ type: [WebhookSubscriptionRef], subGraphs: ADMIN, authScopes: { permission: "integrations:read" }, resolve: (_r, _a, ctx) => listWebhookSubscriptions(ctx.db) }),
  eventTypes: t.stringList({
    subGraphs: ADMIN,
    description: "Every event type, the installed plugins' included; subscriptions may also use prefixes such as order.*",
    authScopes: { staff: true },
    resolve: () => knownEventTypes(),
  }),
}));

const WebhookSubscriptionPayload = builder.simpleObject("WebhookSubscriptionPayload", { subGraphs: ADMIN, fields: (t) => ({ webhookSubscription: t.field({ type: WebhookSubscriptionRef }) }) });
const WebhookSubscriptionCreatePayload = builder.simpleObject("WebhookSubscriptionCreatePayload", {
  subGraphs: ADMIN,
  fields: (t) => ({
    webhookSubscription: t.field({ type: WebhookSubscriptionRef }),
    secret: t.string({ description: "Shown once. Verify X-Spindle-Signature: t=<ts>,v1=HMAC-SHA256(secret, \"<ts>.<body>\")." }),
  }),
});
const WebhookDeliveryPayload = builder.simpleObject("WebhookDeliveryPayload", { subGraphs: ADMIN, fields: (t) => ({ webhookDelivery: t.field({ type: WebhookDeliveryRef }) }) });
const write = { subGraphs: ADMIN, authScopes: { permission: "integrations:write" }, errors: {} } as const;

builder.mutationFields((t) => ({
  webhookSubscriptionCreate: t.field({
    ...write,
    type: WebhookSubscriptionCreatePayload,
    args: { name: t.arg.string({ required: true }), url: t.arg.string({ required: true }), events: t.arg.stringList({ required: true }) },
    resolve: async (_r, args, ctx) => {
      const webhookSubscription = await createWebhookSubscription(ctx.db, args);
      return { webhookSubscription, secret: webhookSubscription.secret };
    },
  }),
  webhookSubscriptionUpdate: t.field({
    ...write,
    type: WebhookSubscriptionPayload,
    args: { id: t.arg.globalID({ for: [WebhookSubscriptionRef], required: true }), name: t.arg.string(), url: t.arg.string(), events: t.arg.stringList(), isActive: t.arg.boolean() },
    resolve: async (_r, { id, ...rest }, ctx) => ({
      webhookSubscription: await updateWebhookSubscription(ctx.db, rawId(id), Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null))),
    }),
  }),
  webhookSubscriptionDelete: t.field({
    ...write,
    type: DeletePayload,
    args: { id: t.arg.globalID({ for: [WebhookSubscriptionRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("WebhookSubscription", await deleteWebhookSubscription(ctx.db, rawId(id))) }),
  }),
  webhookDeliveryRetry: t.field({
    ...write,
    type: WebhookDeliveryPayload,
    args: { id: t.arg.globalID({ for: [WebhookDeliveryRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ webhookDelivery: await retryWebhookDelivery(ctx.db, rawId(id)) }),
  }),
}));

builder.objectFields(WebhookDeliveryRef, (t) => ({
  subscription: t.field({
    type: WebhookSubscriptionRef,
    nullable: true,
    resolve: async (d, _a, ctx) => (await listWebhookSubscriptions(ctx.db)).find((s) => s.id === d.subscriptionId) ?? null,
  }),
  payload: t.field({
    type: "JSON",
    nullable: true,
    description: "The body this delivery sends, with secrets such as password reset tokens and links redacted.",
    resolve: async (d, _a, ctx) => {
      const event = await getDeliveryEvent(ctx.db, d.eventId);
      if (!event) return null;
      const data = { aggregateType: event.aggregateType, aggregateId: event.aggregateId, ...event.payload };
      return { id: event.id, type: event.type, occurredAt: event.occurredAt.toISOString(), data: redact(data, event.type.endsWith("password_reset_requested") ? RESET_LINK : undefined) };
    },
  }),
}));

builder.queryFields((t) => ({
  webhookDeliveries: t.connection({
    type: WebhookDeliveryRef,
    subGraphs: ADMIN,
    description: "Deliveries across every subscription, newest first.",
    authScopes: { permission: "integrations:read" },
    args: { status: t.arg({ type: DeliveryStatus }), subscriptionId: t.arg.globalID({ for: [WebhookSubscriptionRef] }) },
    complexity: connectionComplexity,
    resolve: (_r, args, ctx) =>
      keysetConnection(args, (page) => searchWebhookDeliveries(ctx.db, { status: args.status, subscriptionId: args.subscriptionId ? rawId(args.subscriptionId) : null }, page)),
  }),
}));
