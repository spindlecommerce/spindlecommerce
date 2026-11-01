import { randomBytes } from "node:crypto";

export type ResponseCacheMode = "memory" | "redis" | "off";

export type Config = {
  port: number;
  /** NODE_ENV=production, or a Vercel deployment (production or preview) with NODE_ENV unset. */
  production: boolean;
  /** A Vercel deployment rather than a long-running process. */
  vercel: boolean;
  /** Reverse proxies in front of the API that append to X-Forwarded-For; with none, audit entries record the connection's address. */
  trustProxy: number;
  databaseUrl: string | undefined;
  /** Undefined keeps pg's defaults. Ignored for PGlite. */
  databasePool: { max: number; idleTimeoutMs: number | undefined; connectionTimeoutMs: number | undefined };
  /** redis:// or rediss://, for cross-process pub/sub and response cache; unset keeps both in memory. */
  redisUrl: string | undefined;
  jwtSecret: Uint8Array;
  /** JWT_SECRET was unset, so tokens and sealed secrets die with the process. */
  secretIsEphemeral: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  passwordResetTtlSeconds: number;
  defaultChannelCode: string | undefined;
  graphql: {
    maxDepth: number;
    maxComplexity: number;
    adminMaxComplexity: number;
    introspection: boolean;
    maskErrors: boolean;
    /** Caches storefront responses only. */
    responseCache: ResponseCacheMode;
    responseCacheTtlMs: number;
  };
  worker: {
    pollIntervalMs: number;
    batchSize: number;
    webhookTimeoutMs: number;
    maxWebhookAttempts: number;
    /** Bearer token for the worker route (Vercel Cron sends it); without one, production refuses the route. */
    cronSecret: string | undefined;
  };
  admin: {
    /** Public URL of the admin app, used in password reset links and as the visual editing origin. */
    url: string;
    /** Built admin app served at /admin; null disables serving it. */
    appDir: string | null;
    lockoutFailures: number;
    lockoutMinutes: number;
    twoFactorChallengeTtlSeconds: number;
  };
  media: { dir: string; maxBytes: number };
};

const int = (value: string | undefined, fallback: number) => (value === undefined || value === "" ? fallback : Number.parseInt(value, 10));

/** An empty variable counts as unset: Vercel and .env files often carry empty placeholders. */
const nonEmpty = (...values: (string | undefined)[]) => values.find((v) => v !== undefined && v.trim() !== "")?.trim();

/**
 * A Vercel deployment, production or preview. Not VERCEL_ENV=development, which `vercel env pull`
 * writes into local env files.
 */
export const isVercelDeployment = (env: NodeJS.ProcessEnv = process.env) => env.VERCEL === "1" && env.VERCEL_ENV !== "development";

/** The PostgreSQL URL: DATABASE_URL, or POSTGRES_URL as set by the Supabase and older Neon integrations. */
export const databaseUrlFromEnv = (env: NodeJS.ProcessEnv = process.env) => nonEmpty(env.DATABASE_URL, env.POSTGRES_URL);

/** A direct (unpooled) URL for migrations, falling back to the pooled one. */
export const migrationDatabaseUrlFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  nonEmpty(env.DATABASE_URL_UNPOOLED, env.POSTGRES_URL_NON_POOLING) ?? databaseUrlFromEnv(env);

/** REDIS_URL, or KV_URL as set by the Upstash integration. Only TCP URLs: the REST API cannot carry pub/sub. */
export const redisUrlFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
  const url = nonEmpty(env.REDIS_URL, env.KV_URL);
  if (url && !/^rediss?:\/\//.test(url)) throw new Error("REDIS_URL (or KV_URL) must be a redis:// or rediss:// URL");
  return url;
};

/** The deployment serves the admin itself: on the production domain, or a preview's branch URL. */
const vercelAdminUrl = (env: NodeJS.ProcessEnv) => {
  const host = env.VERCEL_ENV === "production" ? nonEmpty(env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL) : nonEmpty(env.VERCEL_BRANCH_URL, env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL);
  return host ? `https://${host}/admin` : undefined;
};

