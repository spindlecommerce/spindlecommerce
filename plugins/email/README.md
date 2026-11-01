# Email plugin

Transactional email for the platform: order confirmations, shipping, refund and cancellation notices, password resets, and staff alerts for new orders and low stock. It sends through the HTTP APIs of [Resend](https://resend.com) or [Postmark](https://postmarkapp.com), with no SMTP or disk, so it runs on Vercel and other serverless hosts. The default `log` transport sends nothing and only records each email, for development and previews.

Merchant overview: [docs/email.md](../../docs/email.md).

## Install

List the plugin in `ecom.config.ts` and deploy, then enable it and fill in its settings in the admin under **Settings › Plugins › Email**:

```ts
import { email } from "./plugins/email/index.ts";
import { defineConfig } from "./src/plugins/sdk.ts";

export default defineConfig({ plugins: [email()] });
```

Its migration creates the message log, `plugin_email_messages`, when the platform migrates. Then run `pnpm schema:print`, so the admin's GraphQL types include the plugin's fields.

## What it sends

| Event | Email | To |
|---|---|---|
| `order.placed` | Order confirmation: items, totals, addresses | The order's email |
| `order.placed` | New order notice, with a link to the order in the admin | **New order notifications** |
| `order.fulfilled` | Shipped: the shipment's items, tracking numbers linked to the carrier | The order's email |
| `order.refunded` | Refund: the amount and refund number | The order's email |
| `order.canceled` | Canceled | The order's email |
| `customer.password_reset_requested` | Reset link | The customer |
| `staff.password_reset_requested` | Reset link to the admin | The staff member |
| `inventory.level_changed` | Low stock alert | **Low stock recipients** |

- **Language.** Customer emails use the order's locale (de-DE, fr-FR, en-GB, …), with German, French and English copy, and English for other languages. Money and addresses follow the locale and currency. Staff emails are in English. Customer password resets use the customer's locale, else the default locale of the channel they reset from.
- **Declined cards.** A card declined at checkout cancels the order it placed, and the customer sees the decline there. Neither the confirmation nor the cancellation is sent for such an order, unless a confirmation already went out.
- **Shipments.** Each shipment sends one email with its own items and tracking, saying whether part of the order or all of it has shipped. A tracking number's own URL is used when it has one. Otherwise UPS, USPS, FedEx, DHL, Royal Mail, La Poste/Colissimo and Canada Post numbers link to the carrier's tracking page.
- **Customer reset links** come from **Customer password reset link**, a URL with `{token}` and `{email}` placeholders. Without it, the link is the storefront URL (Settings › Storefronts) of the channel the reset came from, or of the default channel, plus `/account/reset-password?token={token}`. Without either, the email is skipped and a warning is logged. The default channel is `DEFAULT_CHANNEL`, else the first active channel.
- **Only plugins receive reset requests.** Both reset events carry a link that opens the account, so webhooks never receive them. Without this plugin, or another plugin that handles them, nobody gets a reset link.
- **Low stock.** After a stock change, the variant's on-hand quantity at that location is compared with **Low stock threshold**. The first change at or below it sends one alert, and the next alert comes only after stock has gone back above the threshold. The platform emits `inventory.level_changed` for stock counts, adjustments, imports and restocks, but not for the deduction when an order ships, so a quantity that only drops through sales is reported at the next stock change.

## Settings

| Setting | Environment variable | Notes |
|---|---|---|
| Transport | | `log` (default), `resend` or `postmark`. |
| Resend API key | `RESEND_API_KEY` | For Resend. |
| Postmark server token | `POSTMARK_SERVER_TOKEN` | For Postmark. |
| From | | `Shop <orders@example.com>`, on a domain verified with the provider. Required to send. |
| Reply-to | | When set, order emails invite customers to reply. |
| Store name | | Defaults to the order's channel name. |
| Logo URL | | An `https` image, shown 40 px high. |
| Accent color | | Hex, for buttons and the header rule. Default `#111827`. |
| Customer password reset link | | See above. |
| New order notifications | | Comma-separated addresses. |
| Low stock threshold, Low stock recipients | | Both needed for alerts. |

Nothing is required, so the plugin is active as soon as it is enabled, with the `log` transport. What Resend and Postmark need (a key, a sender) is checked when sending. A missing one fails the email with a message naming it, in the message log and the server logs. **Test connection** (Settings › Plugins) reports the same, and whether the key works.

## Transports

### Log (default)

Nothing leaves the platform. Every email is rendered and stored in the message log with status `LOGGED`, and a line is logged. Use it in development, in previews, and while you set up a sender domain.

Password reset emails are the exception. Their link opens the account, so whatever the transport, the message log keeps only their subject and recipient. To try resets locally, the `log` transport prints the link to the server's console instead, outside production only. On Vercel, previews count as production, so test resets there with Resend or Postmark.

### Resend

Resend is in the [Vercel Marketplace](https://vercel.com/marketplace/resend).

1. Add your domain in Resend (**Domains › Add domain**). A subdomain such as `mail.example.com` keeps your root domain's mail setup apart.
2. Add the DNS records Resend shows (an SPF `TXT` and an `MX` record on the `send` subdomain, and a DKIM `TXT` record), then wait for the domain to be verified.
3. Create an API key. **Sending access** is enough to send. With **Full access**, Test connection can also check that the From domain is verified.
4. Set `RESEND_API_KEY` (on Vercel, under Project › Settings › Environment Variables, or by connecting the Resend integration), or paste the key into the setting.
5. Set **From** to an address on the verified domain, pick **Resend**, then use **Test connection** and **Send test email**.

Requests: `POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and an `Idempotency-Key` per event and recipient, so a retry after a lost response doesn't send twice. Test connection: `GET https://api.resend.com/domains`.

### Postmark

1. Create a server in Postmark and copy its **Server API token** (Servers › your server › API Tokens).
2. Under **Sender Signatures**, verify the From address or, better, the domain, by adding its DKIM `TXT` record and the Return-Path `CNAME`.
3. Set `POSTMARK_SERVER_TOKEN`, or paste the token into the setting.
4. Set **From**, pick **Postmark**, then use **Test connection** and **Send test email**.

Emails go to the server's default transactional stream, `outbound`. Requests: `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`. Test connection: `GET https://api.postmarkapp.com/server`.

### The sender domain

Whichever provider you use:

- **SPF and DKIM**: add the records the provider gives you. Without them, mail is rejected or lands in spam.
- **DMARC**: a `TXT` record at `_dmarc.example.com`, e.g. `v=DMARC1; p=none; rua=mailto:dmarc@example.com` to start. Gmail and Yahoo require one from bulk senders.
- Send from your own domain, never from a gmail.com or outlook.com address.
- DNS changes can take an hour or more to show up. The provider says when the domain is verified.

## Delivery

Emails go out when the platform's worker processes events: on Vercel within seconds, right after the request that caused them, and elsewhere from the worker loop. Each email is sent once per event and recipient (`ctx.once`), so an event delivered twice doesn't email twice. A failed send (provider error, timeout, missing key) is recorded as `FAILED` with the reason, and the event is retried with backoff (30 s, 1 min, 2 min, …, about an hour in all), sending only the emails that failed. Staff can retry a delivery that ran out of attempts under Settings › Plugins.

Every email is kept in `plugin_email_messages` (recipient, subject, status, provider and its message id, error, HTML and text) for 30 days. A daily task deletes older rows.

## Admin and API

The **Emails** page (Settings) lists the message log with filters, shows each email, previews templates and sends test emails. It needs the `email:read` permission, and sending a test needs `email:send`. Administrators have both.

The admin GraphQL API:

```graphql
query Log {
  emailMessages(first: 20, query: "US-000123", status: FAILED) {
    totalCount
    edges { node { id template to subject status provider error orderNumber createdAt } }
  }
}

query Preview {
  # From a real order (orderId or orderNumber), else sample data in the locale's currency.
  emailPreview(template: ORDER_CONFIRMATION, orderNumber: "US-000123", locale: "de-DE") { subject html text }
}

mutation Test {
  emailSendTest(to: "me@example.com") {
    ... on EmailSendTestPayload { emailMessage { status error providerMessageId } }
  }
}
```

`emailMessage(id)` returns one message with its HTML. Show HTML in a sandboxed iframe (`srcdoc`, no `allow-scripts`).

## Testing

With the `log` transport, place an order in the storefront (or run `pnpm e2e`), then open the Emails page: the confirmation is there with status `LOGGED`. `emailPreview` renders any template without sending, from sample data or a real order.

Tests: `test/unit/email-templates.test.ts` (rendering: escaping, locales, money, tracking links), `test/unit/email-transports.test.ts` (Resend and Postmark requests against a fake fetch), `test/unit/email-delivery.test.ts` (handlers against a hand-built context) and `test/integration/email-plugin.test.ts` (through the platform).

## Files

- `index.ts`: the plugin definition.
- `settings.ts`: settings and address parsing.
- `templates.ts`, `strings.ts`: rendering, and the copy in English, German and French.
- `transports.ts`: log, Resend and Postmark, and the connection check.
- `service.ts`: event handlers, delivery, previews and test sends.
- `messages.ts`, `migrations/`: the message log.
- `graphql.ts`: admin API fields.
- `admin.tsx`: the Emails page.
