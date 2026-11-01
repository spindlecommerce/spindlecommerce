import { definePlugin, PLUGIN_API_VERSION, setting, type PluginOrder } from "../../../../src/plugins/sdk.ts";

/**
 * Order alerts: posts orders above a threshold to a chat webhook (Slack, Discord and Teams
 * incoming webhooks all take a JSON POST). The complete example of docs/plugins.md, exercised by
 * test/integration/plugins.test.ts. In an installation it would live in plugins/order-alerts/ and
 * be listed in ecom.config.ts as `orderAlerts()`.
 */
const text = (order: PluginOrder, mention: string | undefined) =>
  `${mention ? `${mention} ` : ""}Order ${order.number}: ${(order.grandTotal / 100).toFixed(2)} ${order.currency} from ${order.email}`;

export const orderAlerts = () =>
  definePlugin({
    name: "order-alerts",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Order alerts",
    description: "Posts orders above a threshold to a chat webhook.",
    settings: {
      webhookUrl: setting.secret({ label: "Webhook URL", description: "An incoming webhook of Slack, Discord or Teams.", required: true, env: "ORDER_ALERTS_WEBHOOK_URL" }),
      threshold: setting.number({ label: "Threshold", description: "Alert on orders of at least this total, in minor units (cents).", default: 10_000, min: 0, integer: true }),
      mention: setting.string({ label: "Mention", placeholder: "@sales" }),
    },
    permissions: [{ code: "order-alerts:read", description: "See when an order was alerted" }],
    emits: ["order-alerts.sent"],

    events: {
      "order.placed": async (event, ctx) => {
        const order = await ctx.services.orders.get(event.aggregateId);
        if (!order || order.grandTotal < ctx.settings.threshold) return;
        // Deliveries are retried and may run twice: post once per order, whatever happens.
        const posted = await ctx.once(`order:${order.id}`, async () => {
          const response = await ctx.fetch(ctx.settings.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text(order, ctx.settings.mention) }),
          });
          if (!response.ok) throw new Error(`The webhook answered ${response.status}`);
        });
        if (!posted) return;
        await ctx.kv.set(`sent:${order.id}`, new Date().toISOString());
        await ctx.emit({ type: "order-alerts.sent", aggregateType: "Order", aggregateId: order.id, payload: { number: order.number } });
      },
    },

    // Order.alertSentAt in the admin API, for staff allowed to see it.
    graphql: ({ builder, refs, ADMIN, context }) => {
      builder.objectField(refs.OrderRef, "alertSentAt", (t) =>
        t.field({
          type: "DateTime",
          nullable: true,
          subGraphs: ADMIN,
          authScopes: { permission: "order-alerts:read" },
          description: "When the order was posted to the chat (Order alerts plugin).",
          resolve: async (order, _args, graphqlContext) => {
            const ctx = await context(graphqlContext);
            const at = await ctx.kv.get<string>(`sent:${order.id}`);
            return at ? new Date(at) : null;
          },
        }),
      );
    },

    // GET /plugins/order-alerts/status
    routes: (router, api) => {
      router.get("/status", async (c) => {
        const ctx = await api.context(c);
        return c.json({ sent: (await ctx.kv.list("sent:", { limit: 1000 })).length, threshold: ctx.settings.threshold });
      });
    },

    tasks: [
      {
        name: "forget",
        description: "Forgets alerts older than 90 days.",
        intervalMinutes: 24 * 60,
        run: async (ctx) => {
          const cutoff = Date.now() - 90 * 24 * 3600_000;
          for (const { key, value } of await ctx.kv.list<string>("sent:", { limit: 1000 })) if (Date.parse(value) < cutoff) await ctx.kv.delete(key);
        },
      },
    ],

    check: async (ctx) => {
      const response = await ctx.fetch(ctx.settings.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Order alerts are connected." }),
      });
      return response.ok ? { ok: true, message: "Posted a test message" } : { ok: false, message: `The webhook answered ${response.status}` };
    },
  });
