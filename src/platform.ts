import { createPubSub, type PubSubEventTarget } from "graphql-yoga";
import pino, { type Logger } from "pino";
import { loadConfig, type Config } from "./config.ts";
import { createDatabase, type Database, type DatabaseHandle } from "./db/client.ts";
import { createResponseCache, maxResponseTtlMs, type ResponseCache } from "./graphql/response-cache.ts";
import { createRedisConnection, redisPrefix, type RedisConnection } from "./lib/redis.ts";
import { createRedisEventTarget } from "./lib/redis-event-target.ts";
import { createProviderRegistry, type PaymentProvider, type PaymentProviderRegistry } from "./modules/payments/providers.ts";
import { applyPluginMigrations } from "./modules/plugins/migrations.ts";
import { validatePluginDefinitions } from "./modules/plugins/registry.ts";
import { createPluginRuntime } from "./modules/plugins/runtime.ts";
import type { PluginRuntime } from "./modules/plugins/types.ts";
import { createShippingRegistry, type ShippingProviderRegistry } from "./modules/shipping/providers.ts";
import type { AnyPluginDefinition } from "./plugins/sdk.ts";

export type OrderUpdate = { orderId: string; type: string; status: string; paymentStatus: string; fulfillmentStatus: string; occurredAt: string };

type PlatformEvents = {
  orderUpdated: [orderId: string, update: OrderUpdate];
  /** Every order event, for staff watching the store. */
  orderActivity: [update: OrderUpdate];
  /** Without an id, every cached result holding that type. */
  invalidate: [entities: { typename: string; id?: string }[]];
};

/**
 * Fed by the outbox worker, so subscribers see committed state only. In memory unless given a
 * Redis-backed event target.
 */
export const createPlatformPubSub = (eventTarget?: EventTarget) =>
  createPubSub<PlatformEvents>(eventTarget ? { eventTarget: eventTarget as PubSubEventTarget<PlatformEvents> } : undefined);
export type PlatformPubSub = ReturnType<typeof createPlatformPubSub>;

/** Built once at startup and passed explicitly to requests and jobs. */
export type Platform = {
  db: Database;
  database: DatabaseHandle;
  config: Config;
  /** Built in, plus the plugins'. */
  payments: PaymentProviderRegistry;
  /** Built in (flat rate, table rate, free), plus the plugins'. */
  shipping: ShippingProviderRegistry;
  plugins: PluginRuntime;
  /** Outbound HTTP for providers and plugins; tests pass a stand-in. */
  fetch: typeof fetch;
  pubsub: PlatformPubSub;
  logger: Logger;
  /** Null without REDIS_URL. Backs pub/sub and the response cache across processes. */
  redis: RedisConnection | null;
  /** Storefront only; null when off. */
  responseCache: ResponseCache | null;
};

export const createPlatform = async (
  options: {
    config?: Config;
    database?: DatabaseHandle;
    paymentProviders?: PaymentProvider[];
    /** Servers and scripts pass ecom.config.ts's; none by default, as in tests. */
    plugins?: readonly AnyPluginDefinition[];
    fetch?: typeof fetch;
    /** Where plugin settings' environment overrides are read (process.env by default). */
    env?: Record<string, string | undefined>;
    logger?: Logger;
    migrate?: boolean;
    redis?: RedisConnection | null;
    /** Vercel's waitUntil: keeps the process alive for writes nobody awaits. */
    keepAlive?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<Platform> => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
  const paymentProviderCodes = (options.paymentProviders ?? []).map((p) => p.code);
  // A misconfigured plugin fails startup here, before the database is opened.
  validatePluginDefinitions(options.plugins ?? [], { paymentProviderCodes });
  const database = options.database ?? (await createDatabase(config.databaseUrl, config.databasePool));
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const plugins = createPluginRuntime(options.plugins ?? [], {
    db: database.db,
    config,
    logger,
    fetch: fetchImpl,
    env: options.env,
    platform: () => platform,
    paymentProviderCodes,
    keepAlive: options.keepAlive,
  });
  if (options.migrate ?? database.kind === "pglite") {
    await database.migrate();
    await applyPluginMigrations(database.db, plugins.definitions, logger);
  }
  // Read once now, so later settings reads never wait on the database.
  if (plugins.definitions.length) await plugins.refresh();
  const redis = options.redis !== undefined ? options.redis : config.redisUrl ? createRedisConnection(config.redisUrl, { prefix: redisPrefix(config.databaseUrl), logger }) : null;
  // Servers and scripts shut down by closing the database, so that closes Redis too.
  const closeAll = async () => {
    await Promise.all([database.close(), redis?.close()]);
  };
  const platform: Platform = {
    db: database.db,
    database: redis ? { ...database, close: closeAll } : database,
    config,
    payments: createProviderRegistry(...(options.paymentProviders ?? []), ...plugins.paymentProviders),
    shipping: createShippingRegistry(...plugins.shippingProviders),
    plugins,
    fetch: fetchImpl,
    pubsub: createPlatformPubSub(redis ? createRedisEventTarget(redis, { logger, keepAlive: options.keepAlive }) : undefined),
    logger,
    redis,
    responseCache: createResponseCache(config.graphql.responseCache, { redis, maxTtlMs: maxResponseTtlMs(config.graphql.responseCacheTtlMs), logger, keepAlive: options.keepAlive }),
  };
  return platform;
};
