import { definePlugin, PLUGIN_API_VERSION, setting } from "../../../../src/plugins/sdk.ts";

/**
 * A fixture for the admin's plugin support: settings of every type (a secret among them), a
 * permission, an event handler that fails in Live mode, a task, a connection check, and an admin
 * module with a page in the navigation, a page with a parameter, and widgets on the order screen
 * and the dashboard. To try it, add `adminDemo()` to ecom.config.ts; it is not part of any
 * installation.
 */
export const adminDemo = () =>
  definePlugin({
    name: "admin-demo",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Admin demo",
    description: "Exercises the admin's plugin pages, widgets and settings.",
    settings: {
      greeting: setting.string({ label: "Greeting", description: "Shown on the demo page.", default: "Hello" }),
      apiKey: setting.secret({ label: "API key", description: "Any value starting with demo_ passes the connection test.", required: true, env: "ADMIN_DEMO_API_KEY" }),
      mode: setting.select({
        label: "Mode",
        options: [
          { value: "test", label: "Test" },
          { value: "live", label: "Live" },
        ],
        default: "test",
      }),
      dailyLimit: setting.number({ label: "Daily limit", min: 1, max: 1000, integer: true }),
      verbose: setting.boolean({ label: "Verbose logging", description: "Log every call to the demo service." }),
    },
    permissions: [{ code: "admin-demo:view", description: "Open the admin demo page" }],
    events: {
      // Fails on purpose in Live mode, to show failed deliveries and Retry.
      "order.note_added": async (event, ctx) => {
        if (ctx.settings.mode === "live") throw new Error("Live mode is not connected to anything: switch to Test, then retry");
        ctx.logger.info({ order: event.aggregateId }, "admin demo saw a note");
      },
    },
    tasks: [{ name: "ping", description: "Says hello to the log", intervalMinutes: 60, run: async (ctx) => ctx.logger.info({ greeting: ctx.settings.greeting }, "admin demo ping") }],
    check: async (ctx) =>
      ctx.settings.apiKey.startsWith("demo_") ? { ok: true, message: `Connected in ${ctx.settings.mode} mode.` } : { ok: false, message: "The API key was refused: demo keys start with demo_." },
    admin: new URL("./admin.tsx", import.meta.url),
  });

export default adminDemo;
