import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "../../db/columns.ts";

/** A plugin in ecom.config.ts without a row is enabled with default settings. */
export const pluginSettings = pgTable("plugin_settings", {
  plugin: text("plugin").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  /** Non-secret setting values by key. */
  values: jsonb("values").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Secret setting values as one sealed JSON object (AES-256-GCM, key derived from JWT_SECRET). */
  secrets: text("secrets"),
  updatedBy: uuid("updated_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** PluginContext.kv */
export const pluginKv = pgTable(
  "plugin_kv",
  {
    plugin: text("plugin").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.plugin, t.key] }), index("plugin_kv_expires_idx").on(t.expiresAt)],
);

export type PluginDeliveryStatus = "pending" | "succeeded" | "failed" | "dead";

/** One row per event and matching plugin handler. */
export const pluginEventDeliveries = pgTable(
  "plugin_event_deliveries",
  {
    id: id(),
    plugin: text("plugin").notNull(),
    /** The `events` key that matched, e.g. `order.*`. */
    handler: text("handler").notNull(),
    eventId: uuid("event_id").notNull(),
    status: text("status").$type<PluginDeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("plugin_event_deliveries_uq").on(t.plugin, t.handler, t.eventId), index("plugin_event_deliveries_due_idx").on(t.status, t.nextAttemptAt)],
);

/** Doubles as the claim that stops two workers running a task at once. */
export const pluginTaskRuns = pgTable(
  "plugin_task_runs",
  {
    plugin: text("plugin").notNull(),
    task: text("task").notNull(),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
    lastStatus: text("last_status").$type<"running" | "succeeded" | "failed">(),
    lastError: text("last_error"),
  },
  (t) => [primaryKey({ columns: [t.plugin, t.task] })],
);

/** Applied PluginDefinition.migrations. */
export const pluginMigrations = pgTable(
  "plugin_migrations",
  {
    plugin: text("plugin").notNull(),
    name: text("name").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.plugin, t.name] })],
);
