import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.ts";
import { verifyPassword } from "../../src/modules/auth/service.ts";
import { channels } from "../../src/modules/channels/tables.ts";
import { customers } from "../../src/modules/customers/tables.ts";
import { orders } from "../../src/modules/orders/tables.ts";
import { paymentMethods } from "../../src/modules/payments/tables.ts";
import { roles, staffUsers } from "../../src/modules/staff/tables.ts";
import { bootstrapAdmin, seedDemoStore } from "../../src/vercel/database.ts";

describe("demo data on a deployment (BOOTSTRAP_DEMO_DATA)", () => {
  it("fills an empty store once, for the first admin to sign in to", async () => {
    const database = await createDatabase("memory:");
    const { db } = database;
    // A project with Upstash: the build connects to no Redis, and its response cache stays off.
    const redisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    try {
      await database.migrate();
      await bootstrapAdmin(db, { email: "owner@example.test", password: "owner-password-123" });

      const demo = await seedDemoStore(database, { orders: 4 });
      // Some demo orders are skipped (a variant sold out), so count what was placed.
      expect(demo).toEqual({ products: 8, orders: await db.$count(orders) });
      expect(demo!.orders).toBeGreaterThan(0);
      expect(await db.$count(channels)).toBe(2);
      // No demo staff: the first admin signs in, with the admin role it was created with.
      expect((await db.select({ email: staffUsers.email }).from(staffUsers)).map((s) => s.email)).toEqual(["owner@example.test"]);
      expect((await db.select({ code: roles.code }).from(roles)).map((r) => r.code).sort()).toEqual(["admin", "fulfillment"]);
      // The development password for the demo customer is public, so a deployment's is random.
      const alex = await db.query.customers.findFirst({ where: eq(customers.email, "alex@example.com") });
      expect(alex).toBeDefined();
      expect(await verifyPassword(alex!.passwordHash, "dev-customer-password-123")).toBe(false);
      expect(await db.select({ code: paymentMethods.code, isActive: paymentMethods.isActive }).from(paymentMethods).where(eq(paymentMethods.provider, "test_gateway"))).toEqual([
        { code: "card", isActive: false },
        { code: "card_instant", isActive: false },
      ]);

      // Later deployments leave the store alone.
      expect(await seedDemoStore(database, { orders: 4 })).toBeNull();
      expect(await db.$count(orders)).toBe(demo!.orders);
    } finally {
      if (redisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = redisUrl;
      await database.close();
    }
  });
});
