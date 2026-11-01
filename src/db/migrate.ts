import ecom from "../../ecom.config.ts";
import { applyPluginMigrations } from "../modules/plugins/migrations.ts";
import { validatePluginDefinitions } from "../modules/plugins/registry.ts";
import { createDatabase } from "./client.ts";

validatePluginDefinitions(ecom.plugins);
const handle = await createDatabase(process.env.DATABASE_URL);
await handle.migrate();
const plugins = await applyPluginMigrations(handle.db, ecom.plugins);
console.log(`Migrations applied (${handle.kind})${plugins.length ? `, with plugin migrations ${plugins.join(", ")}` : ""}.`);
await handle.close();
