import { describe, expect, it } from "vitest";
import { createRedisCache, maxResponseTtlMs } from "../../src/graphql/response-cache.ts";
import { redisPrefix } from "../../src/lib/redis.ts";
import { createRedisEventTarget } from "../../src/lib/redis-event-target.ts";
import { createPlatformPubSub } from "../../src/platform.ts";
import { FakeRedisServer } from "../helpers/fake-redis.ts";

const result = (name: string) => ({ data: { product: { id: "UHJvZHVjdDox", name } } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Redis response cache", () => {
  const setup = () => {
    const server = new FakeRedisServer();
    const now = Date.now();
    server.now = () => now;
    const { connection, client } = server.connection();
    const cache = createRedisCache(connection, { maxTtlMs: 60_000, prefix: "test:rc:" });
    return { server, client, cache };
  };

  it("stores results with their TTL and serves them back", async () => {
    const { server, cache } = setup();
    await cache.set("q1", result("Tote"), [{ typename: "Product", id: "UHJvZHVjdDox" }], 15_000);
    expect(await cache.get("q1")).toEqual(result("Tote"));
    expect(await cache.get("q2")).toBeNull();
    expect(server.ttl("test:rc:r:q1")).toBe(15_000);
    // Entity indexes outlive every response they can point at.
    expect(server.ttl("test:rc:e:Product:UHJvZHVjdDox")).toBe(60_000);
    expect(server.ttl("test:rc:e:Product")).toBe(60_000);
    const now = server.now();
    server.now = () => now + 15_001;
    expect(await cache.get("q1")).toBeNull();
  });

  it("invalidates by entity and by typename, leaving other responses", async () => {
    const { cache } = setup();
    await cache.set("tote", result("Tote"), [{ typename: "Product", id: "p1" }, { typename: "Category", id: "c1" }], 60_000);
    await cache.set("boot", result("Boot"), [{ typename: "Product", id: "p2" }], 60_000);
    await cache.set("pages", { data: { pages: [] } }, [{ typename: "Page", id: "g1" }], 60_000);

    await cache.invalidate([{ typename: "Product", id: "p1" }]);
    expect(await cache.get("tote")).toBeNull();
    expect(await cache.get("boot")).toEqual(result("Boot"));

    await cache.invalidate([{ typename: "Product" }]);
    expect(await cache.get("boot")).toBeNull();
    expect(await cache.get("pages")).not.toBeNull();
  });

  it("matches the in-memory cache's entity keys, so the plugin's ids invalidate", async () => {
    const { cache, server } = setup();
    // The plugin passes ids as they appear in results (global ids), and typenames without an id.
    await cache.set("q", result("Tote"), [{ typename: "Product", id: "UHJvZHVjdDox" }, { typename: "ProductVariant" }], 60_000);
    expect([...server.sets.keys()].sort()).toEqual(["test:rc:e:Product", "test:rc:e:Product:UHJvZHVjdDox", "test:rc:e:ProductVariant"]);
  });

  it("never rejects: a lost connection is a miss, and the cache steps aside for a while", async () => {
    const { client, server, cache } = setup();
    await cache.set("q1", result("Tote"), [], 60_000);
    client.failure = Object.assign(new Error("Connection is closed."), { name: "Error" });
    await expect(cache.get("q1")).resolves.toBeNull();
    await expect(cache.set("q2", result("Boot"), [], 60_000)).resolves.toBeUndefined();
    await expect(cache.invalidate([{ typename: "Product" }])).resolves.toBeUndefined();
    client.failure = null;
    const before = server.commands.length;
    // Paused: no round trip while the connection is presumed down.
    expect(await cache.get("q1")).toBeNull();
    expect(server.commands.length).toBe(before);
  });

  it("keeps serving after a command error that is not about the connection", async () => {
    const { client, cache } = setup();
    await cache.set("q1", result("Tote"), [], 60_000);
    client.failure = Object.assign(new Error("ERR max request size exceeded"), { name: "ReplyError" });
    await cache.set("q2", result("Boot"), [], 60_000);
    client.failure = null;
    expect(await cache.get("q1")).toEqual(result("Tote"));
  });

  it("skips results too large to be worth caching", async () => {
    const { cache } = setup();
    await cache.set("big", { data: { blob: "x".repeat(1024 * 1024 + 1) } }, [], 60_000);
    expect(await cache.get("big")).toBeNull();
  });

  it("hands the writes the plugin does not await to keepAlive (waitUntil on Vercel)", async () => {
    const server = new FakeRedisServer();
    const held: Promise<unknown>[] = [];
    const cache = createRedisCache(server.connection().connection, { maxTtlMs: 60_000, prefix: "test:rc:", keepAlive: (p) => held.push(p) });
    await cache.set("q1", result("Tote"), [{ typename: "Product", id: "p1" }], 60_000);
    await cache.invalidate([{ typename: "Product", id: "p1" }]);
    expect(held).toHaveLength(2);
    await Promise.all(held);
    expect(await cache.get("q1")).toBeNull();
  });

  it("indexes entities for the longest TTL the storefront uses", () => {
    expect(maxResponseTtlMs(60_000)).toBe(60_000);
    expect(maxResponseTtlMs(5_000)).toBe(15_000);
  });
});

