import { setting } from "../../src/plugins/sdk.ts";

/** Set under Settings › Plugins › Stripe, or from the environment. */
export const stripeSettings = {
  secretKey: setting.secret({
    label: "Secret key",
    required: true,
    env: "STRIPE_SECRET_KEY",
    description: "Developers › API keys in the Stripe dashboard: sk_test_… while testing, sk_live_… in production.",
  }),
  publishableKey: setting.string({
    label: "Publishable key",
    required: true,
    env: "STRIPE_PUBLISHABLE_KEY",
    placeholder: "pk_test_…",
    description: "The same mode as the secret key. Sent to the storefront with each payment session, for Stripe.js.",
  }),
  webhookSecret: setting.secret({
    label: "Webhook signing secret",
    env: "STRIPE_WEBHOOK_SECRET",
    description: "whsec_… of the endpoint https://<API domain>/payments/webhooks/stripe. Webhooks are refused until it is set.",
  }),
  statementDescriptorSuffix: setting.string({
    label: "Statement descriptor suffix",
    placeholder: "SHOP",
    description: "Shown after the account's descriptor on card statements (up to 22 characters, no < > \\ ' \" *).",
  }),
};

export type StripeSettings = typeof stripeSettings;
