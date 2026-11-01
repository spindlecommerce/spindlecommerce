import { toGlobalId } from "../../lib/ids.ts";
import { listAuditLog, type AuditEntry } from "../../modules/audit/service.ts";
import { listApiKeys } from "../../modules/auth/service.ts";
import { getStaffUser } from "../../modules/staff/service.ts";
import { ADMIN, builder, connectionComplexity, rawId } from "../builder.ts";
import { keysetConnection } from "../pagination.ts";
import { ApiKeyRef, StaffUserRef } from "../refs.ts";

const AuditActorType = builder.enumType("AuditActorType", {
  subGraphs: ADMIN,
  values: { STAFF: { value: "staff" }, API_KEY: { value: "api_key" }, ANONYMOUS: { value: "anonymous", description: "A sign-in attempt that did not reach an account." } } as const,
});
const AuditOutcome = builder.enumType("AuditOutcome", { subGraphs: ADMIN, values: { SUCCESS: { value: "success" }, ERROR: { value: "error" } } as const });

const AuditEntryRef = builder.objectRef<AuditEntry>("AuditEntry").implement({
  subGraphs: ADMIN,
  description: "One admin mutation or sign-in attempt: who, what, on which object, and how it ended.",
  fields: (t) => ({
    id: t.exposeID("id"),
    createdAt: t.field({ type: "DateTime", resolve: (e) => e.createdAt }),
    actorType: t.field({ type: AuditActorType, resolve: (e) => e.actorType }),
    actorLabel: t.exposeString("actorLabel", { nullable: true, description: "Email or key name at the time, kept even if the actor is deleted." }),
    staffUser: t.field({ type: StaffUserRef, nullable: true, resolve: async (e, _a, ctx) => (e.actorType === "staff" && e.actorId ? ((await getStaffUser(ctx.db, e.actorId)) ?? null) : null) }),
    apiKey: t.field({ type: ApiKeyRef, nullable: true, resolve: async (e, _a, ctx) => (e.actorType === "api_key" && e.actorId ? ((await listApiKeys(ctx.db)).find((k) => k.id === e.actorId) ?? null) : null) }),
    operation: t.exposeString("operation", { description: "Mutation name, e.g. productUpdate." }),
    operationName: t.exposeString("operationName", { nullable: true }),
    targetType: t.exposeString("targetType", { nullable: true }),
    targetId: t.id({ nullable: true, description: "Global id of the affected object.", resolve: (e) => (e.targetType && e.targetId ? toGlobalId(e.targetType, e.targetId) : null) }),
    outcome: t.field({ type: AuditOutcome, resolve: (e) => e.outcome }),
    errorCode: t.exposeString("errorCode", { nullable: true }),
    input: t.field({ type: "JSON", description: "Arguments as sent, with secrets redacted.", resolve: (e) => e.input }),
    ip: t.exposeString("ip", { nullable: true }),
    userAgent: t.exposeString("userAgent", { nullable: true }),
  }),
});

const AuditLogFilter = builder.inputType("AuditLogFilter", {
  subGraphs: ADMIN,
  fields: (t) => ({
    search: t.string({ description: "Part of the operation name (e.g. refund) or of the actor's email or key name." }),
    actorId: t.id({ description: "A StaffUser or ApiKey id." }),
    targetId: t.id({ description: "Global id of an affected object." }),
    operation: t.string(),
    outcome: t.field({ type: AuditOutcome }),
    since: t.field({ type: "DateTime" }),
    until: t.field({ type: "DateTime" }),
  }),
});

builder.queryFields((t) => ({
  auditLog: t.connection({
    type: AuditEntryRef,
    subGraphs: ADMIN,
    description: "Admin activity, newest first.",
    authScopes: { permission: "staff:read" },
    args: { filter: t.arg({ type: AuditLogFilter }) },
    complexity: connectionComplexity,
    resolve: (_r, { filter, ...args }, ctx) =>
      keysetConnection(args, (page) =>
        listAuditLog(
          ctx.db,
          {
            search: filter?.search,
            actorId: filter?.actorId ? rawId(String(filter.actorId)) : null,
            targetId: filter?.targetId ? rawId(String(filter.targetId)) : null,
            operation: filter?.operation,
            outcome: filter?.outcome,
            since: filter?.since,
            until: filter?.until,
          },
          page,
        ),
      ),
  }),
}));
