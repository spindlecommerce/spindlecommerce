import { createInMemoryCache, type Cache } from "@graphql-yoga/plugin-response-cache";
import type { Logger } from "pino";
import type { ResponseCacheMode } from "../config.ts";
import { toGlobalId } from "../lib/ids.ts";
import type { RedisConnection } from "../lib/redis.ts";

type CachedResult = Awaited<ReturnType<Cache["get"]>>;
type EntityRecord = { typename: string; id?: number | string };

/** Entities as the outbox names them: a typename and, optionally, the row id. */
export type CacheEntity = { typename: string; id?: string };

/**
 * The storefront response cache. A `shared` one (Redis) is invalidated once by whoever processes an
 * event; per-process caches each listen for the platform's `invalidate` events.
 */
export type ResponseCache = {
  cache: Cache;
  shared: boolean;
  invalidate: (entities: CacheEntity[]) => Promise<void>;
};

/** Publishing evicts responses that contain the page; this bounds how stale a listing of pages can get. */
export const TTL_PER_SCHEMA_COORDINATE: Readonly<Record<string, number>> = { "Query.pages": 15_000 };

/** The longest a response can stay cached, which entity indexes must outlive. */
export const maxResponseTtlMs = (defaultTtlMs: number) => Math.max(defaultTtlMs, ...Object.values(TTL_PER_SCHEMA_COORDINATE));

/** The cache records entities by GraphQL global id, as they appear in results. */
const cacheEntities = (entities: CacheEntity[]) => entities.map((e) => ({ typename: e.typename, ...(e.id ? { id: toGlobalId(e.typename, e.id) } : {}) }));

type KeepAlive = (promise: Promise<unknown>) => void;

export const createResponseCache = (mode: ResponseCacheMode, options: { redis: RedisConnection | null; maxTtlMs: number; logger?: Logger; keepAlive?: KeepAlive }): ResponseCache | null => {
  if (mode === "off") return null;
  if (mode === "redis") {
    if (!options.redis) throw new Error("The Redis response cache needs a Redis connection");
    const cache = createRedisCache(options.redis, { maxTtlMs: options.maxTtlMs, logger: options.logger, keepAlive: options.keepAlive });
    return { cache, shared: true, invalidate: async (entities) => cache.invalidate(cacheEntities(entities)) };
  }
  const cache = createInMemoryCache({ max: 10_000 });
  return { cache, shared: false, invalidate: async (entities) => cache.invalidate(cacheEntities(entities)) };
};

/** Per deployment on Vercel, so a new deployment never serves responses rendered by old code. */
export const responseCachePrefix = (redis: RedisConnection, env: NodeJS.ProcessEnv = process.env) => `${redis.prefix}rc:${env.VERCEL_DEPLOYMENT_ID ? `${env.VERCEL_DEPLOYMENT_ID}:` : ""}`;

/** Results larger than this are not cached: they would cost more to move than to compute. */
const MAX_ENTRY_BYTES = 1024 * 1024;
/** After a connection failure the cache steps aside (misses, no writes) for this long. */
const BACKOFF_MS = 10_000;

/**
 * A Redis Cache for @envelop/response-cache:
 * - `r:<response id>`: the JSON result, expiring after its TTL.
 * - `e:<Typename>` and `e:<Typename>:<id>`: the ids of responses holding that type or entity,
 *   expiring no sooner than any response they can point at.
 * Nothing here rejects: the plugin doesn't await `set` or `invalidate`, and fails the request when
 * `get` throws. Errors are logged, `get` misses, and connection failures pause the cache.
 * `keepAlive` holds the instance until unawaited writes land; a write delayed past a suspension
 * could store a response older than a later invalidation.
 */
export const createRedisCache = (redis: RedisConnection, options: { maxTtlMs: number; logger?: Logger; prefix?: string; keepAlive?: KeepAlive }): Cache => {
  const prefix = options.prefix ?? responseCachePrefix(redis);
  const responseKey = (id: string) => `${prefix}r:${id}`;
  const entityKey = (entity: string) => `${prefix}e:${entity}`;
  const client = redis.client;
  let pausedUntil = 0;
  let lastLogged = 0;

  const failed = (operation: string, err: unknown) => {
    // A reply error is about this command (e.g. a value too large); anything else is the connection.
    if ((err as Error).name !== "ReplyError") pausedUntil = Date.now() + BACKOFF_MS;
    if (Date.now() - lastLogged > BACKOFF_MS) {
      lastLogged = Date.now();
      options.logger?.warn({ err: { message: (err as Error).message }, operation }, "redis response cache unavailable");
    }
  };
  const paused = () => Date.now() < pausedUntil;
  /** The plugin doesn't await writes, so keepAlive must. */
  const held = (write: () => Promise<void>) => {
    const promise = write();
    options.keepAlive?.(promise);
    return promise;
  };

  const hasId = (id: EntityRecord["id"]): id is number | string => id !== undefined && id !== null;
  /** A response is indexed under each typename it holds and each entity's own key. */
  const indexKeys = (entities: Iterable<EntityRecord>) => {
    const keys = new Set<string>();
    for (const { typename, id } of entities) {
      keys.add(typename);
      if (hasId(id)) keys.add(`${typename}:${id}`);
    }
    return keys;
  };
  /** Invalidating an entity drops its responses; a bare typename drops every response holding it. */
  const invalidationKeys = (entities: Iterable<EntityRecord>) => new Set([...entities].map(({ typename, id }) => (hasId(id) ? `${typename}:${id}` : typename)));

  /** EXEC resolves with [error, result] per command; surface the first error. */
  const exec = async (transaction: { exec: () => Promise<[Error | null, unknown][] | null> }) => {
    const results = await transaction.exec();
    if (!results) throw new Error("Redis transaction aborted");
    const error = results.find(([err]) => err)?.[0];
    if (error) throw error;
    return results.map(([, result]) => result);
  };

  return {
    async get(id) {
      if (paused()) return null;
      try {
        const raw = await client.get(responseKey(id));
        return raw ? (JSON.parse(raw) as CachedResult) : null;
      } catch (err) {
        failed("get", err);
        return null;
      }
    },
    set(id, data, entities, ttl) {
      if (paused()) return Promise.resolve();
      return held(async () => {
        try {
          const json = JSON.stringify(data);
          if (Buffer.byteLength(json) > MAX_ENTRY_BYTES) return;
          const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.ceil(ttl) : options.maxTtlMs;
          const indexTtlMs = Math.max(ttlMs, options.maxTtlMs);
          const transaction = client.multi().set(responseKey(id), json, "PX", ttlMs);
          for (const key of indexKeys(entities)) transaction.sadd(entityKey(key), id).pexpire(entityKey(key), indexTtlMs);
          await exec(transaction);
        } catch (err) {
          failed("set", err);
        }
      });
    },
    invalidate(entities) {
      const keys = [...invalidationKeys(entities)].map(entityKey);
      if (!keys.length) return Promise.resolve();
      return held(async () => {
        try {
          // Read and drop each index in one transaction, so a response cached meanwhile lands in a
          // fresh index instead of being dropped from this one while its entry survives.
          const transaction = client.multi();
          for (const key of keys) transaction.smembers(key).del(key);
          const results = await exec(transaction);
          const ids = new Set(results.filter((_, i) => i % 2 === 0).flatMap((members) => members as string[]));
          const responses = [...ids].map(responseKey);
          for (let i = 0; i < responses.length; i += 500) await client.del(...responses.slice(i, i + 500));
        } catch (err) {
          failed("invalidate", err);
        }
      });
    },
  };
};
