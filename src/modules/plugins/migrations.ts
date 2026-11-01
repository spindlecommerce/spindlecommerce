import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../db/client.ts";
import type { AnyPluginDefinition } from "../../plugins/sdk.ts";
import { pluginMigrations } from "./tables.ts";

const BREAKPOINT = "--> statement-breakpoint";

const onlyComments = (statement: string) => statement.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").trim() === "";

/**
 * PGlite runs one statement per query. Splits at drizzle-kit's breakpoints when present, else at
 * semicolons outside quotes, dollar-quoted bodies and comments.
 */
export const splitSqlStatements = (source: string): string[] => {
  if (source.includes(BREAKPOINT)) return source.split(BREAKPOINT).map((s) => s.trim()).filter((s) => s && !onlyComments(s));
  const statements: string[] = [];
  /** Just past the next `needle` from `from`, or the end. */
  const after = (needle: string, from: number) => {
    const at = source.indexOf(needle, from);
    return at === -1 ? source.length : at + needle.length;
  };
  let start = 0;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const tag = c === "$" ? /^\$[A-Za-z_]*\$/.exec(source.slice(i, i + 64))?.[0] : undefined;
    if (c === "'" || c === '"') i = after(c, i + 1);
    else if (c === "-" && source[i + 1] === "-") i = after("\n", i);
    else if (c === "/" && source[i + 1] === "*") i = after("*/", i + 2);
    else if (tag) i = after(tag, i + tag.length);
    else {
      if (c === ";") {
        statements.push(source.slice(start, i));
        start = i + 1;
      }
      i++;
    }
  }
  statements.push(source.slice(start));
  return statements.map((s) => s.trim()).filter((s) => s && !onlyComments(s));
};

/**
 * Run after the platform's own migrations. Each file's transaction first records it, so a second
 * process migrating at once waits on that row, then skips the file.
 */
export const applyPluginMigrations = async (db: Database, definitions: readonly AnyPluginDefinition[], logger?: Pick<Logger, "info">): Promise<string[]> => {
  const applied: string[] = [];
  for (const definition of definitions) {
    if (!definition.migrations) continue;
    const dir = fileURLToPath(definition.migrations);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    } catch (error) {
      throw new Error(`Plugin ${definition.name}: cannot read its migrations at ${dir}: ${(error as Error).message}`, { cause: error });
    }
    const done = new Set((await db.select({ name: pluginMigrations.name }).from(pluginMigrations).where(eq(pluginMigrations.plugin, definition.name))).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const statements = splitSqlStatements(await readFile(join(dir, file), "utf8"));
      try {
        const ran = await db.transaction(async (tx) => {
          const claimed = await tx.insert(pluginMigrations).values({ plugin: definition.name, name: file }).onConflictDoNothing().returning();
          if (claimed.length === 0) return false;
          for (const statement of statements) await tx.execute(sql.raw(statement));
          return true;
        });
        if (!ran) continue;
      } catch (error) {
        throw new Error(`Plugin ${definition.name}: migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(`${definition.name}/${file}`);
      logger?.info(`Applied plugin migration ${definition.name}/${file}`);
    }
  }
  return applied;
};
