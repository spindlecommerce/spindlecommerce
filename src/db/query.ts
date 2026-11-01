import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Database } from "./client.ts";

/** Raw SQL returning typed rows; node-postgres and PGlite both answer with `{ rows }`. */
export const queryRows = async <T>(db: Database, statement: SQL): Promise<T[]> =>
  ((await db.execute(statement)) as unknown as { rows: T[] }).rows;

/** The uuid array holds `id` and nothing else, so removing `id` would empty it. */
export const holdsOnly = (column: AnyColumn, id: string) => sql`(${id}::uuid = any(${column}) and ${column} <@ array[${id}]::uuid[])`;
