import { InvalidStateError, NotFoundError, type GraphQLExtensionApi } from "../../src/plugins/sdk.ts";
import { getMessage, listMessages, type EmailMessageSummary } from "./messages.ts";
import { previewEmail, sendTestEmail } from "./service.ts";
import type { EmailSettings } from "./settings.ts";
import type { TemplateName } from "./templates.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");
const decodeCursor = (cursor: string) => {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return UUID.test(id) ? id : null;
};
const pageSize = (first: number | null | undefined) => Math.min(Math.max(first ?? 20, 1), 100);

/** Admin API: the message log, template previews and test sends. */
export const registerGraphQL = ({ builder, ADMIN, context, toGlobalId, rawId }: GraphQLExtensionApi<EmailSettings>) => {
  const read = { subGraphs: ADMIN, authScopes: { permission: "email:read" } } as const;

  const EmailMessageStatus = builder.enumType("EmailMessageStatus", {
    subGraphs: ADMIN,
    values: {
      SENT: { value: "sent", description: "Accepted by Resend or Postmark." },
      FAILED: { value: "failed", description: "Refused or unreachable; `error` says why. Event emails are retried." },
      LOGGED: { value: "logged", description: "Recorded by the log transport, not sent." },
    } as const,
  });

  const EmailTemplate = builder.enumType("EmailTemplate", {
    subGraphs: ADMIN,
    values: {
      ORDER_CONFIRMATION: { value: "order_confirmation", description: "To the customer when an order is placed (order.placed)." },
      ORDER_SHIPPED: { value: "order_shipped", description: "To the customer for each shipment, with tracking links (order.fulfilled)." },
      ORDER_REFUNDED: { value: "order_refunded", description: "To the customer for each refund (order.refunded)." },
      ORDER_CANCELED: { value: "order_canceled", description: "To the customer when an order is canceled (order.canceled)." },
      CUSTOMER_PASSWORD_RESET: { value: "customer_password_reset", description: "The reset link a customer asked for (customer.password_reset_requested)." },
      STAFF_PASSWORD_RESET: { value: "staff_password_reset", description: "The reset link a staff member asked for (staff.password_reset_requested)." },
      STAFF_NEW_ORDER: { value: "staff_new_order", description: "To the new order notification addresses (order.placed)." },
      LOW_STOCK: { value: "low_stock", description: "To the low stock recipients (inventory.level_changed)." },
      TEST: { value: "test", description: "Sent from the admin (emailSendTest)." },
    } as const,
  });

  const EmailMessageRef = builder.objectRef<EmailMessageSummary>("EmailMessage").implement({
    subGraphs: ADMIN,
    description: "An email the email plugin sent, failed to send, or only logged. Kept 30 days.",
    fields: (t) => ({
      id: t.id({ resolve: (m) => toGlobalId("EmailMessage", m.id) }),
      template: t.field({ type: EmailTemplate, resolve: (m) => m.template as TemplateName }),
      to: t.exposeString("to"),
      subject: t.exposeString("subject"),
      status: t.field({ type: EmailMessageStatus, resolve: (m) => m.status }),
      provider: t.exposeString("provider", { description: "log, resend or postmark." }),
      providerMessageId: t.exposeString("providerMessageId", { nullable: true, description: "The provider's id for the message, to look it up there." }),
      error: t.exposeString("error", { nullable: true }),
      orderId: t.id({ nullable: true, resolve: (m) => (m.orderId ? toGlobalId("Order", m.orderId) : null) }),
      orderNumber: t.exposeString("orderNumber", { nullable: true }),
      // Lists load rows without their bodies; asking for one loads it.
      html: t.string({ resolve: async (m, _a, gql) => m.html ?? (await getMessage(gql.db, m.id))?.html ?? "" }),
      text: t.string({ resolve: async (m, _a, gql) => m.text ?? (await getMessage(gql.db, m.id))?.text ?? "" }),
      createdAt: t.field({ type: "DateTime", resolve: (m) => m.createdAt }),
    }),
  });

  const EmailPreview = builder.simpleObject("EmailPreview", {
    subGraphs: ADMIN,
    description: "A rendered template: show `html` in a sandboxed iframe.",
    fields: (t) => ({ subject: t.string(), html: t.string(), text: t.string() }),
  });

  builder.queryFields((t) => ({
    emailMessages: t.connection({
      ...read,
      type: EmailMessageRef,
      description: "Emails the email plugin recorded, newest first.",
      args: {
        query: t.arg.string({ description: "Part of the recipient, subject or order number." }),
        status: t.arg({ type: EmailMessageStatus }),
        template: t.arg({ type: EmailTemplate }),
        orderId: t.arg.id({ description: "Only this order's emails." }),
      },
      complexity: (args) => ({ field: 2, multiplier: pageSize(args.first) }),
      resolve: async (_r, args, gql) => {
        const ctx = await context(gql);
        const limit = pageSize(args.first);
        const afterId = args.after ? decodeCursor(args.after) : null;
        const orderId = args.orderId ? rawId(String(args.orderId)) : null;
        const { rows, total } = await listMessages(ctx.db, { query: args.query, status: args.status, template: args.template, orderId: orderId && UUID.test(orderId) ? orderId : null }, { limit: limit + 1, afterId });
        const edges = rows.slice(0, limit).map((node) => ({ cursor: encodeCursor(node.id), node }));
        return {
          edges,
          pageInfo: { hasNextPage: rows.length > limit, hasPreviousPage: afterId !== null, startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null },
          totalCount: total,
        };
      },
    }),
    emailMessage: t.field({
      ...read,
      type: EmailMessageRef,
      nullable: true,
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_r, args, gql) => {
        const id = rawId(String(args.id));
        return UUID.test(id) ? getMessage((await context(gql)).db, id) : null;
      },
    }),
    emailPreview: t.field({
      ...read,
      type: EmailPreview,
      description: "Render a template without sending it: from an order (by id or number), or from sample data.",
      args: {
        template: t.arg({ type: EmailTemplate, required: true }),
        orderId: t.arg.id(),
        orderNumber: t.arg.string(),
        locale: t.arg({ type: "LocaleCode", description: "Defaults to the order's locale, else the channel's." }),
      },
      resolve: async (_r, args, gql) => {
        const ctx = await context(gql);
        const number = args.orderNumber?.trim();
        const order = args.orderId ? await ctx.services.orders.get(rawId(String(args.orderId))) : number ? await ctx.services.orders.getByNumber(number) : null;
        if ((args.orderId || number) && !order) throw new NotFoundError("Order", number ?? String(args.orderId));
        return previewEmail(ctx, { template: args.template, order, locale: args.locale ?? null, channelId: gql.scope.channel.id });
      },
    }),
  }));

  const EmailSendTestPayload = builder.simpleObject("EmailSendTestPayload", {
    subGraphs: ADMIN,
    fields: (t) => ({ emailMessage: t.field({ type: EmailMessageRef, description: "Its status says how it went: FAILED carries the provider's error." }) }),
  });

  builder.mutationFields((t) => ({
    emailSendTest: t.field({
      type: EmailSendTestPayload,
      subGraphs: ADMIN,
      description: "Send a short test email with the active transport (the log transport only records it).",
      authScopes: { permission: "email:send" },
      errors: { types: [InvalidStateError] },
      args: { to: t.arg({ type: "EmailAddress", required: true }) },
      resolve: async (_r, { to }, gql) => ({ emailMessage: await sendTestEmail(await context(gql), to, gql.scope.channel.id) }),
    }),
  }));
};
