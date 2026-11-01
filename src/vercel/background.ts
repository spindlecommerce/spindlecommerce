import { drainOutbox, runWorkerTick, WORKER_PATH, type WorkerRunOptions } from "../modules/integrations/worker.ts";
import type { Platform } from "../platform.ts";

/** At most one piggybacked worker tick per instance per interval. */
export const TICK_INTERVAL_MS = 60_000;
/** Background runs start no new work after this long; they share the request's 300-second limit. */
const RUN_BUDGET_MS = 120_000;

type Kind = "drain" | "tick";

export type BackgroundWork = {
  /** After each request: drain if it wrote outbox events, and tick if this instance has not lately. */
  afterRequest: (path: string, drain: boolean) => void;
  /** Resolves when the current run, if any, ends. For tests and shutdown. */
  idle: () => Promise<void>;
};

/**
 * Worker runs for hosts with no long-running process (Vercel), started by traffic and kept alive
 * with `keepAlive` (waitUntil) after the response:
 * - a drain after a request that wrote outbox events, so webhooks go out within seconds;
 * - a full tick on the first request each minute, so a Hobby project (daily cron) still publishes
 *   scheduled content.
 * Runs on one instance never overlap; a request during a run queues one more after it.
 */
export const createBackgroundWork = (
  platform: Platform,
  options: {
    keepAlive: (promise: Promise<unknown>) => void;
    tickIntervalMs?: number;
    now?: () => number;
    worker?: { tick: (options: WorkerRunOptions) => Promise<unknown>; drain: (options: WorkerRunOptions) => Promise<unknown> };
  },
): BackgroundWork => {
  const now = options.now ?? Date.now;
  const interval = options.tickIntervalMs ?? TICK_INTERVAL_MS;
  const worker = options.worker ?? { tick: (o: WorkerRunOptions) => runWorkerTick(platform, o), drain: (o: WorkerRunOptions) => drainOutbox(platform, o) };
  let lastTick = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;
  let queued: Kind | null = null;

  const run = async (first: Kind) => {
    // Yield first, so `running` is assigned before the loop can finish and clear it.
    await undefined;
    let next: Kind | null = first;
    while (next) {
      queued = null;
      try {
        const deadline = now() + RUN_BUDGET_MS;
        await (next === "tick" ? worker.tick({ deadline }) : worker.drain({ deadline }));
      } catch (error) {
        platform.logger.error({ err: error }, `background worker ${next} failed`);
        void platform.plugins.reportError(error, { source: "worker", details: { worker: `background ${next}` } });
      }
      next = queued;
    }
    // Same synchronous step as the last read of `queued`, so nothing queues onto a finished run.
    running = null;
  };

  const start = (kind: Kind) => {
    if (running) {
      queued = queued === "tick" || kind === "tick" ? "tick" : "drain";
      return running;
    }
    running = run(kind);
    return running;
  };

  return {
    afterRequest: (path, drain) => {
      // Vercel Cron's request ran a tick itself.
      if (path.endsWith(WORKER_PATH)) {
        lastTick = now();
        return;
      }
      let kind: Kind | null = drain ? "drain" : null;
      if (now() - lastTick >= interval) {
        lastTick = now();
        kind = "tick";
      }
      if (kind) options.keepAlive(start(kind));
    },
    idle: () => running ?? Promise.resolve(),
  };
};
