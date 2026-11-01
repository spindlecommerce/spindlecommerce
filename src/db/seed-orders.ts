/**
 * Demo order history for the dashboard and reports. Development only.
 *
 * Usage: pnpm db:seed:orders [count]   (default 80; run after pnpm db:seed)
 * With PGlite, stop `pnpm dev` first: only one process can open a PGlite directory.
 */
import ecom from "../../ecom.config.ts";
import { createPlatform } from "../platform.ts";
import { seedDemoOrders } from "./demo-orders.ts";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo orders with NODE_ENV=production.");
  process.exit(1);
}

const platform = await createPlatform({ migrate: true, plugins: ecom.plugins });
try {
  const { placed, skipped } = await seedDemoOrders(platform, Number(process.argv[2] ?? 80));
  console.log(`Placed ${placed} demo orders${skipped.length ? `; skipped ${skipped.length} (${[...new Set(skipped)].slice(0, 3).join("; ")})` : ""}.`);
} catch (error) {
  console.error(`${(error as Error).message} Run pnpm db:seed first.`);
  process.exitCode = 1;
} finally {
  await platform.database.close();
}