describe("Redis event target", () => {
  it("delivers to this process at once and to other processes through Redis, once each", async () => {
    const server = new FakeRedisServer();
    const a = createRedisEventTarget(server.connection("db1:").connection);
    const b = createRedisEventTarget(server.connection("db1:").connection);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.addEventListener("orderActivity", (e) => seenA.push((e as CustomEvent).detail));
    b.addEventListener("orderActivity", (e) => seenB.push((e as CustomEvent).detail));
    await tick();

    a.dispatchEvent(new CustomEvent("orderActivity", { detail: { orderId: "o1" } }));
    expect(seenA).toEqual([{ orderId: "o1" }]);
    await tick();
    expect(seenA).toEqual([{ orderId: "o1" }]);
    expect(seenB).toEqual([{ orderId: "o1" }]);
  });

  it("hands each publish to keepAlive and still sends it", async () => {
    const server = new FakeRedisServer();
    const held: Promise<unknown>[] = [];
    const a = createRedisEventTarget(server.connection("db1:").connection, { keepAlive: (p) => held.push(p) });
    const b = createRedisEventTarget(server.connection("db1:").connection);
    const seen: unknown[] = [];
    b.addEventListener("invalidate", (e) => seen.push((e as CustomEvent).detail));
    await tick();
    a.dispatchEvent(new CustomEvent("invalidate", { detail: [{ typename: "Product" }] }));
    expect(held).toHaveLength(1);
    await tick();
    expect(seen).toEqual([[{ typename: "Product" }]]);
  });

  it("keeps platforms on other databases apart", async () => {
    const server = new FakeRedisServer();
    expect(redisPrefix("postgres://prod/db")).not.toBe(redisPrefix("postgres://preview-branch/db"));
    const production = createRedisEventTarget(server.connection(redisPrefix("postgres://prod/db")).connection);
    const preview = createRedisEventTarget(server.connection(redisPrefix("postgres://preview-branch/db")).connection);
    const seen: unknown[] = [];
    production.addEventListener("orderActivity", (e) => seen.push((e as CustomEvent).detail));
    await tick();
    preview.dispatchEvent(new CustomEvent("orderActivity", { detail: { orderId: "preview" } }));
    await tick();
    expect(seen).toEqual([]);
  });

  it("subscribes to a channel while it has listeners", async () => {
    const server = new FakeRedisServer();
    const { connection, subscriber } = server.connection("db1:");
    const target = createRedisEventTarget(connection);
    const listener = () => {};
    target.addEventListener("invalidate", listener);
    await tick();
    expect([...subscriber()!.channels]).toEqual(["db1:events:invalidate"]);
    target.removeEventListener("invalidate", listener);
    await tick();
    expect(subscriber()!.channels.size).toBe(0);
  });

  it("carries the platform's subscriptions between instances", async () => {
    const server = new FakeRedisServer();
    const worker = createPlatformPubSub(createRedisEventTarget(server.connection("db1:").connection));
    const api = createPlatformPubSub(createRedisEventTarget(server.connection("db1:").connection));
    const updates = api.subscribe("orderUpdated", "o1");
    const next = updates.next();
    await tick();
    const update = { orderId: "o1", type: "order.fulfilled", status: "processing", paymentStatus: "captured", fulfillmentStatus: "fulfilled", occurredAt: new Date(0).toISOString() };
    worker.publish("orderUpdated", "o2", { ...update, orderId: "o2" });
    worker.publish("orderUpdated", "o1", update);
    expect((await next).value).toEqual(update);
    await updates.return();
  });
});