const responseCacheMode = (env: NodeJS.ProcessEnv, redisUrl: string | undefined, vercel: boolean): ResponseCacheMode => {
  const mode = env.GRAPHQL_RESPONSE_CACHE?.trim() || "auto";
  if (mode === "auto") {
    // Without Redis, Vercel instances can't invalidate each other's memory, so a cached response
    // could outlive a publish.
    if (redisUrl) return "redis";
    return vercel ? "off" : "memory";
  }
  if (mode !== "memory" && mode !== "redis" && mode !== "off") throw new Error("GRAPHQL_RESPONSE_CACHE must be auto, memory, redis or off");
  if (mode === "redis" && !redisUrl) throw new Error("GRAPHQL_RESPONSE_CACHE=redis needs REDIS_URL (or KV_URL)");
  return mode;
};

/** Vercel's edge sets X-Forwarded-For itself, so it counts as one proxy there. */
const trustProxy = (env: NodeJS.ProcessEnv, vercel: boolean) => {
  const value = nonEmpty(env.TRUST_PROXY);
  if (value === undefined) return vercel ? 1 : 0;
  if (!/^\d+$/.test(value)) throw new Error("TRUST_PROXY must be the number of proxies in front of the API (0 for none)");
  return Number(value);
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config => {
  const vercel = isVercelDeployment(env);
  const production = env.NODE_ENV ? env.NODE_ENV === "production" : vercel;
  if (production && !env.JWT_SECRET) throw new Error("JWT_SECRET must be set in production");
  const port = int(env.PORT, 4000);
  const redisUrl = redisUrlFromEnv(env);
  return {
    port,
    production,
    vercel,
    trustProxy: trustProxy(env, vercel),
    databaseUrl: databaseUrlFromEnv(env),
    databasePool: {
      // Fluid compute runs many instances: keep pools small, and close idle connections fast, since
      // attachDatabasePool keeps the instance alive until they close.
      max: int(env.DATABASE_POOL_SIZE, vercel ? 5 : 10),
      idleTimeoutMs: vercel ? 5_000 : undefined,
      connectionTimeoutMs: vercel ? 10_000 : undefined,
    },
    redisUrl,
    jwtSecret: new TextEncoder().encode(env.JWT_SECRET ?? randomBytes(32).toString("hex")),
    secretIsEphemeral: !env.JWT_SECRET,
    accessTokenTtlSeconds: int(env.ACCESS_TOKEN_TTL_SECONDS, 15 * 60),
    refreshTokenTtlSeconds: int(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 3600),
    passwordResetTtlSeconds: int(env.PASSWORD_RESET_TTL_SECONDS, 3600),
    defaultChannelCode: env.DEFAULT_CHANNEL,
    graphql: {
      maxDepth: int(env.GRAPHQL_MAX_DEPTH, 12),
      maxComplexity: int(env.GRAPHQL_MAX_COMPLEXITY, 2000),
      adminMaxComplexity: int(env.GRAPHQL_ADMIN_MAX_COMPLEXITY, 20000),
      introspection: env.GRAPHQL_INTROSPECTION ? env.GRAPHQL_INTROSPECTION === "true" : !production,
      maskErrors: production,
      responseCache: responseCacheMode(env, redisUrl, vercel),
      responseCacheTtlMs: int(env.GRAPHQL_RESPONSE_CACHE_TTL_MS, 60_000),
    },
    worker: {
      pollIntervalMs: int(env.WORKER_POLL_INTERVAL_MS, 1000),
      batchSize: int(env.WORKER_BATCH_SIZE, 100),
      webhookTimeoutMs: int(env.WEBHOOK_TIMEOUT_MS, 10_000),
      maxWebhookAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 8),
      cronSecret: nonEmpty(env.CRON_SECRET),
    },
    admin: {
      url: (nonEmpty(env.ADMIN_URL) ?? (vercel ? vercelAdminUrl(env) : undefined) ?? `http://localhost:${port}/admin`).replace(/\/+$/, ""),
      appDir: env.ADMIN_APP_DIR === "" ? null : (env.ADMIN_APP_DIR ?? "admin/dist"),
      lockoutFailures: int(env.STAFF_LOCKOUT_FAILURES, 5),
      lockoutMinutes: int(env.STAFF_LOCKOUT_MINUTES, 15),
      twoFactorChallengeTtlSeconds: int(env.STAFF_2FA_CHALLENGE_TTL_SECONDS, 300),
    },
    media: { dir: env.MEDIA_DIR ?? ".data/media", maxBytes: int(env.MEDIA_MAX_BYTES, 20 * 1024 * 1024) },
    ...overrides,
  };
};
