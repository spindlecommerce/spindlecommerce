import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve graphql as Node does. Under the `development` condition Vite would load graphql 17's
  // dev build for source files while Pothos and Yoga get the default one: two graphql instances.
  ssr: { resolve: { conditions: ["module", "node", "production"] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run npm-installed plugins through Vite so they share the platform's plugin SDK
    // (packages/plugin-sdk). Loaded by Node, they would get a second copy of its classes.
    server: { deps: { inline: [/@spindlecommerce\//] } },
  },
});
