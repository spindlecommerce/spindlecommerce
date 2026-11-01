# Payments

Payment methods (Settings › Payments) are what customers choose at checkout, such as "Credit card" or "Bank transfer". Each uses a **provider**, which talks to a payment service provider (PSP). The platform owns orders, payment transactions, invoices and refunds.

Providers are built in (`offline`, `test_gateway`) or come from plugins, such as the first-party [Stripe plugin](../plugins/stripe/README.md). A plugin's provider is offered at checkout only while its plugin is enabled and configured (Settings › Plugins).

Code: [`src/modules/payments/`](../src/modules/payments) (providers, methods, the payment ledger, webhook application), [`src/modules/checkout/`](../src/modules/checkout) (sessions and order placement), [`src/http/payments.ts`](../src/http/payments.ts) (PSP webhooks) and the provider contract, `PaymentProviderDefinition`, in [`src/plugins/sdk.ts`](../src/plugins/sdk.ts).

## Storefront checkout

These steps are for a provider with its own payment UI, such as Stripe's Payment Element. Providers without a session (`offline`, `test_gateway`) skip steps 3 to 5.

1. **Fill the cart.** Add lines, then save the shopper's details (email, addresses, shipping method) with `cartUpdate` as they type, in any order. `cart.missing` lists what is still needed.

2. **Choose a payment method** from `cart.availablePaymentMethods { code name instructions provider sessionRequired }` and set it with `cartUpdate(cartId, input: { paymentMethodCode })`. Only methods whose provider is installed, active and available for the cart's currency, country and total are listed.

3. **Start the payment session** when `sessionRequired` is true:

   ```graphql
   mutation ($cartId: ID!) {
     cartPaymentSessionCreate(cartId: $cartId) {
       __typename
       ... on CartPaymentSessionPayload { session { provider methodCode amount { amount currencyCode } clientData } }
       ... on CartNotReadyError { missing }
       ... on Error { code message }
     }
   }
   ```

   - `clientData` is the provider's data for the browser. For `provider: "stripe"` it is `{ clientSecret, publishableKey }`: load Stripe.js with `publishableKey`, create `stripe.elements({ clientSecret })` and mount the Payment Element.
   - `CartNotReadyError { missing: [PAYMENT_METHOD] }` means no available method is selected. `InvalidStateError` means the cart became an order, or the provider refused the payment and the message says why.
   - The session is for the cart's current total. It can start before the address and shipping method are set.

4. **Keep the session in step with the cart.** Call `cartPaymentSessionCreate` again after anything that can change the total (lines, coupons, shipping address or method, billing country), after `checkoutPlaceOrder` fails (the platform may have released the payment), and when the shopper pays, after saving any unsaved details. It updates the same PSP payment, the same Stripe PaymentIntent and `clientSecret`, so then call `elements.fetchUpdates()`. If `clientSecret` changed because the old payment could no longer be updated, recreate the Elements group with the new one.

5. **Confirm the payment in the browser** before placing the order:

   ```js
   const { error, paymentIntent } = await stripe.confirmPayment({
     elements,
     confirmParams: { return_url: `${origin}/checkout/complete?cart=${cartId}` },
     redirect: "if_required",
   });
   ```

   - `error`: show `error.message` and let the customer try again. Nothing was charged, and the session stays valid.
   - `paymentIntent` (status `requires_capture`, `succeeded` or `processing`): go on to step 6.
   - Payment methods that redirect (3-D Secure on some cards, iDEAL, Bancontact, …) come back to `return_url` with `payment_intent`, `payment_intent_client_secret` and `redirect_status` in the query. On `redirect_status=succeeded` or `processing`, go on to step 6. On `failed`, show the payment step again with the same session. Keep the cart id and the idempotency key across the redirect, e.g. in `sessionStorage`.

