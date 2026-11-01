import { describe, expect, it } from "vitest";
import { getSchema } from "../../src/graphql/schema.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";
import { kitchenSink } from "../fixtures/plugins/kitchen-sink/index.ts";

const signIn = async (app: Awaited<ReturnType<typeof createTestApp>>) => {
  const login = await app.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  return bearer(login.data.staffLogin.session.accessToken);
};

describe("plugin GraphQL registration", () => {
  it("rebuilds a schema built without the plugin, and keeps the fields for later platforms", async () => {
    // The builder is a module singleton: a schema built before any plugin registered has no plugin fields.
    expect(getSchema("admin").getQueryType()!.getFields().kitchenSinkGreeting).toBeUndefined();

    const withPlugin = await createTestApp({ plugins: [kitchenSink()], env: { KITCHEN_SINK_API_KEY: "key", KITCHEN_SINK_GREETING: "registered" } });
    try {
      expect(getSchema("admin").getQueryType()!.getFields().kitchenSinkGreeting).toBeDefined();
      expect((await withPlugin.admin(`{ kitchenSinkGreeting }`, {}, await signIn(withPlugin))).data.kitchenSinkGreeting).toBe("registered");
    } finally {
      await withPlugin.close();
    }

    // A later platform without the plugin keeps the field (fields cannot be removed), which then fails clearly.
    const without = await createTestApp();
    try {
      const result = await without.admin(`{ kitchenSinkGreeting }`, {}, await signIn(without));
      expect(result.errors?.[0]).toMatchObject({ message: "No plugin named kitchen-sink is installed", extensions: { code: "INVALID_STATE" } });
    } finally {
      await without.close();
    }
  });
});
