import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../../src/plugins/sdk.ts";
import { StripeError, stripeRequest } from "./api.ts";
import { stripeProvider } from "./provider.ts";
import { stripeSettings, type StripeSettings } from "./settings.ts";

const keyMode = (key: string) => (/^(sk|rk|pk)_live_/.test(key) ? "live" : /^(sk|rk|pk)_test_/.test(key) ? "test" : null);

/** "Test connection": the key works, its mode, and what is left to set up. */
export const checkStripe = async (ctx: PluginContext<StripeSettings>): Promise<{ ok: boolean; message: string }> => {
  let livemode: boolean;
  try {
    ({ livemode } = await stripeRequest<{ livemode: boolean }>(ctx, "GET", "/v1/balance"));
  } catch (error) {
    if (error instanceof StripeError && error.status === 401) return { ok: false, message: "Stripe refused the secret key." };
    if (error instanceof StripeError && error.status === 403) return { ok: false, message: "The key may not read the balance: use the secret key, or give the restricted key Balance read access." };
    return { ok: false, message: `Could not reach Stripe: ${error instanceof Error ? error.message : String(error)}` };
  }
  const mode = livemode ? "live" : "test";
  const publishable = keyMode(ctx.settings.publishableKey);
  if (publishable && publishable !== mode) return { ok: false, message: `The secret key is for ${mode} mode but the publishable key is for ${publishable} mode.` };
  const webhooks = ctx.settings.webhookSecret ? "" : " Set the webhook signing secret: webhooks are refused until then.";
  return { ok: true, message: `Connected to Stripe in ${mode} mode.${webhooks}` };
};

/** Stripe payments through the Payment Element. Add `stripe()` to ecom.config.ts; see README.md. */
export const stripe = () =>
  definePlugin({
    name: "stripe",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Stripe",
    description: "Cards, wallets and local payment methods with Stripe's Payment Element, refunds and disputes kept in step by webhook.",
    settings: stripeSettings,
    payments: [stripeProvider],
    check: checkStripe,
  });

export { stripeProvider };
