import { definePlugin, PLUGIN_API_VERSION } from "../../src/plugins/sdk.ts";
import { registerGraphQL } from "./graphql.ts";
import { pruneMessages } from "./messages.ts";
import * as handlers from "./service.ts";
import { settings } from "./settings.ts";
import { checkTransport } from "./transports.ts";

const RETENTION_DAYS = 30;

/** Transactional email via Resend or Postmark; the default `log` transport only records. */
export const email = () =>
  definePlugin({
    name: "email",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Email",
    description: "Order, password reset and stock alert emails, sent with Resend or Postmark, or only logged while you set up.",
    settings,
    permissions: [
      { code: "email:read", description: "See the email log and preview templates" },
      { code: "email:send", description: "Send test emails" },
    ],
    events: {
      "order.placed": handlers.onOrderPlaced,
      "order.fulfilled": handlers.onOrderFulfilled,
      "order.refunded": handlers.onOrderRefunded,
      "order.canceled": handlers.onOrderCanceled,
      "customer.password_reset_requested": handlers.onCustomerPasswordReset,
      "staff.password_reset_requested": handlers.onStaffPasswordReset,
      "inventory.level_changed": handlers.onInventoryLevelChanged,
    },
    tasks: [
      {
        name: "prune-messages",
        description: `Delete logged emails older than ${RETENTION_DAYS} days`,
        intervalMinutes: 24 * 60,
        run: async (ctx) => {
          const deleted = await pruneMessages(ctx.db, RETENTION_DAYS);
          if (deleted) ctx.logger.info({ deleted }, "pruned the email log");
        },
      },
    ],
    migrations: new URL("./migrations/", import.meta.url),
    graphql: registerGraphQL,
    admin: new URL("./admin.tsx", import.meta.url),
    check: checkTransport,
  });

export default email;
