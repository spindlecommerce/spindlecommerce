import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import pino from "pino";
import { loadConfig } from "../config.ts";
import { createDatabase, type Database, type DatabaseHandle } from "../db/client.ts";
import { seedDemoOrders } from "../db/demo-orders.ts";
import { seedDemoData } from "../db/seed-data.ts";
import { channels } from "../modules/channels/tables.ts";
import { paymentMethods } from "../modules/payments/tables.ts";
import { applyPluginMigrations } from "../modules/plugins/migrations.ts";
import type { AnyPluginDefinition } from "../plugins/sdk.ts";
import { createRole, createStaffUser } from "../modules/staff/service.ts";
import { roles, staffUsers } from "../modules/staff/tables.ts";
import { createPlatform } from "../platform.ts";

export type FirstAdmin = { email: string; password: string; name?: string };

/**
 * The first staff user, an Administrator with every permission, when there is no staff yet. A no-op
 * after that, so remove its variables after the first deployment.
 */
export const bootstrapAdmin = async (db: Database, admin: FirstAdmin): Promise<{ email: string } | null> => {
  if ((await db.$count(staffUsers)) > 0) return null;
  const role = (await db.query.roles.findFirst({ where: eq(roles.code, "admin") })) ?? (await createRole(db, { code: "admin", name: "Administrator", permissions: ["*"] }));
  const user = await createStaffUser(db, { email: admin.email, password: admin.password, name: admin.name ?? "Administrator", roleIds: [role.id] });
  return { email: user.email };
};

export type DemoStore = { products: number; orders: number };

/**
 * Demo data and order history for a store with no channels yet (BOOTSTRAP_DEMO_DATA). Adds no
 * staff user. The demo customer gets a random password, since the development one is public.
 */
export const seedDemoStore = async (database: DatabaseHandle, options: { plugins?: readonly AnyPluginDefinition[]; orders?: number } = {}): Promise<DemoStore | null> => {
  if ((await database.db.$count(channels)) > 0) return null;
  // The build serves no requests, so no Redis and no response cache.
  const config = loadConfig();
  const platform = await createPlatform({
    database,
    config: { ...config, graphql: { ...config.graphql, responseCache: "off" } },
    plugins: options.plugins,
    migrate: false,
    redis: null,
    logger: pino({ level: process.env.LOG_LEVEL ?? "warn" }),
  });
  // Hex, so it never contains "alex": a customer's password must not contain their email's name.
  const customer = { customerEmail: "alex@example.com", customerPassword: randomBytes(24).toString("hex") };
  // One transaction, so a build that fails halfway leaves an empty store for the next one to fill.
  const seed = await database.db.transaction(async (tx) => {
    const result = await seedDemoData({ db: tx, payments: platform.payments }, customer);
    // Deployment demo data must never expose the fake gateway on a public storefront.
    await tx.update(paymentMethods).set({ isActive: false }).where(eq(paymentMethods.provider, "test_gateway"));
    return result;
  });
  const { placed } = await seedDemoOrders(platform, options.orders ?? 80);
  return { products: Object.keys(seed.products).length, orders: placed };
};

/**
 * Migrate a deployment's database, then optionally add the first admin and demo data. Concurrent
 * builds on one database take turns under an advisory lock, held by a transaction on its own
 * connection so it also works through transaction-mode poolers.
 */
export const prepareDatabase = async (
  url: string,
  options: { admin?: FirstAdmin; demo?: boolean; plugins?: readonly AnyPluginDefinition[] } = {},
): Promise<{ admin: { email: string } | null; demo: DemoStore | null; plugins: string[] }> => {
  const lock = new pg.Client({ connectionString: url });
  await lock.connect();
  try {
    await lock.query("begin");
    await lock.query("select pg_advisory_xact_lock(hashtextextended('ecom:deploy-migrations', 0))");
    const database = await createDatabase(url, { max: 2 });
    try {
      await database.migrate();
      const plugins = await applyPluginMigrations(database.db, options.plugins ?? []);
      const admin = options.admin ? await bootstrapAdmin(database.db, options.admin) : null;
      const demo = options.demo ? await seedDemoStore(database, { plugins: options.plugins }) : null;
      await lock.query("commit");
      return { admin, demo, plugins };
    } finally {
      await database.close();
    }
  } finally {
    // Without a commit (a failed migration) closing the connection rolls back and releases the lock.
    await lock.end();
  }
};
