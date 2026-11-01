import { describe, expect, it } from "vitest";
import { databaseUrlFromEnv, isVercelDeployment, loadConfig, migrationDatabaseUrlFromEnv, redisUrlFromEnv } from "../../src/config.ts";

const SECRET = "test-secret-test-secret-test-secret";
const vercel = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ VERCEL: "1", VERCEL_ENV: "production", JWT_SECRET: SECRET, ...env });

describe("config", () => {
  it("reads the database from DATABASE_URL, then POSTGRES_URL (Supabase, older Neon)", () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: "postgres://a/db", POSTGRES_URL: "postgres://b/db" })).toBe("postgres://a/db");
    expect(databaseUrlFromEnv({ POSTGRES_URL: "postgres://b/db" })).toBe("postgres://b/db");
    // Empty placeholders count as unset.
    expect(databaseUrlFromEnv({ DATABASE_URL: "", POSTGRES_URL: "postgres://b/db" })).toBe("postgres://b/db");
    expect(databaseUrlFromEnv({})).toBeUndefined();
    expect(loadConfig({ POSTGRES_URL: "postgres://b/db" }).databaseUrl).toBe("postgres://b/db");
    expect(loadConfig({ DATABASE_URL: "pglite:./.data/dev" }).databaseUrl).toBe("pglite:./.data/dev");
  });

  it("migrates over a direct connection when the integration provides one", () => {
    expect(migrationDatabaseUrlFromEnv({ DATABASE_URL: "postgres://pooled/db", DATABASE_URL_UNPOOLED: "postgres://direct/db" })).toBe("postgres://direct/db");
    expect(migrationDatabaseUrlFromEnv({ POSTGRES_URL: "postgres://pooled/db", POSTGRES_URL_NON_POOLING: "postgres://direct/db" })).toBe("postgres://direct/db");
    expect(migrationDatabaseUrlFromEnv({ POSTGRES_URL: "postgres://pooled/db" })).toBe("postgres://pooled/db");
  });

  it("reads Redis from REDIS_URL, then KV_URL (Upstash), and only as a TCP URL", () => {
    expect(redisUrlFromEnv({ REDIS_URL: "rediss://default:pw@one.upstash.io:6379", KV_URL: "rediss://two" })).toBe("rediss://default:pw@one.upstash.io:6379");
    expect(redisUrlFromEnv({ KV_URL: "rediss://default:pw@two.upstash.io:6379" })).toBe("rediss://default:pw@two.upstash.io:6379");
    expect(redisUrlFromEnv({ KV_REST_API_URL: "https://two.upstash.io", KV_REST_API_TOKEN: "t" })).toBeUndefined();
    expect(() => redisUrlFromEnv({ REDIS_URL: "https://two.upstash.io" })).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it("runs Vercel deployments as production, but not variables pulled for local development", () => {
    expect(isVercelDeployment(vercel())).toBe(true);
    expect(isVercelDeployment(vercel({ VERCEL_ENV: "preview" }))).toBe(true);
    expect(isVercelDeployment(vercel({ VERCEL_ENV: "development" }))).toBe(false);
    expect(isVercelDeployment({})).toBe(false);

    const config = loadConfig(vercel());
    expect(config).toMatchObject({ production: true, vercel: true, graphql: { introspection: false, maskErrors: true } });
    expect(() => loadConfig({ VERCEL: "1", VERCEL_ENV: "preview" })).toThrow(/JWT_SECRET must be set in production/);
    // `vercel env pull` writes VERCEL=1 and VERCEL_ENV=development into local env files.
    expect(loadConfig({ VERCEL: "1", VERCEL_ENV: "development" }).production).toBe(false);
    // An explicit NODE_ENV wins.
    expect(loadConfig(vercel({ NODE_ENV: "development" })).production).toBe(false);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
    expect(loadConfig({}).production).toBe(false);
  });

  it("defaults the admin URL to the deployment serving it", () => {
    expect(loadConfig(vercel({ VERCEL_PROJECT_PRODUCTION_URL: "shop.example.com", VERCEL_URL: "ecom-abc123.vercel.app" })).admin.url).toBe("https://shop.example.com/admin");
    // Previews have their own database branch, so their links stay on the preview.
    expect(loadConfig(vercel({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "shop.example.com", VERCEL_BRANCH_URL: "ecom-git-feature.vercel.app", VERCEL_URL: "ecom-abc123.vercel.app" })).admin.url).toBe(
      "https://ecom-git-feature.vercel.app/admin",
    );
    expect(loadConfig(vercel({ VERCEL_ENV: "preview", VERCEL_URL: "ecom-abc123.vercel.app" })).admin.url).toBe("https://ecom-abc123.vercel.app/admin");
    expect(loadConfig(vercel({ ADMIN_URL: "https://admin.example.com/admin/", VERCEL_PROJECT_PRODUCTION_URL: "shop.example.com" })).admin.url).toBe("https://admin.example.com/admin");
    expect(loadConfig({ PORT: "4100" }).admin.url).toBe("http://localhost:4100/admin");
  });

  it("trusts as many proxies as TRUST_PROXY says: none by default, Vercel's edge on Vercel", () => {
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig(vercel()).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig(vercel({ TRUST_PROXY: "0" })).trustProxy).toBe(0);
    expect(() => loadConfig({ TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY must be/);
  });

  it("keeps database pools small on Vercel", () => {
    expect(loadConfig(vercel()).databasePool).toEqual({ max: 5, idleTimeoutMs: 5_000, connectionTimeoutMs: 10_000 });
    expect(loadConfig(vercel({ DATABASE_POOL_SIZE: "3" })).databasePool.max).toBe(3);
    expect(loadConfig({}).databasePool).toEqual({ max: 10, idleTimeoutMs: undefined, connectionTimeoutMs: undefined });
  });

  it("chooses the response cache: shared with Redis, off on Vercel without it, in memory otherwise", () => {
    const redis = { REDIS_URL: "redis://localhost:6379" };
    expect(loadConfig({}).graphql.responseCache).toBe("memory");
    expect(loadConfig(redis).graphql.responseCache).toBe("redis");
    expect(loadConfig(vercel()).graphql.responseCache).toBe("off");
    expect(loadConfig(vercel({ KV_URL: "rediss://default:pw@x.upstash.io:6379" })).graphql.responseCache).toBe("redis");
    expect(loadConfig(vercel({ GRAPHQL_RESPONSE_CACHE: "memory" })).graphql.responseCache).toBe("memory");
    expect(loadConfig({ ...redis, GRAPHQL_RESPONSE_CACHE: "off" }).graphql.responseCache).toBe("off");
    expect(() => loadConfig({ GRAPHQL_RESPONSE_CACHE: "redis" })).toThrow(/needs REDIS_URL/);
    expect(() => loadConfig({ GRAPHQL_RESPONSE_CACHE: "disk" })).toThrow(/auto, memory, redis or off/);
  });

  it("reads the cron secret, ignoring an empty one", () => {
    expect(loadConfig({ CRON_SECRET: "s3cret-s3cret-s3cret" }).worker.cronSecret).toBe("s3cret-s3cret-s3cret");
    expect(loadConfig({ CRON_SECRET: "" }).worker.cronSecret).toBeUndefined();
  });
});
