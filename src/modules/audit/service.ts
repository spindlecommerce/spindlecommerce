import { and, desc, eq, gte, ilike, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { auditLog, type AuditActorType } from "./tables.ts";

export type AuditEntry = typeof auditLog.$inferSelect;

const SECRET_KEY = /pass(word)?$|secret|token/i;
const MAX_INPUT_CHARS = 16_384;

/**
 * Replace secret values with a marker, keeping the shape. `extraKeys` names further secrets for
 * one operation, e.g. a one-time `code`.
 */
export const redact = (value: unknown, extraKeys: ReadonlySet<string> = new Set(), depth = 0): unknown => {
  if (depth > 8) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, extraKeys, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, (SECRET_KEY.test(k) || extraKeys.has(k)) && v != null ? "[redacted]" : redact(v, extraKeys, depth + 1)]),
    );
  }
  return value;
};

const boundedInput = (input: Record<string, unknown>, extraKeys?: ReadonlySet<string>): Record<string, unknown> => {
  const redacted = redact(input, extraKeys) as Record<string, unknown>;
  const json = JSON.stringify(redacted);
  return json.length <= MAX_INPUT_CHARS ? redacted : { truncated: true, size: json.length, keys: Object.keys(redacted) };
};

export type AuditRecord = {
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  operation: string;
  operationName?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  outcome: "success" | "error";
  errorCode?: string | null;
  input?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export const recordAudit = async (db: Database, entry: AuditRecord, secretKeys?: ReadonlySet<string>) => {
  await db.insert(auditLog).values({ ...entry, input: boundedInput(entry.input ?? {}, secretKeys), userAgent: entry.userAgent?.slice(0, 400) ?? null });
};

export type AuditFilter = {
  /** Part of the operation name or of the actor's email or key name. */
  search?: string | null;
  actorId?: string | null;
  targetId?: string | null;
  operation?: string | null;
  outcome?: "success" | "error" | null;
  since?: Date | null;
  until?: Date | null;
};

/** Newest first, keyset-paginated on the time-ordered id. */
export const listAuditLog = async (db: Database, filter: AuditFilter, page: { limit: number; afterId?: string | null }) => {
  const conditions: SQL[] = [];
  if (filter.search?.trim()) {
    const pattern = `%${filter.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(auditLog.operation, pattern), ilike(auditLog.actorLabel, pattern))!);
  }
  if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
  if (filter.targetId) conditions.push(eq(auditLog.targetId, filter.targetId));
  if (filter.operation) conditions.push(eq(auditLog.operation, filter.operation));
  if (filter.outcome) conditions.push(eq(auditLog.outcome, filter.outcome));
  if (filter.since) conditions.push(gte(auditLog.createdAt, filter.since));
  if (filter.until) conditions.push(lte(auditLog.createdAt, filter.until));
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(auditLog)
    .where(page.afterId ? and(where, lt(auditLog.id, page.afterId)) : where)
    .orderBy(desc(auditLog.id))
    .limit(page.limit);
  const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where)) as [{ total: number }];
  return { rows, total };
};
