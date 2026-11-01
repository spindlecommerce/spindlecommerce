import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import type { PluginContext } from "../../src/plugins/sdk.ts";

type Database = PluginContext["db"];

export type EmailStatus = "sent" | "failed" | "logged";

/** The email log (migrations/0001_email_messages.sql). */
export const emailMessages = pgTable("plugin_email_messages", {
  // Time-ordered, so the log pages newest first on the primary key.
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  template: text("template").notNull(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  status: text("status").$type<EmailStatus>().notNull(),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  html: text("html").notNull(),
  text: text("text").notNull(),
  orderId: uuid("order_id"),
  orderNumber: text("order_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EmailMessage = typeof emailMessages.$inferSelect;
/** A row without its bodies, as lists load it. */
export type EmailMessageSummary = Omit<EmailMessage, "html" | "text"> & { html?: string; text?: string };

export const recordMessage = async (db: Database, message: typeof emailMessages.$inferInsert) => (await db.insert(emailMessages).values(message).returning())[0]!;

export const getMessage = async (db: Database, id: string) => (await db.select().from(emailMessages).where(eq(emailMessages.id, id)))[0] ?? null;

export type MessageFilter = { query?: string | null; status?: EmailStatus | null; template?: string | null; orderId?: string | null };

const summary = {
  id: emailMessages.id,
  template: emailMessages.template,
  to: emailMessages.to,
  subject: emailMessages.subject,
  status: emailMessages.status,
  provider: emailMessages.provider,
  providerMessageId: emailMessages.providerMessageId,
  error: emailMessages.error,
  orderId: emailMessages.orderId,
  orderNumber: emailMessages.orderNumber,
  createdAt: emailMessages.createdAt,
};

/** Newest first, keyset-paginated on id; `query` matches recipient, subject or order number. */
export const listMessages = async (db: Database, filter: MessageFilter, page: { limit: number; afterId?: string | null }) => {
  const conditions: SQL[] = [];
  if (filter.query?.trim()) {
    const pattern = `%${filter.query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(emailMessages.to, pattern), ilike(emailMessages.subject, pattern), ilike(emailMessages.orderNumber, pattern))!);
  }
  if (filter.status) conditions.push(eq(emailMessages.status, filter.status));
  if (filter.template) conditions.push(eq(emailMessages.template, filter.template));
  if (filter.orderId) conditions.push(eq(emailMessages.orderId, filter.orderId));
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, [count]] = await Promise.all([
    db
      .select(summary)
      .from(emailMessages)
      .where(page.afterId ? and(where, lt(emailMessages.id, page.afterId)) : where)
      .orderBy(desc(emailMessages.id))
      .limit(page.limit),
    db.select({ total: sql<number>`count(*)::int` }).from(emailMessages).where(where),
  ]);
  return { rows: rows as EmailMessageSummary[], total: count?.total ?? 0 };
};

/** Whether an order already got a template (sent, or recorded by the log transport). */
export const wasDelivered = async (db: Database, orderId: string, template: string) =>
  (
    await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.orderId, orderId), eq(emailMessages.template, template), inArray(emailMessages.status, ["sent", "logged"])))
      .limit(1)
  ).length > 0;

export const pruneMessages = async (db: Database, days: number) =>
  (await db.delete(emailMessages).where(lt(emailMessages.createdAt, new Date(Date.now() - days * 86_400_000))).returning({ id: emailMessages.id })).length;
