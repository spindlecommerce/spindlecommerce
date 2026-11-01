import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerCustomer } from "../../src/modules/customers/service.ts";
import { outboxEvents } from "../../src/modules/integrations/tables.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { deliverDuePluginEvents } from "../../src/modules/plugins/events.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginErrorReport } from "../../src/plugins/sdk.ts";
import { createTestApp } from "../helpers/app.ts";
import { kitchenSink } from "../fixtures/plugins/kitchen-sink/index.ts";

const reports: PluginErrorReport[] = [];

/** Collects what onError receives; its handler for new customers always fails. */
const reporter = () =>
  definePlugin({
    name: "reporter",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Reporter",
    hooks: { onError: (report) => void reports.push(report) },
    events: {
      "customer.created": async () => {
        throw new Error("The CRM is down");
      },
    },
  });

/** An error tracker that is down: its failures must not stop the others or be reported again. */
const brokenReporter = () =>
  definePlugin({
    name: "broken-reporter",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Broken reporter",
    hooks: {
      onError: () => {
        throw new Error("The tracker is down");
      },
    },
  });

let t: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  t = await createTestApp({ plugins: [kitchenSink(), reporter(), brokenReporter()], env: { KITCHEN_SINK_API_KEY: "key" } });
});
afterAll(() => t.close());

describe("onError hooks", () => {
  it("receive an unexpected error with where it happened, even when another hook fails", async () => {
    const boom = await t.app.fetch(new Request("http://ecom.test/plugins/kitchen-sink/boom"));
    expect(boom.status).toBe(500);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatchObject({
      source: "route",
      plugin: "kitchen-sink",
      error: { name: "Error", message: "boom", stack: expect.stringContaining("Error: boom") },
      details: { method: "GET", path: "/plugins/kitchen-sink/boom" },
      occurredAt: expect.any(Date),
    });
  });

  it("receive failing plugin event handlers", async () => {
    const customer = await registerCustomer(t.platform.db, { email: "crm@example.test", password: "a long enough password", firstName: "Sam", lastName: "Lee" });
    while ((await processOutbox(t.platform)) > 0);
    await deliverDuePluginEvents(t.platform);
    // The seeded customer's event fails too; this one is the new customer's.
    const [event] = await t.platform.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, "customer.created"), eq(outboxEvents.aggregateId, customer.id)));
    const reported = () => reports.find((r) => r.details.eventId === event!.id);
    await vi.waitFor(() => expect(reported()).toBeDefined());
    expect(reported()).toMatchObject({ source: "plugin-event", plugin: "reporter", error: { message: "The CRM is down" }, details: { eventType: "customer.created", attempt: 1 } });
  });

  it("are not given expected errors", async () => {
    reports.length = 0;
    const result = await t.storefront(`{ products(first: 1, after: "not-a-cursor") { edges { node { id } } } }`);
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reports.filter((r) => r.source === "graphql")).toEqual([]);
  });
});