6. **Place the order** with the same cart and an empty `payment`:

   ```graphql
   mutation ($cartId: ID!, $key: String!) {
     checkoutPlaceOrder(cartId: $cartId, idempotencyKey: $key, payment: {}) {
       __typename
       ... on CheckoutPayload { order { id number paymentStatus } }
       ... on PaymentDeclinedError { declineCode message }
       ... on CartNotReadyError { missing }
       ... on InsufficientStockError { sku available }
       ... on ValidationError { message fieldErrors { path message } }
       ... on Error { code message }
     }
   }
   ```

   The platform checks the payment with the PSP and records it:

   - `CheckoutPayload`: the order is placed. `paymentStatus` is `AUTHORIZED` (capture later), `PAID` (captured at checkout) or `PENDING` (the PSP is still processing, as with a bank debit, and a webhook updates the order when it settles).
   - `PaymentDeclinedError`: the payment is incomplete or does not match the order (`declineCode`, e.g. `card_declined`, `payment_incomplete`, `amount_mismatch`). The order was canceled, its stock released and the cart reopened. Back to step 4.
   - `CartNotReadyError`, `InsufficientStockError` (stock ran out since the customer paid) or `ValidationError` (a plugin's checkout check refused the order, with `fieldErrors` paths from the cart such as `["shippingAddress", "postalCode"]`): no order was written, and any money the session secured is released. Stripe cancels the authorization or refunds the payment. Let the customer fix the cart, then back to step 4.
   - Retrying with the same `idempotencyKey` returns the same order. If the cart already became an order, `checkoutPlaceOrder` returns it whatever the key.

**Without a session**, paying is one call: `checkoutPlaceOrder(cartId, idempotencyKey, input: { email, shippingAddress, paymentMethodCode, … }, payment: { token })`.

**Customers who never come back.** If the browser never returns from a redirect, the PSP's webhook still reports the payment, and the platform places the order from the cart. If the customer does come back, step 6 returns that order.

## Payment methods and providers

Admin GraphQL:

- `paymentMethods`, `paymentMethodCreate`, `paymentMethodUpdate`: methods, each with a provider (fixed once created), capture mode, countries, channels and position.
- `paymentProviders { code title description plugin active }`: the installed providers, for the method form. `active` is false for a plugin provider whose plugin is disabled or still needs settings, and methods using it are hidden at checkout.

Capture modes: `AUTHORIZE` authorizes at checkout, and staff capture later from the admin, on shipment. `AUTHORIZE_CAPTURE` captures at checkout.

## PSP webhooks

`POST /payments/webhooks/<provider>`, under the API's base path, e.g. `https://shop-api.example.com/payments/webhooks/stripe`. The provider verifies the request's signature and translates it into payment events, and the platform applies each event once:

| Event | Effect |
|---|---|
| `authorized` | A pending order becomes authorized (transaction, order event, `order.payment_authorized`). |
| `captured` | The captured amount is recorded (transaction, invoice, `order.payment_captured`), up to what the PSP reports as captured in total, so a capture made in the admin is not counted twice. |
| `authorized` or `captured` with no order yet | The safety net: the order is placed from the cart the payment belongs to (`cartId`), as checkout would have. |
| `failed` | A failed transaction and an order event on an order still awaiting payment. |
| `canceled` | An authorization canceled at the PSP (e.g. expired): a void transaction and `paymentStatus` voided. |
| `refunded` | A refund made at the PSP (e.g. in the Stripe dashboard): a refund, `amountRefunded`, `order.refunded`. A refund already recorded with the same PSP refund id, such as one made in the admin, is not counted again. |
| `dispute_opened`, `dispute_closed` | An order event, and `order.payment_disputed` on open. |

Responses: 200 `{ "received": true }` or the provider's own response, 404 for an unknown provider or one without webhooks, 400 without details when the request cannot be verified, and 500 when applying failed, so the PSP retries.

**Once each.** An event's effect is recorded with a transaction whose unique `reference_key` is `<provider>:<event id>`, or `<provider>:refund:<refund id>` for refunds, since one event may list several refunds and later events list them again. A redelivered event finds its key and changes nothing. Events that record no transaction are idempotent by state: `authorized` for an authorized order does nothing.

**Which order.** The one whose authorization or capture has the event's `pspReference`, else the order the event's cart became, else the order named in the PSP's metadata. If that order paid with another payment of the same provider, the event is about a second payment: an `authorized` or `captured` one is released (the customer paid twice), and anything else is ignored. Events about payments the platform doesn't know, such as another app's on the same Stripe account, are acknowledged and ignored.

**The safety net** places the order with the idempotency key `<provider>:<pspReference>` and `paymentData: { pspReference }`, so the provider checks the payment the event reported. If the order is refused for any reason checkout refuses one (stock ran out, a plugin's check, a payment that doesn't match the total), the payment is released and the event acknowledged, since a retry would change nothing. If the cart now pays with another provider's method, the payment is released and no order is placed.

## Sessions and released payments

`cartPaymentSessionCreate` prices the cart with live shipping rates, then calls the provider's `createSession` with the total, the lines and addresses, the capture mode and `previous`, the session data the cart kept from this provider, so the provider updates its payment instead of starting another. The cart keeps `{ provider, methodCode, amount, currency, data }` in `carts.payment_session`. `data` never leaves the server. `clientData` goes to the browser and is not stored.

`checkoutPlaceOrder` then:

1. Checks the cart outside any transaction: it must be complete (`CartNotReadyError`), its payment method available (providers' `isAvailable`), and not refused by a plugin (`checkoutValidate`, 5 seconds each, whose issues become a `ValidationError` with `fieldErrors`).
2. Writes the order in one transaction, without asking about payment availability again while the cart is locked.
3. Calls `authorize` with the session's `data`, when the provider is the session's, and records whatever a webhook has not already recorded.

If a checkout whose session may have secured money places no order, because step 1 or 2 refused it or `authorize` declined it, the provider's `void` is called with an empty `orderId` and the session. The provider gives back what was secured, as when Stripe cancels an authorization or refunds a payment, and leaves an unpaid payment usable. This is best-effort and logged either way: `Released the payment of a checkout that placed no order`, or an error telling staff to release it with the PSP.

## Writing a payment provider

A plugin adds providers with `payments: [definition]` ([`PaymentProviderDefinition`](../src/plugins/sdk.ts)). The Stripe plugin is the reference. The platform binds each provider to the plugin's context, so while the plugin is disabled or not configured, its methods are hidden at checkout and its calls fail with `InvalidStateError`.

- **`isAvailable`** (optional): is the provider offered for this currency, country and total? It runs on every cart read, so keep it fast. A throw hides the provider's methods.
- **`createSession`** (optional): start or update the PSP's payment for `input.amount`, updating the one in `input.previous` while it can change. Return `data` (kept with the cart) and `clientData` (for the browser). For a payment the PSP will not take, such as an amount below its minimum, throw `InvalidStateError` with a message the shopper can read.
- **`authorize`**: check what happened, normally in the browser, and return `authorized`, `captured` or `pending` with the payment's `pspReference`. Throw `PaymentDeclinedError` when the payment is incomplete or does not match `amount` and `currency` exactly. The order is then canceled and the cart reopened. Read the payment from `paymentData.pspReference` first (the safety net), then from the provider's own `paymentData` fields, then from `session`.
- **`capture`, `refund`, `void`**: act on an order's payment. `pspReference` is the latest the order recorded, which may be a refund's. `refund` returns the refund's own reference, so the webhook reporting it is recognized. Throw `InvalidStateError` with the PSP's reason for refusals staff should see.
- **`void` without an order** (`orderId` empty): release what `pspReference` or `session` secured.
- **`webhook`**: verify the request's signature, throwing `ValidationError` when it fails or the signing secret is missing, then translate it into events:

  | Field | Meaning |
  |---|---|
  | `id` | The PSP's event id. |
  | `pspReference` | The payment (what `authorize` returned). |
  | `amount`, `currency` | `authorized`: the amount authorized. `captured`: everything captured for the payment so far. `refunded`: the refund's amount. Disputes: the disputed amount. Minor units, ISO currency. |
  | `refundReference` | `refunded`: the refund's own id. Required. |
  | `cartId`, `orderId` | From the PSP's metadata, when it carries them. The cart lets the safety net place the order. |
  | `reason` | `failed`: the PSP's message. `canceled`: why. Disputes: the reason, or how it ended (`won`, `lost`). |

## Known limitations

- **A capture, refund or void made in the admin races its own webhook** for a few milliseconds. The PSP call returns before the platform records it, and the admin's write doesn't check whether a webhook processed in between recorded it too. PSPs usually deliver webhooks seconds later.
- **Two sessions created at once for one cart**, as in two tabs with different totals, can leave a second PSP payment. If the customer pays that one, checkout declines because the cart's session is the other, and the webhook's safety net then places the order with the paid one.
- **Disputes** are recorded and announced (`order.payment_disputed`) but change no amounts. A lost dispute is settled in the PSP's dashboard.
- **A refund made at the PSP** is recorded without lines and restocks nothing. Staff adjust stock by hand.
