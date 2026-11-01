import { sql } from "drizzle-orm";
import type { PluginEvent, PluginOrder } from "../../src/plugins/sdk.ts";
import { recordMessage, wasDelivered, type EmailMessage } from "./messages.ts";
import { parseAddresses, value, type EmailContext } from "./settings.ts";
import * as templates from "./templates.ts";
import { safeColor, safeUrl, type Brand, type Rendered, type TemplateName } from "./templates.ts";
import { PROVIDER_NAMES, transmit, TransportError } from "./transports.ts";

/** Staff emails are in the admin's language. */
export const STAFF_LOCALE = "en";

type Channel = { id: string; name: string; defaultLocale: string; storefrontUrl: string | null };

/** Brand from the settings; the channel supplies the default name and the storefront link. */
export const brandFor = (ctx: EmailContext, channel: Channel | null): Brand => ({
  storeName: value(ctx.settings.storeName) ?? channel?.name ?? "Our store",
  logoUrl: safeUrl(ctx.settings.logoUrl),
  accentColor: safeColor(ctx.settings.accentColor),
  storefrontUrl: safeUrl(channel?.storefrontUrl),
  replyTo: !!value(ctx.settings.replyTo),
});

/** Customers and staff belong to no channel, so their emails use the default one. */
export const defaultChannel = (ctx: EmailContext): Promise<Channel | null> => ctx.services.channels.getDefault();

export const adminOrderUrl = (ctx: EmailContext, order: { number: string }) => `${ctx.urls.admin}/orders/${encodeURIComponent(order.number)}`;
const inventoryUrl = (ctx: EmailContext, sku: string) => `${ctx.urls.admin}/inventory?q=${encodeURIComponent(sku)}`;

/** The `customerResetUrl` pattern filled in, else the storefront's /account/reset-password. */
export const customerResetUrl = (pattern: string | null, storefrontUrl: string | null, values: { token: string; email: string }) => {
  const template = pattern ?? (storefrontUrl ? `${storefrontUrl.replace(/\/+$/, "")}/account/reset-password?token={token}` : null);
  return template ? safeUrl(template.replaceAll("{token}", encodeURIComponent(values.token)).replaceAll("{email}", encodeURIComponent(values.email))) : null;
};

// ---------------------------------------------------------------- sending

type Outgoing = { template: TemplateName; to: string; render: () => Rendered; order?: { id: string; number: string } | null };

const RESET_TEMPLATES = new Set<TemplateName>(["customer_password_reset", "staff_password_reset"]);
const REDACTED_BODY = "Password reset email body not stored.";

/** Reset links are bearer credentials, so their rendered bodies must never enter the email log. */
const bodyForLog = (template: TemplateName, rendered: Rendered): Rendered =>
  RESET_TEMPLATES.has(template) ? { subject: rendered.subject, html: `<p>${REDACTED_BODY}</p>`, text: REDACTED_BODY } : rendered;

/** The log transport sends nothing and the log omits reset links, so print them in development. */
const printResetLink = (ctx: EmailContext, template: TemplateName, to: string, url: string) => {
  if (ctx.settings.transport === "log" && !ctx.production) ctx.logger.info({ template, to, url }, "password reset link (log transport; printed outside production only)");
};

/** Records every outcome, sent, logged or failed; never throws for a failed send. */
export const sendEmail = async (ctx: EmailContext, email: Outgoing & { idempotencyKey?: string }): Promise<EmailMessage> => {
  const rendered = email.render();
  const provider = ctx.settings.transport;
  const record = { template: email.template, to: email.to, ...bodyForLog(email.template, rendered), provider, orderId: email.order?.id ?? null, orderNumber: email.order?.number ?? null };
  try {
    const result = await transmit(ctx, { ...rendered, from: value(ctx.settings.from) ?? "", replyTo: value(ctx.settings.replyTo), to: email.to, template: email.template, idempotencyKey: email.idempotencyKey });
    return await recordMessage(ctx.db, { ...record, status: provider === "log" ? "logged" : "sent", providerMessageId: result.messageId });
  } catch (error) {
    const message = error instanceof TransportError ? error.message : `Sending failed: ${error instanceof Error ? error.message : String(error)}`;
    ctx.logger.error({ err: error, template: email.template, to: email.to }, `email not sent: ${message}`);
    return recordMessage(ctx.db, { ...record, status: "failed", error: message });
  }
};

