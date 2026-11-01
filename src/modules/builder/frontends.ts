import { asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { parseInput, patchSchema } from "../../lib/validation.ts";
import { createWebhookSubscription, deleteWebhookSubscription, updateWebhookSubscription } from "../integrations/webhooks.ts";
import { builderFrontends } from "./tables.ts";

export type Frontend = typeof builderFrontends.$inferSelect;

export const REVALIDATE_EVENTS = ["page.*", "release.published", "product.*", "category.*", "component.updated"];

const origin = z
  .url()
  .refine((u) => /^https?:\/\//.test(u), "Use an http(s) URL")
  .transform((u) => u.replace(/\/+$/, ""));
const path = z
  .string()
  .regex(/^\/[A-Za-z0-9/_.-]*$/, "A path starting with /")
  .max(200);

const frontendSchema = z.object({
  name: z.string().min(1).max(120),
  url: origin,
  previewPath: path.default("/api/draft"),
  revalidatePath: path.nullable().optional(),
  deployHookUrl: z
    .url()
    .refine((u) => u.startsWith("https://") || process.env.NODE_ENV !== "production", "Deploy hooks must use https")
    .nullable()
    .optional(),
  defaultChannelId: z.uuid().nullable().optional(),
  isDefault: z.boolean().default(false),
});

export const listFrontends = (db: Database) => db.select().from(builderFrontends).orderBy(asc(builderFrontends.name));

export const getFrontend = async (db: Database, id: string) => {
  const frontend = await db.query.builderFrontends.findFirst({ where: eq(builderFrontends.id, id) });
  if (!frontend) throw new NotFoundError("Frontend", id);
  return frontend;
};

/** The default frontend, or the only one. */
export const defaultFrontend = async (db: Database) => {
  const all = await listFrontends(db);
  return all.find((f) => f.isDefault) ?? (all.length === 1 ? all[0]! : null);
};

/** Origins the admin may frame for previews (its CSP `frame-src`). */
export const frontendOrigins = async (db: Database) => [...new Set((await listFrontends(db)).map((f) => new URL(f.url).origin))];

const subscriptionFor = (frontend: { name: string; url: string; revalidatePath?: string | null }) => ({
  name: `Storefront revalidation: ${frontend.name}`,
  url: `${frontend.url}${frontend.revalidatePath}`,
  events: REVALIDATE_EVENTS,
});

/** A revalidate path adds a webhook subscription; its signing secret is returned only once. */
export const createFrontend = async (db: Database, input: unknown) =>
  db.transaction(async (tx) => {
    const data = parseInput(frontendSchema, input);
    let secret: string | null = null;
    let webhookSubscriptionId: string | null = null;
    if (data.revalidatePath) {
      const subscription = await createWebhookSubscription(tx, subscriptionFor(data));
      webhookSubscriptionId = subscription.id;
      secret = subscription.secret;
    }
    if (data.isDefault) await tx.update(builderFrontends).set({ isDefault: false });
    const [row] = await tx.insert(builderFrontends).values({ ...data, revalidatePath: data.revalidatePath ?? null, deployHookUrl: data.deployHookUrl ?? null, defaultChannelId: data.defaultChannelId ?? null, webhookSubscriptionId }).returning();
    return { frontend: row!, revalidateSecret: secret };
  });

export const updateFrontend = async (db: Database, id: string, input: unknown) =>
  db.transaction(async (tx) => {
    const existing = await getFrontend(tx, id);
    const data = parseInput(patchSchema(frontendSchema), input);
    const next = { ...existing, ...data };
    let secret: string | null = null;
    let webhookSubscriptionId = existing.webhookSubscriptionId;
    if (next.revalidatePath && webhookSubscriptionId) {
      await updateWebhookSubscription(tx, webhookSubscriptionId, subscriptionFor(next)).catch(async (error: unknown) => {
        if (!(error instanceof NotFoundError)) throw error;
        const subscription = await createWebhookSubscription(tx, subscriptionFor(next));
        webhookSubscriptionId = subscription.id;
        secret = subscription.secret;
      });
    } else if (next.revalidatePath) {
      const subscription = await createWebhookSubscription(tx, subscriptionFor(next));
      webhookSubscriptionId = subscription.id;
      secret = subscription.secret;
    } else if (webhookSubscriptionId) {
      await deleteWebhookSubscription(tx, webhookSubscriptionId).catch(() => undefined);
      webhookSubscriptionId = null;
    }
    if (data.isDefault) await tx.update(builderFrontends).set({ isDefault: false }).where(ne(builderFrontends.id, id));
    const [row] = await tx.update(builderFrontends).set({ ...data, webhookSubscriptionId, updatedAt: new Date() }).where(eq(builderFrontends.id, id)).returning();
    return { frontend: row!, revalidateSecret: secret };
  });

export const deleteFrontend = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const existing = await getFrontend(tx, id);
    if (existing.webhookSubscriptionId) await deleteWebhookSubscription(tx, existing.webhookSubscriptionId).catch(() => undefined);
    await tx.delete(builderFrontends).where(eq(builderFrontends.id, id));
    return id;
  });

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Trigger a static rebuild through the frontend's deploy hook. */
export const deployFrontend = async (db: Database, id: string, options: { fetch?: FetchLike; timeoutMs?: number } = {}) => {
  const frontend = await getFrontend(db, id);
  if (!frontend.deployHookUrl) throw new ValidationError("No deploy hook", [{ path: ["id"], message: "Add a deploy hook URL to this storefront first" }]);
  let status: string;
  try {
    const response = await (options.fetch ?? fetch)(frontend.deployHookUrl, { method: "POST", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), headers: { "user-agent": "spindlecommerce-deploy-hook" } });
    status = response.ok ? `Triggered (HTTP ${response.status})` : `Failed: HTTP ${response.status}`;
  } catch (error) {
    status = `Failed: ${error instanceof Error ? error.message : "request error"}`;
  }
  const [row] = await db.update(builderFrontends).set({ lastDeployAt: new Date(), lastDeployStatus: status, updatedAt: new Date() }).where(eq(builderFrontends.id, id)).returning();
  return row!;
};
