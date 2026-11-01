import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { emit, requestOutboxDrain, trackOutboxWrites } from "../../src/modules/integrations/outbox.ts";
import { createWebhookSubscription, deliverDueWebhooks } from "../../src/modules/integrations/webhooks.ts";
import { authorizeWorkerRequest, processOutbox } from "../../src/modules/integrations/worker.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

const CRON_SECRET = "cron-secret-cron-secret-cron-secret";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  t.platform.config.worker.cronSecret = CRON_SECRET;
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

const graphql = (path: string, query: string, headers: Record<string, string> = {}) =>
  new Request(`https://ecom.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query }) });

describe("worker route authorization", () => {
  const production = { production: true, worker: { cronSecret: CRON_SECRET } };

  it("accepts exactly Bearer <CRON_SECRET>", () => {
    expect(authorizeWorkerRequest(`Bearer ${CRON_SECRET}`, production)).toBeNull();
    expect(authorizeWorkerRequest(`bearer ${CRON_SECRET}`, production)).toBeNull();
    for (const header of [undefined, "", `Bearer ${CRON_SECRET}x`, `Bearer ${CRON_SECRET.slice(1)}`, CRON_SECRET, "Basic abc", "Bearer "]) {
      expect(authorizeWorkerRequest(header, production)?.status, String(header)).toBe(401);
    }
  });

  it("refuses everyone in production without a secret, and lets development run it", () => {
    expect(authorizeWorkerRequest(`Bearer anything`, { production: true, worker: { cronSecret: undefined } })).toMatchObject({ status: 403 });
    expect(authorizeWorkerRequest(undefined, { production: false, worker: { cronSecret: undefined } })).toBeNull();
    // A configured secret applies in development too.
    expect(authorizeWorkerRequest(undefined, { production: false, worker: { cronSecret: CRON_SECRET } })?.status).toBe(401);
  });

  it("runs one tick for Vercel Cron's GET and reports it", async () => {
    expect((await t.app.fetch(new Request("https://ecom.test/internal/worker"))).status).toBe(401);
    expect((await t.app.fetch(new Request("https://ecom.test/internal/worker", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    for (const method of ["GET", "POST"]) {
      const response = await t.app.fetch(new Request("https://ecom.test/internal/worker", { method, headers: { authorization: `Bearer ${CRON_SECRET}` } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ ok: true, published: { pages: 0, releases: 0 }, events: expect.any(Number), webhooks: { delivered: 0, failed: 0 } });
    }
  });
});

describe("drains after requests", () => {
  const tracked = async (request: Request) => (await trackOutboxWrites(async () => t.app.fetch(request))).drain;

  it("asks for a drain after requests that write outbox events or run admin mutations", async () => {
    expect(await tracked(graphql("/graphql", `{ products(first: 1) { totalCount } }`, { "x-channel": "us" }))).toBe(false);
    expect(await tracked(graphql("/graphql", `mutation { cartCreate(input: { lines: [] }) { __typename } }`, { "x-channel": "us" }))).toBe(false);
    // Emits customer.password_reset_requested, which the email plugin sends.
    expect(await tracked(graphql("/graphql", `mutation { customerPasswordResetRequest(email: "${TEST_CREDENTIALS.customerEmail}") { __typename } }`, { "x-channel": "us" }))).toBe(true);
    // Any admin mutation (a retried webhook delivery writes no event).
    expect(await tracked(graphql("/admin/graphql", `mutation { webhookSubscriptionCreate(name: "Drain test", url: "https://hooks.example.com/drain", events: ["page.*"]) { __typename } }`, auth))).toBe(true);
    expect(await tracked(graphql("/admin/graphql", `{ channels { code } }`, auth))).toBe(false);
  });

  it("is a no-op outside a tracked request, as in a long-running server", () => {
    expect(() => requestOutboxDrain()).not.toThrow();
  });
});

describe("webhook delivery across instances", () => {
  it("sends each delivery once when several workers run at the same time", async () => {
    while ((await processOutbox(t.platform)) > 0);
    await deliverDueWebhooks(t.platform.db, { fetch: async () => ({ status: 204 }), timeoutMs: 1000, maxAttempts: 3, batchSize: 1000 });
    await createWebhookSubscription(t.platform.db, { name: "Concurrent", url: "https://hooks.example.com/concurrent", events: ["customer.*"] });
    for (let i = 0; i < 6; i++) {
      await emit(t.platform.db, { type: "customer.updated", aggregateType: "Customer", aggregateId: "0192f0a0-0000-7000-8000-00000000000" + i });
    }
    while ((await processOutbox(t.platform)) > 0);

    const sent: string[] = [];
    const fetch = async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers["x-spindle-delivery"]!);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 204 };
    };
    const workers = await Promise.all([1, 2, 3].map(() => deliverDueWebhooks(t.platform.db, { fetch, timeoutMs: 1000, maxAttempts: 3, batchSize: 100 })));
    expect(workers.reduce((sum, w) => sum + w.delivered, 0)).toBe(6);
    expect(sent).toHaveLength(6);
    expect(new Set(sent).size).toBe(6);
  });

  it("stops at the deadline and leaves the rest due", async () => {
    await emit(t.platform.db, { type: "customer.updated", aggregateType: "Customer", aggregateId: "0192f0a0-0000-7000-8000-000000000010" });
    while ((await processOutbox(t.platform)) > 0);
    const stopped = await deliverDueWebhooks(t.platform.db, { fetch: async () => ({ status: 204 }), timeoutMs: 1000, maxAttempts: 3, batchSize: 100, deadline: Date.now() - 1 });
    expect(stopped).toEqual({ delivered: 0, failed: 0 });
    const later = await deliverDueWebhooks(t.platform.db, { fetch: async () => ({ status: 204 }), timeoutMs: 1000, maxAttempts: 3, batchSize: 100 });
    expect(later.delivered).toBe(1);
  });
});

describe("admin page", () => {
  it("carries a per-request CSP that frames storefronts and allows direct uploads to storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ecom-admin-"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
    const previous = process.env.BLOB_READ_WRITE_TOKEN;
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store_secret";
    try {
      // As on Vercel: the function has the page, the CDN has the assets.
      const app = await createApp({ platform: { ...t.platform, config: { ...t.platform.config, production: true, admin: { ...t.platform.config.admin, appDir: dir } } } });
      for (const path of ["/admin/", "/admin/products/123", "/admin/index.html"]) {
        const response = await app.fetch(new Request(`https://ecom.test${path}`));
        expect(response.status, path).toBe(200);
        const csp = response.headers.get("content-security-policy") ?? "";
        expect(csp, path).toContain("connect-src 'self' https://vercel.com;");
        // The seeded storefront, registered under Settings › Storefronts.
        expect(csp, path).toContain("frame-src 'self' http://localhost:3000;");
      }
      expect((await app.fetch(new Request("https://ecom.test/admin/assets/index-old.js"))).status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
      else process.env.BLOB_READ_WRITE_TOKEN = previous;
    }
  });
});
