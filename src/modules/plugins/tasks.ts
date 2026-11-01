import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError } from "../../lib/errors.ts";
import type { Platform } from "../../platform.ts";
import type { AnyPluginDefinition, ScheduledTask } from "../../plugins/sdk.ts";
import type { PluginRuntime } from "./types.ts";
import { purgeExpiredKeyValues } from "./kv.ts";
import { pluginTaskRuns } from "./tables.ts";
import { errorMessage, withTimeout } from "./timeout.ts";

export type PluginTaskRun = typeof pluginTaskRuns.$inferSelect;

const MAX_TASK_MS = 5 * 60_000;
/** How often each process purges expired kv entries. */
const KV_PURGE_INTERVAL_MS = 10 * 60_000;

/** At most the interval, so runs of one task never overlap. */
export const taskTimeoutMs = (task: Pick<ScheduledTask, "intervalMinutes">) => Math.min(task.intervalMinutes * 60_000, MAX_TASK_MS);

/** Succeeds only when the last run started an interval ago, so one worker runs each due task. */
const claimDueRun = async (db: Database, plugin: string, task: ScheduledTask<any>, now: Date) => {
  const threshold = new Date(now.getTime() - task.intervalMinutes * 60_000);
  const claimed = await db
    .insert(pluginTaskRuns)
    .values({ plugin, task: task.name, lastStartedAt: now, lastStatus: "running", lastError: null })
    .onConflictDoUpdate({
      target: [pluginTaskRuns.plugin, pluginTaskRuns.task],
      set: { lastStartedAt: now, lastStatus: "running", lastError: null },
      setWhere: or(isNull(pluginTaskRuns.lastStartedAt), lt(pluginTaskRuns.lastStartedAt, threshold)),
    })
    .returning();
  return claimed.length > 0;
};

const execute = async (platform: Platform, definition: AnyPluginDefinition, task: ScheduledTask<any>): Promise<PluginTaskRun> => {
  let error: string | null = null;
  try {
    await withTimeout(task.run(await platform.plugins.context(definition.name)), taskTimeoutMs(task), `The task ${task.name}`);
  } catch (e) {
    error = errorMessage(e).slice(0, 2000);
    platform.logger.warn({ err: e, plugin: definition.name, task: task.name }, "plugin task failed");
    void platform.plugins.reportError(e, { source: "plugin-task", plugin: definition.name, details: { task: task.name } });
  }
  const [row] = await platform.db
    .update(pluginTaskRuns)
    .set({ lastFinishedAt: new Date(), lastStatus: error ? "failed" : "succeeded", lastError: error })
    .where(and(eq(pluginTaskRuns.plugin, definition.name), eq(pluginTaskRuns.task, task.name)))
    .returning();
  return row!;
};

const purges = new WeakMap<PluginRuntime, number>();
/**
 * When each `<plugin>/<task>` is next due, as this process last saw: a lower bound, since other
 * workers only push it later. Spares the database a query per task every tick.
 */
const nextDue = new WeakMap<PluginRuntime, Map<string, number>>();

/**
 * On serverless hosts ticks come from cron and traffic, so an interval is a minimum, not a
 * schedule. Also purges expired kv entries.
 */
export const runDuePluginTasks = async (platform: Platform, options: { deadline?: number; now?: Date } = {}): Promise<{ ran: number; failed: number }> => {
  const { plugins } = platform;
  let ran = 0;
  let failed = 0;
  if (plugins.definitions.length === 0) return { ran, failed };
  if (Date.now() - (purges.get(plugins) ?? 0) > KV_PURGE_INTERVAL_MS) {
    purges.set(plugins, Date.now());
    await purgeExpiredKeyValues(platform.db).catch((error: unknown) => platform.logger.error({ err: error }, "purging expired plugin kv entries failed"));
  }
  let due = nextDue.get(plugins);
  if (!due) nextDue.set(plugins, (due = new Map()));
  for (const definition of plugins.definitions) {
    if (!definition.tasks?.length || !(await plugins.isActive(definition.name))) continue;
    for (const task of definition.tasks) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) return { ran, failed };
      const key = `${definition.name}/${task.name}`;
      const now = options.now ?? new Date();
      if (now.getTime() < (due.get(key) ?? 0)) continue;
      if (!(await claimDueRun(platform.db, definition.name, task, now))) {
        const [last] = await platform.db
          .select({ startedAt: pluginTaskRuns.lastStartedAt })
          .from(pluginTaskRuns)
          .where(and(eq(pluginTaskRuns.plugin, definition.name), eq(pluginTaskRuns.task, task.name)));
        due.set(key, (last?.startedAt?.getTime() ?? 0) + task.intervalMinutes * 60_000);
        continue;
      }
      due.set(key, now.getTime() + task.intervalMinutes * 60_000);
      const run = await execute(platform, definition, task);
      ran++;
      if (run.lastStatus === "failed") failed++;
    }
  }
  return { ran, failed };
};

export const listPluginTaskRuns = (db: Database, plugin: string) => db.select().from(pluginTaskRuns).where(eq(pluginTaskRuns.plugin, plugin));

/** Staff's "Run now": ignores the interval, but not a run still in progress anywhere. */
export const runPluginTaskNow = async (platform: Platform, name: string, taskName: string): Promise<PluginTaskRun> => {
  const definition = platform.plugins.get(name);
  const task = definition?.tasks?.find((t) => t.name === taskName);
  if (!definition || !task) throw new NotFoundError("PluginTask", `${name}/${taskName}`);
  if (!(await platform.plugins.isActive(name))) throw new InvalidStateError(`The plugin ${name} is not active`);
  const now = new Date();
  const busySince = new Date(now.getTime() - taskTimeoutMs(task));
  const [claimed] = await platform.db
    .insert(pluginTaskRuns)
    .values({ plugin: name, task: task.name, lastStartedAt: now, lastStatus: "running", lastError: null })
    .onConflictDoUpdate({
      target: [pluginTaskRuns.plugin, pluginTaskRuns.task],
      set: { lastStartedAt: now, lastStatus: "running", lastError: null },
      // A run still within its time limit holds the task.
      setWhere: or(isNull(pluginTaskRuns.lastStatus), ne(pluginTaskRuns.lastStatus, "running"), lt(pluginTaskRuns.lastStartedAt, busySince)),
    })
    .returning();
  if (!claimed) throw new InvalidStateError(`The task ${task.name} is running`);
  return execute(platform, definition, task);
};
