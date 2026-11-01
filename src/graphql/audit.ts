import type { GraphQLFieldResolver } from "graphql";
import { DomainError } from "../lib/errors.ts";
import { parseGlobalId, toGlobalId } from "../lib/ids.ts";
import { recordAudit, type AuditRecord } from "../modules/audit/service.ts";
import type { SettingsShape } from "../plugins/sdk.ts";
import type { GraphQLContext } from "./context.ts";

/** Too frequent to audit: token rotation, preferences, autosaves, previews. Publishing is audited. */
const NOT_AUDITED = new Set(["tokenRefresh", "staffPreferenceSet", "pageSaveDraft", "previewSessionCreate"]);
/** Operations whose `code` argument is a one-time secret rather than an entity code. */
const ONE_TIME_CODES = new Set(["staffLoginVerify", "staffTwoFactorEnable"]);
const SECRET_CODE = new Set(["code"]);

/** Plugin settings use keys the usual secret names miss, so redact the ones the plugin declares secret. */
const pluginSecretKeys = (ctx: GraphQLContext, args: Record<string, unknown>): ReadonlySet<string> =>
  new Set(Object.entries((ctx.platform.plugins.get(String(args.name))?.settings ?? {}) as SettingsShape).flatMap(([key, field]) => (field.type === "secret" ? [key] : [])));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Payload keys whose GraphQL type name is not just the capitalized key. */
const PAYLOAD_TYPES: Record<string, string> = { variant: "ProductVariant", address: "CustomerAddress", asset: "MediaAsset", delivery: "PluginDelivery" };
const ID_ARGS = ["id", "orderId", "productId", "variantId", "promotionId", "customerId"];

/** Arguments arrive with global ids already decoded to { typename, id }; log them as ids again. */
const encodeIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(encodeIds);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value);
    const { typename, id } = value as { typename?: unknown; id?: unknown };
    if (entries.length === 2 && typeof typename === "string" && typeof id === "string") return toGlobalId(typename, id);
    return Object.fromEntries(entries.map(([k, v]) => [k, encodeIds(v)]));
  }
  return value;
};

const targetOf = (args: Record<string, unknown>, result: unknown): { type: string; id: string } | null => {
  if (result && typeof result === "object" && !(result instanceof Error)) {
    const payload = result as Record<string, unknown>;
    if (typeof payload.deletedId === "string") {
      const parsed = parseGlobalId(payload.deletedId);
      if (parsed) return { type: parsed.type, id: parsed.id };
    }
    for (const [key, value] of Object.entries(payload)) {
      const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
      if (typeof id === "string" && UUID.test(id)) return { type: PAYLOAD_TYPES[key] ?? key.charAt(0).toUpperCase() + key.slice(1), id };
    }
  }
  for (const key of ID_ARGS) {
    const parsed = typeof args[key] === "string" ? parseGlobalId(args[key] as string) : null;
    if (parsed) return { type: parsed.type, id: parsed.id };
  }
  return null;
};

const actorOf = (ctx: GraphQLContext, operation: string, args: Record<string, unknown>, result: unknown): Pick<AuditRecord, "actorType" | "actorId" | "actorLabel"> => {
  if (ctx.staff) return { actorType: "staff", actorId: ctx.staff.id, actorLabel: ctx.staff.email };
  if (ctx.apiKey) return { actorType: "api_key", actorId: ctx.apiKey.id, actorLabel: ctx.apiKey.name };
  // Sign-in calls are anonymous until they succeed; credit them to the account they reached.
  const signedIn = result && typeof result === "object" && !(result instanceof Error) ? (result as { staffUser?: { id: string; email: string } }).staffUser : undefined;
  if (signedIn) return { actorType: "staff", actorId: signedIn.id, actorLabel: signedIn.email };
  return { actorType: "anonymous", actorId: null, actorLabel: operation === "staffLogin" && typeof args.email === "string" ? args.email : null };
};

const write = (ctx: GraphQLContext, operation: string, rawArgs: Record<string, unknown>, result: unknown, thrown: unknown) => {
  const args = encodeIds(rawArgs) as Record<string, unknown>;
  const error = thrown ?? (result instanceof Error ? result : null);
  const target = targetOf(args, result);
  return recordAudit(
    ctx.platform.db,
    {
      ...actorOf(ctx, operation, args, result),
      operation,
      operationName: ctx.request.operationName,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      outcome: error ? "error" : "success",
      errorCode: error ? (error instanceof DomainError ? error.code : "INTERNAL_SERVER_ERROR") : null,
      input: args,
      ip: ctx.request.ip,
      userAgent: ctx.request.userAgent,
    },
    ONE_TIME_CODES.has(operation) ? SECRET_CODE : operation === "pluginUpdate" ? pluginSecretKeys(ctx, rawArgs) : undefined,
  ).catch((err: unknown) => ctx.platform.logger.error({ err, operation }, "audit log write failed"));
};

/**
 * Audits admin mutations, via @pothos/plugin-tracing. It sits outside the errors plugin, so typed
 * failures arrive as returned error objects.
 */
export const auditMutation =
  (resolver: GraphQLFieldResolver<unknown, GraphQLContext, Record<string, unknown>>, fieldName: string): GraphQLFieldResolver<unknown, GraphQLContext, Record<string, unknown>> =>
  async (source, args, ctx, info) => {
    if (ctx.api !== "admin" || NOT_AUDITED.has(fieldName)) return resolver(source, args, ctx, info);
    let result: unknown;
    try {
      result = await resolver(source, args, ctx, info);
    } catch (thrown) {
      await write(ctx, fieldName, args, undefined, thrown);
      throw thrown;
    }
    await write(ctx, fieldName, args, result, null);
    return result;
  };
