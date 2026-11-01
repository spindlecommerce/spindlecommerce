# Stripe

Card payments, wallets (Apple Pay, Google Pay, Link) and local payment methods through Stripe's [Payment Element](https://docs.stripe.com/payments/payment-element) and the PaymentIntents API. Refunds and disputes made in the Stripe dashboard reach the orders by webhook, and an order is placed even when the customer never comes back from a redirect.

The plugin adds one payment provider, `stripe`. Payment methods (Settings › Payments) that use it are offered at checkout once the plugin is enabled and its keys are set.

Code: [`index.ts`](index.ts) (the plugin and its connection check), [`provider.ts`](provider.ts) (the provider), [`api.ts`](api.ts) (Stripe's REST API over the platform's `fetch`, with no SDK) and [`settings.ts`](settings.ts).

## Install

1. List it in `ecom.config.ts` and deploy:

   ```ts
   import { stripe } from "./plugins/stripe/index.ts";
   export default defineConfig({ plugins: [stripe()] });
   ```

2. Set the keys (below) under **Settings › Plugins › Stripe** or in the environment, and press **Test connection**.
3. Add the webhook endpoint in Stripe (below).
4. Under **Settings › Payments**, create a payment method with the provider **Stripe**, e.g. "Card", with the capture mode you want.

## Keys

Start in test mode. In the [Stripe dashboard](https://dashboard.stripe.com/test/apikeys), with **Test mode** on, open **Developers › API keys**:

| Setting | Environment variable | Value |
|---|---|---|
| Secret key | `STRIPE_SECRET_KEY` | `sk_test_…`. A restricted key works too, with write access to PaymentIntents and Refunds and read access to Charges and Balance. |
| Publishable key | `STRIPE_PUBLISHABLE_KEY` | `pk_test_…`, from the same mode as the secret key. The storefront gets it with each payment session. |
| Webhook signing secret | `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the endpoint below. Webhooks are refused until it is set. |
| Statement descriptor suffix | | Optional. Shown after the account's descriptor on card statements. |

A value in the environment wins over the admin, which then shows the field as set by the environment. Secrets are encrypted at rest and never shown again.

**Test connection** reads the account balance. It says whether the key works, whether it is a test or live key, and whether the publishable key is from the same mode.

**Going live:** switch the dashboard out of test mode, then replace all three values with the live ones: `sk_live_…`, `pk_live_…`, and the live endpoint's `whsec_…`, since test and live endpoints have different secrets.

## Webhook endpoint

In **Developers › Webhooks**, add an endpoint:

- **URL:** `https://<api domain>/payments/webhooks/stripe`, e.g. `https://shop-api.example.com/payments/webhooks/stripe`, after the API's base path if it has one.
- **Events:**
  - `payment_intent.amount_capturable_updated`: a payment authorized (capture later);
  - `payment_intent.succeeded`: a payment captured;
  - `payment_intent.payment_failed`: a payment failed, e.g. a bank debit that bounced;
  - `payment_intent.canceled`: an authorization canceled or expired (Stripe cancels uncaptured authorizations after 7 days for most cards);
  - `charge.refunded`: a refund, wherever it was made;
  - `charge.dispute.created`, `charge.dispute.closed`: chargebacks.

Copy the endpoint's **Signing secret** into the webhook signing secret setting. Each request's `Stripe-Signature` is checked (HMAC-SHA256, constant time, at most 5 minutes old), and anything else is answered 400 without details.

Locally, the [Stripe CLI](https://docs.stripe.com/stripe-cli) forwards events: `stripe listen --forward-to localhost:4000/payments/webhooks/stripe` prints the signing secret to use.

[docs/payments.md](../../docs/payments.md#psp-webhooks) says what each event does to orders. Every event is applied once, however often Stripe delivers it.

## Capture modes

The payment method's capture mode decides how the PaymentIntent is made:

- **Later** (authorize at checkout, capture on shipment): `capture_method=manual`. The order is `AUTHORIZED`, and staff capture all or part of it from the order when it ships. Card authorizations expire after about 7 days, so capture before then, or the webhook marks the payment voided.
- **At checkout:** `capture_method=automatic`. The order is `PAID`, with its invoice.

Payment methods that settle later (SEPA Direct Debit, ACH, …) leave the order `PENDING` until Stripe reports the outcome by webhook. Canceling an authorized order cancels the PaymentIntent, and refunds in the admin refund through Stripe.

## Testing

In test mode, pay with Stripe's [test cards](https://docs.stripe.com/testing), any future expiry date and any CVC:

| Card | Outcome |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0025 0000 3155` | Asks for 3-D Secure authentication |
| `4000 0000 0000 9995` | Declined: insufficient funds |
| `4000 0000 0000 0002` | Declined: generic decline |
| `4000 0000 0000 0259` | Succeeds, then is disputed (fraudulent), to try the dispute webhooks |

`stripe trigger payment_intent.succeeded` (Stripe CLI) sends events about payments the platform doesn't know, which are acknowledged and ignored.

## Storefront: the Payment Element

[docs/payments.md](../../docs/payments.md#storefront-checkout) has the checkout flow step by step. In short, with [`@stripe/stripe-js`](https://github.com/stripe/stripe-js):

```ts
import { loadStripe } from "@stripe/stripe-js";

// After cartUpdate sets a payment method whose sessionRequired is true:
const { session } = (await gql(`mutation ($cartId: ID!) { cartPaymentSessionCreate(cartId: $cartId) {
  ... on CartPaymentSessionPayload { session { clientData } } } }`, { cartId })).cartPaymentSessionCreate;
const { clientSecret, publishableKey } = session.clientData;

const stripe = await loadStripe(publishableKey);
const elements = stripe.elements({ clientSecret });
elements.create("payment").mount("#payment-element");

// When the cart total changes: call cartPaymentSessionCreate again, then
await elements.fetchUpdates();

// On "Pay":
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: `${location.origin}/checkout/complete?cart=${cartId}` },
  redirect: "if_required",
});
if (!error) await gql(`mutation ($cartId: ID!, $key: String!) { checkoutPlaceOrder(cartId: $cartId, idempotencyKey: $key, payment: {}) { __typename } }`, { cartId, key });
```

The PaymentIntent carries the cart (`metadata.cart_id`) and, once the order is placed, the order (`order_id`, `order_number`), so payments are easy to find in the dashboard.

`clientSecret` is null when the cart total is zero. Nothing needs paying, so place the order directly.
