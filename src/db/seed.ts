import ecom from "../../ecom.config.ts";
import { createPlatform } from "../platform.ts";
import { channels } from "../modules/channels/tables.ts";
import { seedBuilderIntoExisting, seedSectionsIntoExisting, seedTemplatesIntoExisting } from "./seed-builder.ts";
import { seedDemoData } from "./seed-data.ts";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data with NODE_ENV=production.");
  process.exit(1);
}

const credentials = {
  adminEmail: process.env.SEED_ADMIN_EMAIL ?? "admin@example.com",
  adminPassword: process.env.SEED_ADMIN_PASSWORD ?? "dev-admin-password-123",
  customerEmail: process.env.SEED_CUSTOMER_EMAIL ?? "alex@example.com",
  customerPassword: process.env.SEED_CUSTOMER_PASSWORD ?? "dev-customer-password-123",
};

const platform = await createPlatform({ migrate: true, plugins: ecom.plugins });
if ((await platform.db.$count(channels)) > 0) {
  console.log("Database already has channels; skipping seed.");
  // Databases seeded before the page builder existed get its demo library and pages.
  if (await seedBuilderIntoExisting(platform.db)) console.log("Added the page builder demo: components, home, sale and about pages, header and footer.");
  // Before the templates: the template types must allow the section slots first.
  if (await seedSectionsIntoExisting(platform.db)) console.log("Added product and category sections, with their slots in the templates.");
  if (await seedTemplatesIntoExisting(platform.db)) console.log("Added product and category page templates.");
} else {
  const started = Date.now();
  const result = await seedDemoData(platform, credentials);
  console.log(`Seeded ${Object.keys(result.products).length} products, 2 channels, staff ${credentials.adminEmail} and customer ${credentials.customerEmail} in ${Date.now() - started} ms.`);
}
await platform.database.close();
