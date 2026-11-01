import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
/** A database or a transaction; services accept either so callers decide the transaction boundary. */
export type Database = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export type DatabaseHandle = {
  db: Database;
  kind: "pglite" | "postgres";
  migrate: () => Promise<void>;
  close: () => Promise<void>;
  /** PostgreSQL only, for hosts that manage its connections (Vercel's attachDatabasePool). */
  pool?: pg.Pool;
};

/** Unset keeps pg's default, except the pool size: DATABASE_POOL_SIZE or 10. */
export type PoolOptions = { max?: number; idleTimeoutMs?: number; connectionTimeoutMs?: number };

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * The URL selects the driver:
 * - undefined or `memory:` → in-memory PGlite (tests, quick starts)
 * - `pglite:<dir>` → PGlite persisted in a directory (local development)
 * - `postgres://…` → node-postgres pool (production)
 *
 * No default from DATABASE_URL: it would also replace an explicit `undefined`, pointing tests at the
 * real database.
 */
export const createDatabase = async (url: string | undefined, pool: PoolOptions = {}): Promise<DatabaseHandle> => {
  if (!url || url === "memory:" || url.startsWith("pglite:")) {
    // Loaded on demand, so the Vercel bundle can leave PGlite out.
    const [{ PGlite }, { drizzle: drizzlePglite }, { migrate: migratePglite }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("drizzle-orm/pglite"),
      import("drizzle-orm/pglite/migrator"),
    ]);
    const dataDir = url?.startsWith("pglite:") ? url.slice("pglite:".length) : undefined;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const client = new PGlite(dataDir);
    await client.waitReady;
    const db = drizzlePglite(client, { schema });
    return {
      db: db as unknown as Database,
      kind: "pglite",
      migrate: () => migratePglite(db, { migrationsFolder }),
      close: () => client.close(),
    };
  }
  const connections = new pg.Pool({
    connectionString: url,
    max: pool.max ?? Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: pool.idleTimeoutMs,
    connectionTimeoutMillis: pool.connectionTimeoutMs,
  });
  const db = drizzlePg(connections, { schema });
  return {
    db: db as unknown as Database,
    kind: "postgres",
    migrate: () => migratePg(db, { migrationsFolder }),
    close: () => connections.end(),
    pool: connections,
  };
};
