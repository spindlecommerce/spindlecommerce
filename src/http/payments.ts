import type { Hono } from "hono";
import { DomainError } from "../lib/errors.ts";
import { applyPaymentWebhookEvents } from "../modules/payments/webhooks.ts";
import type { Platform } from "../platform.ts";

/**
 * POST /payments/webhooks/<provider>, verified by the provider's `webhook()` and applied to orders
 * once each. A DomainError from the provider means unverifiable: 400, no details. Failures while
 * applying answer 500, so the PSP retries.
 */
export const mountPaymentWebhooks = (app: Hono, options: { platform: Platform; base: string }) => {
  const { platform } = options;
  app.post(`${options.base}/payments/webhooks/:provider`, async (c) => {
    const code = c.req.param("provider");
    const provider = platform.payments.get(code);
    if (!provider?.webhook) return c.json({ error: { code: "NOT_FOUND", message: `No webhooks for ${code}` } }, 404);
    // A disabled or unconfigured plugin can't verify yet: 503, so the PSP retries later.
    if (provider.plugin && platform.plugins.get(provider.plugin) && !(await platform.plugins.isActive(provider.plugin))) {
      return c.json({ error: { code: "PLUGIN_UNAVAILABLE", message: `The ${provider.plugin} plugin is not active` } }, 503);
    }
    let result;
    try {
      result = await provider.webhook(c.req.raw);
    } catch (error) {
      if (error instanceof DomainError) {
        platform.logger.warn({ provider: code, err: error }, "Refused a payment webhook");
        return c.json({ error: { code: "INVALID_WEBHOOK", message: "The webhook could not be verified" } }, 400);
      }
      platform.logger.error({ provider: code, err: error }, "Payment webhook failed");
      void platform.plugins.reportError(error, { source: "payment-webhook", plugin: provider.plugin ?? null, details: { provider: code, stage: "verify" } });
      return c.json({ error: { code: "INTERNAL", message: "The webhook could not be processed" } }, 500);
    }
    try {
      await applyPaymentWebhookEvents(platform, provider, result.events);
    } catch (error) {
      platform.logger.error({ provider: code, err: error, events: result.events.map((e) => e.id) }, "Applying payment webhook events failed");
      void platform.plugins.reportError(error, {
        source: "payment-webhook",
        plugin: provider.plugin ?? null,
        details: { provider: code, stage: "apply", events: result.events.map((e) => e.id) },
      });
      return c.json({ error: { code: "INTERNAL", message: "The webhook could not be processed" } }, 500);
    }
    return result.response ?? c.json({ received: true });
  });
};
