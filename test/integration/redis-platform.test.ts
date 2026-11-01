import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { seedDemoData } from "../../src/db/seed-data.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { createPlatform } from "../../src/platform.ts";
import { FakeRedisServer } from "../helpers/fake-redis.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

/** Two instances of the API (two platforms, one database) sharing a Redis, as on Vercel. */
const server = new FakeRedisServer();
let api: App;
let worker: App;

beforeAll(async () => {
  const config = loadConfig({ JWT_SECRET: "test-secret-test-secret-test-secret", NODE_ENV: "test", DATABASE_URL: "memory:", MEDIA_DIR: join(tmpdir(), "ecom-test-media"), ADMIN_APP_DIR: "", REDIS_URL: "redis://redis.test:6379" });
  expect(config.graphql.responseCache).toBe("redis");
  const first = await createPlatform({ config, logger: pino({ level: "silent" }), migrate: true, redis: server.connection("db:").connection });
  await seedDemoData(first, TEST_CREDENTIALS);
  api = await createApp({ platform: first });
  const second = await createPlatform({ config, logger: pino({ level: "silent" }), database: first.database, redis: server.connection("db:").connection });
  worker = await createApp({ platform: second });
});
afterAll(() => api.close());

const post = async (app: App, path: string, query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<any> => {
  const response = await app.fetch(new Request(`https://ecom.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query, variables }) }));
  return response.json();
};

describe("API instances sharing Redis", () => {
  it("serve each other's cached responses, and one worker's invalidation clears them for all", async () => {
    const query = `{ product(slug: "market-tote") { id name } }`;
    await post(api, "/graphql", query);
    const fromOther = await post(worker, "/graphql", query);
    expect(fromOther.extensions?.responseCache?.hit).toBe(true);

    const login = await post(api, "/admin/graphql", `mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
    const auth = { authorization: `Bearer ${login.data.staffLogin.session.accessToken}` };
    await post(api, "/admin/graphql", `mutation($id: ID!) { productUpdate(id: $id, input: { translations: [{ locale: "en-US", name: "Market Tote Bag", slug: "market-tote" }] }) { __typename } }`, { id: fromOther.data.product.id }, auth);

    // The other instance's worker clears the shared cache before returning, and so before webhooks.
    while ((await processOutbox(worker.platform)) > 0);
    const fresh = await post(api, "/graphql", query);
    expect(fresh.extensions?.responseCache?.hit).toBe(false);
    expect(fresh.data.product.name).toBe("Market Tote Bag");
  });

  it("deliver subscription events published by another instance's worker", async () => {
    const updates = api.platform.pubsub.subscribe("orderActivity");
    const next = updates.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const update = { orderId: "o1", type: "order.placed", status: "pending", paymentStatus: "authorized", fulfillmentStatus: "unfulfilled", occurredAt: new Date(0).toISOString() };
    worker.platform.pubsub.publish("orderActivity", update);
    expect((await next).value).toEqual(update);
    await updates.return();
  });
});
