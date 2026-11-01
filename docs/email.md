# Email

The email plugin sends order confirmations, shipping notices with tracking links, refund and cancellation notices, password resets, and staff alerts about new orders and low stock. It sends through Resend or Postmark. Until you pick one, it only records each email so you can see it. Details and setup: [plugins/email/README.md](../plugins/email/README.md).

## What your customers receive

| When | Email |
|---|---|
| They place an order | Order confirmation: items, totals and addresses |
| You ship (part of) it | Shipped, with the items in that parcel and tracking links |
| You refund | The amount refunded |
| You cancel the order | Canceled |
| They ask to reset their password | A reset link to your storefront |

Emails are in the language the customer shopped in, with prices in the order's currency and format. They are written in English, German and French, and other languages get English. Staff get English emails: a notice of every new order with a link to it in the admin, password reset links, and low stock alerts.

A card declined at checkout sends nothing: the customer saw the decline and can try again.

## Setting it up

1. In **Settings › Plugins › Email**, enable the plugin. It starts with the **Log only** transport, which sends nothing.
2. Set the **store name**, **logo URL** and **accent color** if the channel name and the defaults don't suit you, and the addresses for **new order notifications** and **low stock** alerts.
3. Set up a sender: create a Resend or Postmark account, verify your domain there with DNS records, and add its API key or server token. On Vercel, the Resend Marketplace integration adds `RESEND_API_KEY`.
4. Set **From** (e.g. `Shop <orders@example.com>`, on the verified domain), choose **Resend** or **Postmark** as the transport, and press **Test connection**.
5. Use **Settings › Emails › Send test email** to email your own address.

If your storefront's password reset page is not `/account/reset-password?token=…`, set **Customer password reset link** to its address, with `{token}` where the reset token goes.

Keep the plugin enabled. Only plugins send password reset links, never webhooks, so without it customers and staff cannot reset their passwords.

## Seeing what was sent

**Settings › Emails** lists every email of the last 30 days: to whom, which template, and whether it was sent, only logged, or failed, with the reason. Open one to see it as the customer did. **Preview** shows any template in any language, from a real order number or sample data, without sending it.

A failed email, for example when the provider is down or a key is wrong, is retried for about an hour, and is sent once the problem is fixed. Each email is sent once, even when the platform processes an event twice.
