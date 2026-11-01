import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../../src/config.ts";
import { seedDemoData } from "../../src/db/seed-data.ts";
import type { PaymentProvider } from "../../src/modules/payments/providers.ts";
import { createPlatform, type Platform } from "../../src/platform.ts";
import type { AnyPluginDefinition } from "../../src/plugins/sdk.ts";

export const TEST_CREDENTIALS = {
  adminEmail: "admin@example.test",
  adminPassword: "test-admin-password-123",
  customerEmail: "alex@example.test",
  customerPassword: "test-customer-password-123",
};

/** A platform on a fresh in-memory database with the demo data, whatever DATABASE_URL says. */
export const createTestPlatform = async (options: { plugins?: AnyPluginDefinition[]; fetch?: typeof fetch; paymentProviders?: PaymentProvider[]; env?: Record<string, string> } = {}) => {
  const platform = await createPlatform({
    config: loadConfig({
      JWT_SECRET: "test-secret-test-secret-test-secret",
      NODE_ENV: "test",
      DATABASE_URL: "memory:",
      MEDIA_DIR: join(tmpdir(), "ecom-test-media"),
      ADMIN_APP_DIR: "",
      ...options.env,
    }),
    plugins: options.plugins,
    fetch: options.fetch,
    paymentProviders: options.paymentProviders,
    // Plugin settings' environment overrides (e.g. STRIPE_SECRET_KEY) read the same variables.
    env: options.env ? { ...process.env, ...options.env } : undefined,
    logger: pino({ level: "silent" }),
    migrate: true,
  });
  const seed = await seedDemoData(platform, TEST_CREDENTIALS);
  return { platform, seed, close: () => platform.database.close() };
};

export type TestPlatform = Awaited<ReturnType<typeof createTestPlatform>> & { platform: Platform };
