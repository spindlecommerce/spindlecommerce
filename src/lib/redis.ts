import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { Logger } from "pino";

/**
 * A command connection, and a subscriber connection opened on first subscribe. Both connect
 * lazily, so a script that never uses pub/sub or the cache never connects.
 */
export type RedisConnection = {
  client: Redis;
  subscriber: () => Redis;
  /** Prefix for every key and channel, shared by platforms on the same database. */
  prefix: string;
  close: () => Promise<void>;
};

/** The braces are a hash tag: in a cluster all keys share one slot, so MULTI never spans slots. */
export const redisPrefix = (databaseUrl: string | undefined) => `ecom:{${createHash("sha256").update(databaseUrl ?? "memory:").digest("hex").slice(0, 16)}}:`;

export const createRedisConnection = (url: string, options: { prefix: string; logger: Logger }): RedisConnection => {
  // At most one log a minute, not one per retry.
  let lastLogged = 0;
  const watch = (redis: Redis, role: string) => {
    redis.on("error", (err: Error) => {
      if (Date.now() - lastLogged < 60_000) return;
      lastLogged = Date.now();
      options.logger.warn({ err: { message: err.message }, role }, "redis connection error");
    });
    return redis;
  };
  const create = (role: "client" | "subscriber") =>
    new Redis(url, {
      lazyConnect: true,
      // RESP2, which every Redis service speaks (ioredis 6 defaults to RESP3).
      protocol: 2,
      connectTimeout: 5_000,
      // Commands fail fast while Redis is down; callers treat errors as a cache miss or a dropped
      // notification. (Un)subscribing waits for a connection.
      ...(role === "client" ? { maxRetriesPerRequest: 2, commandTimeout: 2_000 } : { maxRetriesPerRequest: null }),
      connectionName: `ecom-${role}`,
    });
  const client = watch(create("client"), "client");
  let subscriber: Redis | null = null;
  return {
    client,
    subscriber: () => (subscriber ??= watch(create("subscriber"), "subscriber")),
    prefix: options.prefix,
    close: async () => {
      const connections = [client, subscriber].filter((r): r is Redis => r !== null);
      await Promise.all(
        connections.map(async (r) => {
          // QUIT would wait forever on a reconnecting connection. disconnect() also stops reconnecting.
          if (r.status === "ready") await Promise.race([r.quit().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
          r.disconnect();
        }),
      );
    },
  };
};
