import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outboxEvents, webhookDeliveries, webhookSubscriptions } from "../../src/modules/integrations/tables.ts";
import { deliverDueWebhooks } from "../../src/modules/integrations/webhooks.ts";
import { createTestPlatform, type TestPlatform } from "../helpers/platform.ts";

let t: TestPlatform;
let port: number;
const requests: string[] = [];
const receiver = createServer((req, res) => {
  requests.push(req.url!);
  res.writeHead(req.url === "/moved" ? 307 : 204, req.url === "/moved" ? { location: "/hook" } : {}).end();
});
const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOK_URLS;

beforeAll(async () => {
  t = await createTestPlatform();
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  port = (receiver.address() as AddressInfo).port;
});
beforeEach(() => {
  delete process.env.ALLOW_PRIVATE_WEBHOOK_URLS;
  requests.length = 0;
});
afterAll(async () => {
  if (allowPrivate === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_URLS;
  else process.env.ALLOW_PRIVATE_WEBHOOK_URLS = allowPrivate;
  receiver.close();
  await t.close();
});

/** Stored without the check made when a subscription is saved, as if its host resolved elsewhere then. */
const deliver = async (url: string) => {
  const { db } = t.platform;
  const [subscription] = await db.insert(webhookSubscriptions).values({ name: url, url, secret: "whsec_test", events: ["*"] }).returning();
  const [event] = await db.insert(outboxEvents).values({ type: "customer.updated", aggregateType: "Customer", aggregateId: t.seed.customer.id }).returning();
  const [delivery] = await db.insert(webhookDeliveries).values({ subscriptionId: subscription!.id, eventId: event!.id, eventType: event!.type }).returning();
  await deliverDueWebhooks(db, { timeoutMs: 5000, maxAttempts: 3, batchSize: 10 });
  return db.query.webhookDeliveries.findFirst({ where: eq(webhookDeliveries.id, delivery!.id) });
};

describe("webhook delivery targets", () => {
  it("refuses a host that resolves to a private address, and private IP literals", async () => {
    for (const url of [`http://localhost:${port}/hook`, `http://127.0.0.1:${port}/hook`]) {
      expect(await deliver(url), url).toMatchObject({ status: "failed", lastStatusCode: null, lastError: expect.stringMatching(/not a public address/) });
    }
    expect(requests).toEqual([]);
  });

  it("reaches private addresses with ALLOW_PRIVATE_WEBHOOK_URLS=true, and never follows redirects", async () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_URLS = "true";
    expect(await deliver(`http://localhost:${port}/hook`)).toMatchObject({ status: "succeeded", lastStatusCode: 204 });
    expect(await deliver(`http://127.0.0.1:${port}/moved`)).toMatchObject({ status: "failed", lastStatusCode: 307, lastError: "HTTP 307" });
    expect(requests).toEqual(["/hook", "/moved"]);
  });
});
