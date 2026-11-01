import { definePlugin, PaymentDeclinedError, PLUGIN_API_VERSION, setting } from "../../../../src/plugins/sdk.ts";

/**
 * A plugin using every extension point, for the plugin runtime's tests. Its providers and handlers
 * record what they were called with in its kv store, so tests can see the context they received.
 */
export const kitchenSink = () =>
  definePlugin({
    name: "kitchen-sink",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Kitchen sink",
    description: "Every extension point, for tests.",
    settings: {
      apiKey: setting.secret({ label: "API key", required: true, env: "KITCHEN_SINK_API_KEY" }),
      greeting: setting.string({ label: "Greeting", default: "hello", env: "KITCHEN_SINK_GREETING" }),
      rate: setting.number({ label: "Rate", description: "Shipping rate, minor units.", default: 500, min: 0, integer: true }),
      mode: setting.select({ label: "Mode", options: [{ value: "test", label: "Test" }, { value: "live", label: "Live" }], default: "test" }),
      verbose: setting.boolean({ label: "Verbose" }),
      note: setting.string({ label: "Note", multiline: true }),
    },
    permissions: [{ code: "kitchen-sink:use", description: "Read the kitchen sink's greeting" }],
    emits: ["kitchen-sink.pinged"],

    events: {
      "order.placed": async (event, ctx) => {
        await ctx.kv.set(`seen:${event.id}`, { type: event.type, orderId: event.aggregateId });
      },
      "kitchen-sink.*": async (event) => {
        if (event.payload.fail) throw new Error("the remote service is down");
      },
    },

    hooks: {
      checkoutValidate: (input) => (input.email?.startsWith("blocked@") ? [{ code: "CUSTOMER_BLOCKED", message: "This customer cannot order", field: ["email"] }] : []),
    },

    payments: [
      {
        code: "kitchen_pay",
        title: "Kitchen pay",
        isAvailable: ({ currency }) => currency !== "JPY",
        createSession: async (input) => ({ data: { id: `ks_${input.cartId}`, amount: input.amount }, clientData: { secret: `ks_secret_${input.amount}` } }),
        authorize: async (input, ctx) => {
          if (input.paymentData.token === "decline") throw new PaymentDeclinedError("card_declined", "Declined by the kitchen sink");
          await ctx.kv.set(`authorized:${input.orderId}`, { mode: ctx.settings.mode, amount: input.amount });
          return { status: input.captureImmediately ? "captured" : "authorized", pspReference: `ks_${input.orderNumber}` };
        },
        capture: async (input, ctx) => {
          await ctx.kv.set(`captured:${input.orderId}`, { amount: input.amount, pspReference: input.pspReference });
          return { pspReference: input.pspReference };
        },
        refund: async (input) => ({ pspReference: `ks_refund_${input.amount}` }),
        void: async (input) => ({ pspReference: input.pspReference }),
      },
    ],

    shipping: [
      {
        code: "kitchen_ship",
        title: "Kitchen shipping",
        rates: async (input, ctx) => [{ code: "standard", name: `Kitchen ${input.method.name}`, amount: ctx.settings.rate, carrier: "Kitchen" }],
      },
    ],

    graphql: ({ builder, ADMIN, context }) => {
      builder.queryField("kitchenSinkGreeting", (t) =>
        t.string({
          subGraphs: ADMIN,
          authScopes: { permission: "kitchen-sink:use" },
          resolve: async (_root, _args, graphqlContext) => (await context(graphqlContext)).settings.greeting,
        }),
      );
    },

    routes: (router, api) => {
      router.get("/ping", async (c) => c.json({ pong: (await api.context(c)).settings.greeting }));
      router.post("/emit", async (c) => {
        const ctx = await api.context(c);
        const body = (await c.req.json()) as { id: string; fail?: boolean };
        await ctx.emit({ type: "kitchen-sink.pinged", aggregateType: "Order", aggregateId: body.id, payload: { fail: body.fail === true } });
        return c.json({ ok: true }, 202);
      });
      router.get("/boom", () => {
        throw new Error("boom");
      });
    },

    tasks: [
      {
        name: "count",
        description: "Counts its runs.",
        intervalMinutes: 60,
        run: async (ctx) => {
          await ctx.kv.set("runs", ((await ctx.kv.get<number>("runs")) ?? 0) + 1);
        },
      },
    ],

    migrations: new URL("./migrations/", import.meta.url),

    onStart: async (ctx) => {
      await ctx.kv.set("started", ((await ctx.kv.get<number>("started")) ?? 0) + 1);
    },

    check: async (ctx) => (ctx.settings.apiKey === "good-key" ? { ok: true, message: "Connected in test mode" } : { ok: false, message: "The API key was refused" }),
  });

/** A plugin whose checkout hook always throws: checkout must go on without it. */
export const brokenHook = () =>
  definePlugin({
    name: "broken-hook",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Broken hook",
    hooks: {
      checkoutValidate: () => {
        throw new Error("the fraud service is down");
      },
    },
  });
