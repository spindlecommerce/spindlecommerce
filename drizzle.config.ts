import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/modules/*/tables.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
});
