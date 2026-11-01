import pino from "pino";
import { describe, expect, it } from "vitest";
import type { Platform } from "../../src/platform.ts";
import { createBackgroundWork } from "../../src/vercel/background.ts";

const setup = (options: { fail?: boolean } = {}) => {
  let time = 1_000_000;
  const runs: string[] = [];
  const kept: Promise<unknown>[] = [];
  let release: (() => void) | null = null;
  const run = (kind: string) => async () => {
    runs.push(kind);
    if (options.fail) throw new Error("database unavailable");
    await new Promise<void>((resolve) => (release = resolve));
  };
  const reported: { error: unknown; source: string }[] = [];
  const plugins = { reportError: async (error: unknown, where: { source: string }) => void reported.push({ error, source: where.source }) };
  const platform = { logger: pino({ level: "silent" }), plugins } as unknown as Platform;
  const work = createBackgroundWork(platform, {
    keepAlive: (promise) => kept.push(promise),
    now: () => time,
    worker: { tick: run("tick"), drain: run("drain") },
  });
  const finish = async () => {
    // Let each queued run start, then end it.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      release?.();
      release = null;
    }
    await work.idle();
  };
  return { work, runs, kept, reported, finish, advance: (ms: number) => (time += ms) };
};

describe("Vercel background work", () => {
  it("ticks on an instance's first request, then at most once a minute", async () => {
    const { work, runs, kept, finish, advance } = setup();
    work.afterRequest("/graphql", false);
    await finish();
    expect(runs).toEqual(["tick"]);
    expect(kept).toHaveLength(1);

    advance(30_000);
    work.afterRequest("/graphql", false);
    await finish();
    expect(runs).toEqual(["tick"]);

    advance(30_000);
    work.afterRequest("/graphql", false);
    await finish();
    expect(runs).toEqual(["tick", "tick"]);
  });

  it("drains after a request that wrote outbox events, kept alive with waitUntil", async () => {
    const { work, runs, kept, finish } = setup();
    work.afterRequest("/graphql", false);
    await finish();
    work.afterRequest("/admin/graphql", true);
    expect(kept).toHaveLength(2);
    await finish();
    expect(runs).toEqual(["tick", "drain"]);
  });

  it("never overlaps runs: requests during a run queue one more", async () => {
    const { work, runs, kept, finish } = setup();
    work.afterRequest("/graphql", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    work.afterRequest("/admin/graphql", true);
    work.afterRequest("/graphql", true);
    work.afterRequest("/graphql", true);
    // Every request holds its instance until the run that covers its events ends.
    expect(new Set(kept).size).toBe(1);
    await finish();
    expect(runs).toEqual(["tick", "drain"]);
  });

  it("counts the cron's own request as this minute's tick", async () => {
    const { work, runs, finish, advance } = setup();
    work.afterRequest("/internal/worker", false);
    advance(1_000);
    work.afterRequest("/graphql", false);
    await finish();
    expect(runs).toEqual([]);
  });

  it("logs and reports a failed run, and keeps going", async () => {
    const { work, runs, reported, finish, advance } = setup({ fail: true });
    work.afterRequest("/graphql", true);
    await finish();
    advance(60_000);
    work.afterRequest("/graphql", false);
    await finish();
    expect(runs).toEqual(["tick", "tick"]);
    expect(reported.map((r) => r.source)).toEqual(["worker", "worker"]);
  });
});