/**
 * Handlers get 30 s and a request up to 10 s. No send starts after this, so none still holds its
 * `once` claim when the event is retried.
 */
const SEND_BUDGET_MS = 15_000;

/**
 * Sends each email once per event and recipient (`ctx.once`), so a redelivered event sends only
 * what is missing. Failures are thrown together so the runtime retries the event.
 */
const deliver = async (ctx: EmailContext, event: PluginEvent, emails: Outgoing[]) => {
  const failed: string[] = [];
  const started = Date.now();
  for (const email of emails) {
    if (Date.now() - started > SEND_BUDGET_MS) {
      failed.push(`${email.template} to ${email.to}: not attempted in time`);
      continue;
    }
    const key = `${event.id}:${email.template}:${email.to.toLowerCase()}`;
    try {
      await ctx.once(key, async () => {
        const message = await sendEmail(ctx, { ...email, idempotencyKey: key });
        if (message.status === "failed") throw new TransportError(message.error ?? "Sending failed");
      });
    } catch (error) {
      failed.push(`${email.template} to ${email.to}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed.length) throw new Error(`Email not sent: ${failed.join("; ")}`);
};

// ---------------------------------------------------------------- event handlers

const text = (input: unknown) => (typeof input === "string" && input.trim() ? input.trim() : null);

const loadOrder = async (ctx: EmailContext, event: PluginEvent) => {
  const order = await ctx.services.orders.get(event.aggregateId);
  if (!order) {
    ctx.logger.warn({ orderId: event.aggregateId, event: event.type }, "order not found, no email sent");
    return null;
  }
  const channel = await ctx.services.channels.get(order.channelId);
  return { order, channel, brand: brandFor(ctx, channel), ref: { id: order.id, number: order.number } };
};

export const onOrderPlaced = async (event: PluginEvent, ctx: EmailContext) => {
  const data = await loadOrder(ctx, event);
  if (!data) return;
  const { order, channel, brand, ref } = data;
  // A declined card cancels the order as it is placed, and the customer saw that at checkout.
  if (order.status === "canceled") return;
  await deliver(ctx, event, [
    { template: "order_confirmation", to: order.email, order: ref, render: () => templates.orderConfirmation({ order, brand }) },
    ...parseAddresses(ctx.settings.staffOrderNotifications).map((to) => ({
      template: "staff_new_order" as const,
      to,
      order: ref,
      render: () => templates.staffNewOrder({ order, brand, locale: STAFF_LOCALE, channelName: channel?.name ?? order.channelId, adminUrl: adminOrderUrl(ctx, order) }),
    })),
  ]);
};

export const onOrderFulfilled = async (event: PluginEvent, ctx: EmailContext) => {
  const data = await loadOrder(ctx, event);
  if (!data) return;
  const { order, brand, ref } = data;
  const number = text(event.payload.fulfillmentNumber);
  const shipment = (number ? order.fulfillments.find((f) => f.number === number) : null) ?? order.fulfillments.at(-1);
  if (!shipment) return;
  // The status as of this shipment: a later one must not make this email say "everything".
  const complete = (text(event.payload.fulfillmentStatus) ?? order.fulfillmentStatus) === "fulfilled";
  await deliver(ctx, event, [{ template: "order_shipped", to: order.email, order: ref, render: () => templates.orderShipped({ order, shipment, complete, brand }) }]);
};

export const onOrderRefunded = async (event: PluginEvent, ctx: EmailContext) => {
  const data = await loadOrder(ctx, event);
  if (!data) return;
  const { order, brand, ref } = data;
  const amount = typeof event.payload.amount === "number" ? event.payload.amount : null;
  const refundNumber = text(event.payload.refundNumber);
  await deliver(ctx, event, [{ template: "order_refunded", to: order.email, order: ref, render: () => templates.orderRefunded({ order, amount, refundNumber, brand }) }]);
};

export const onOrderCanceled = async (event: PluginEvent, ctx: EmailContext) => {
  const data = await loadOrder(ctx, event);
  if (!data) return;
  const { order, brand, ref } = data;
  const declined = event.payload.reason === "payment_declined";
  // A card declined at checkout cancels an unconfirmed order; email only if a confirmation went out.
  if (declined && !(await wasDelivered(ctx.db, order.id, "order_confirmation"))) return;
  await deliver(ctx, event, [{ template: "order_canceled", to: order.email, order: ref, render: () => templates.orderCanceled({ order, declined, brand }) }]);
};

export const onCustomerPasswordReset = async (event: PluginEvent, ctx: EmailContext) => {
  const email = text(event.payload.email);
  const token = text(event.payload.token);
  if (!email || !token) return;
  const channelId = text(event.payload.channelId);
  const [customer, channel] = await Promise.all([ctx.services.customers.get(event.aggregateId), channelId ? ctx.services.channels.get(channelId) : defaultChannel(ctx)]);
  const url = customerResetUrl(value(ctx.settings.customerResetUrl), channel?.storefrontUrl ?? null, { token, email });
  if (!url) {
    ctx.logger.warn({ customerId: event.aggregateId }, "customer password reset email skipped: no storefront URL. Set the customer password reset link, or add a storefront in Settings › Storefronts.");
    return;
  }
  const locale = customer?.locale ?? channel?.defaultLocale ?? "en";
  printResetLink(ctx, "customer_password_reset", email, url);
  await deliver(ctx, event, [
    { template: "customer_password_reset", to: email, render: () => templates.customerPasswordReset({ name: customer?.firstName ?? null, url, brand: brandFor(ctx, channel), locale }) },
  ]);
};

export const onStaffPasswordReset = async (event: PluginEvent, ctx: EmailContext) => {
  const email = text(event.payload.email);
  const url = safeUrl(text(event.payload.url));
  if (!email || !url) return;
  const brand = brandFor(ctx, await defaultChannel(ctx));
  printResetLink(ctx, "staff_password_reset", email, url);
  await deliver(ctx, event, [{ template: "staff_password_reset", to: email, render: () => templates.staffPasswordReset({ name: text(event.payload.name), url, brand, locale: STAFF_LOCALE }) }]);
};

/**
 * The event carries only the location, so the level is read from the inventory tables (internal,
 * not part of the plugin API). One alert per dip: the first event at or below the threshold
 * claims a flag (its retries keep it), and a level back above the threshold clears it.
 */
export const onInventoryLevelChanged = async (event: PluginEvent, ctx: EmailContext) => {
  const threshold = ctx.settings.lowStockThreshold;
  const recipients = parseAddresses(ctx.settings.lowStockRecipients);
  const locationId = text(event.payload.locationId);
  if (threshold == null || recipients.length === 0 || !locationId) return;
  const level = await stockLevel(ctx, event.aggregateId, locationId);
  if (!level?.trackInventory) return;
  const flag = `low-stock:${event.aggregateId}:${locationId}`;
  if (level.quantity > threshold) {
    await ctx.kv.delete(flag);
    return;
  }
  if (!(await ctx.kv.add(flag, event.id)) && (await ctx.kv.get(flag)) !== event.id) return;
  const brand = brandFor(ctx, await defaultChannel(ctx));
  const item = { sku: level.sku, name: level.name, quantity: level.quantity, location: level.location };
  await deliver(
    ctx,
    event,
    recipients.map((to) => ({ template: "low_stock" as const, to, render: () => templates.lowStock({ item, threshold, adminUrl: inventoryUrl(ctx, level.sku), brand, locale: STAFF_LOCALE }) })),
  );
};

const stockLevel = async (ctx: EmailContext, variantId: string, locationId: string) => {
  const result = (await ctx.db.execute(sql`
    select v.sku, v.track_inventory as "trackInventory", l.quantity, sl.name as location,
      coalesce((select t.name from product_translations t where t.product_id = v.product_id order by (t.locale like 'en%') desc, t.locale limit 1), v.sku) as name
    from stock_levels l
    join product_variants v on v.id = l.variant_id
    join stock_locations sl on sl.id = l.location_id
    where l.variant_id = ${variantId} and l.location_id = ${locationId}`)) as unknown as {
    rows: { sku: string; trackInventory: boolean; quantity: number; location: string; name: string }[];
  };
  return result.rows[0] ?? null;
};

// ---------------------------------------------------------------- admin: previews and test sends

/** Renders from a real order, or sample data if none. Nothing is sent or recorded. */
export const previewEmail = async (ctx: EmailContext, input: { template: TemplateName; order: PluginOrder | null; locale: string | null; channelId: string | null }): Promise<Rendered> => {
  const channelId = input.order?.channelId || input.channelId;
  const channel = channelId ? await ctx.services.channels.get(channelId) : null;
  const locale = input.locale ?? input.order?.locale ?? channel?.defaultLocale ?? "en";
  const order = input.order ?? templates.sampleOrder(locale);
  const brand = brandFor(ctx, channel);
  const name = order.billingAddress?.firstName ?? null;
  switch (input.template) {
    case "order_confirmation":
      return templates.orderConfirmation({ order, brand, locale });
    case "order_shipped": {
      const shipment = order.fulfillments.at(-1) ?? { number: "", tracking: [], lines: order.lines.filter((l) => l.isShippable).map((l) => ({ orderLineId: l.id, quantity: l.quantity })) };
      return templates.orderShipped({ order, shipment, complete: true, brand, locale });
    }
    case "order_refunded":
      return templates.orderRefunded({ order, amount: order.grandTotal, refundNumber: null, brand, locale });
    case "order_canceled":
      return templates.orderCanceled({ order, declined: false, brand, locale });
    case "customer_password_reset": {
      const sample = { token: "pr_preview", email: order.email };
      const url = customerResetUrl(value(ctx.settings.customerResetUrl), brand.storefrontUrl, sample) ?? customerResetUrl(null, "https://shop.example.com", sample)!;
      return templates.customerPasswordReset({ name, url, brand, locale });
    }
    case "staff_password_reset":
      return templates.staffPasswordReset({ name, url: `${ctx.urls.admin}/reset-password?token=pr_preview`, brand, locale });
    case "staff_new_order":
      return templates.staffNewOrder({ order, brand, locale, channelName: channel?.name ?? brand.storeName, adminUrl: adminOrderUrl(ctx, order) });
    case "low_stock":
      return templates.lowStock({ item: templates.SAMPLE_LOW_STOCK, threshold: ctx.settings.lowStockThreshold ?? 5, adminUrl: inventoryUrl(ctx, templates.SAMPLE_LOW_STOCK.sku), brand, locale });
    case "test":
      return templates.testEmail({ provider: PROVIDER_NAMES[ctx.settings.transport], brand, locale });
  }
};

/** Recorded like any other email; a failure comes back as a FAILED message. */
export const sendTestEmail = async (ctx: EmailContext, to: string, channelId: string | null) => {
  const brand = brandFor(ctx, channelId ? await ctx.services.channels.get(channelId) : null);
  return sendEmail(ctx, { template: "test", to, render: () => templates.testEmail({ provider: PROVIDER_NAMES[ctx.settings.transport], brand, locale: STAFF_LOCALE }) });
};
