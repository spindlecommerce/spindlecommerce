import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "../../db/columns.ts";

export type AuditActorType = "staff" | "api_key" | "anonymous";

/** One row per admin mutation and sign-in attempt. UUIDv7 ids, so id order is time order. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    actorId: uuid("actor_id"),
    /** Email or key name when the entry was written; survives the actor's deletion. */
    actorLabel: text("actor_label"),
    /** Mutation field, e.g. `productUpdate`. */
    operation: text("operation").notNull(),
    /** The client's GraphQL operation name, if any. */
    operationName: text("operation_name"),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    outcome: text("outcome").$type<"success" | "error">().notNull(),
    errorCode: text("error_code"),
    /** Arguments with secrets redacted and large values truncated. */
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_actor_idx").on(t.actorId, t.id), index("audit_log_target_idx").on(t.targetId, t.id), index("audit_log_operation_idx").on(t.operation, t.id)],
);
