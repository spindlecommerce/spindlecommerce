import { and, asc, eq, gt, isNull, like, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import type { PluginKeyValueStore } from "../../plugins/sdk.ts";
import { pluginKv } from "./tables.ts";

const MAX_KEY = 512;

const checkKey = (key: string) => {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY) throw new TypeError(`kv keys are strings of 1–${MAX_KEY} characters`);
};

const checkValue = (value: unknown) => {
  // A JSON null would read back as "absent" (get returns null for both).
  if (value === undefined || value === null) throw new TypeError("kv values cannot be null or undefined; use kv.delete");
};

const expiry = (ttlSeconds: number | undefined) => (ttlSeconds === undefined ? null : new Date(Date.now() + Math.max(1, ttlSeconds) * 1000));

/** Expired rows are ignored on read; the worker deletes them later. */
const live = () => or(isNull(pluginKv.expiresAt), gt(pluginKv.expiresAt, new Date()));

/** PluginContext.kv, namespaced by plugin. */
export const createKeyValueStore = (db: Database, plugin: string): PluginKeyValueStore => ({
  get: async <T>(key: string) => {
    checkKey(key);
    const [row] = await db
      .select({ value: pluginKv.value })
      .from(pluginKv)
      .where(and(eq(pluginKv.plugin, plugin), eq(pluginKv.key, key), live()))
      .limit(1);
    return (row?.value ?? null) as T | null;
  },
  set: async (key, value, options) => {
    checkKey(key);
    checkValue(value);
    const expiresAt = expiry(options?.ttlSeconds);
    await db
      .insert(pluginKv)
      .values({ plugin, key, value, expiresAt })
      .onConflictDoUpdate({ target: [pluginKv.plugin, pluginKv.key], set: { value, expiresAt, updatedAt: new Date() } });
  },
  // An expired row counts as absent: it is replaced.
  add: async (key, value, options) => {
    checkKey(key);
    checkValue(value);
    const expiresAt = expiry(options?.ttlSeconds);
    const rows = await db
      .insert(pluginKv)
      .values({ plugin, key, value, expiresAt })
      .onConflictDoUpdate({
        target: [pluginKv.plugin, pluginKv.key],
        set: { value, expiresAt, updatedAt: new Date() },
        setWhere: and(sql`${pluginKv.expiresAt} is not null`, lte(pluginKv.expiresAt, new Date())),
      })
      .returning({ key: pluginKv.key });
    return rows.length > 0;
  },
  delete: async (key) => {
    checkKey(key);
    await db.delete(pluginKv).where(and(eq(pluginKv.plugin, plugin), eq(pluginKv.key, key)));
  },
  list: async <T>(prefix: string, options?: { limit?: number }) => {
    const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db
      .select({ key: pluginKv.key, value: pluginKv.value })
      .from(pluginKv)
      .where(and(eq(pluginKv.plugin, plugin), like(pluginKv.key, pattern), live()))
      .orderBy(asc(pluginKv.key))
      .limit(Math.min(Math.max(options?.limit ?? 100, 1), 1000));
    return rows as { key: string; value: T }[];
  },
});

/** A process that dies mid-run frees the `once` key after this. */
export const ONCE_LEASE_SECONDS = 15 * 60;

/** PluginContext.once. A throwing `fn` releases the key, so a retry runs it again. */
export const runOnce = async (kv: PluginKeyValueStore, key: string, fn: () => Promise<void>): Promise<boolean> => {
  const marker = `once:${key}`;
  if (!(await kv.add(marker, { state: "running", at: new Date().toISOString() }, { ttlSeconds: ONCE_LEASE_SECONDS }))) return false;
  try {
    await fn();
  } catch (error) {
    await kv.delete(marker);
    throw error;
  }
  await kv.set(marker, { state: "done", at: new Date().toISOString() });
  return true;
};

export const purgeExpiredKeyValues = async (db: Database) => {
  const rows = await db.delete(pluginKv).where(lte(pluginKv.expiresAt, new Date())).returning({ key: pluginKv.key });
  return rows.length;
};
