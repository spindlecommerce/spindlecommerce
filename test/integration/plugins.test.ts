import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryRows } from "../../src/db/query.ts";
import { InvalidStateError, ValidationError } from "../../src/lib/errors.ts";
import { newId } from "../../src/lib/ids.ts";
import { auditLog } from "../../src/modules/audit/tables.ts";
import { quoteProviders, buildQuote } from "../../src/modules/carts/quote.ts";
import { createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { placeOrder } from "../../src/modules/checkout/service.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { capturePayment } from "../../src/modules/orders/service.ts";
import { orderEvents } from "../../src/modules/orders/tables.ts";
import { createPaymentMethod } from "../../src/modules/payments/service.ts";
import { deliverDuePluginEvents } from "../../src/modules/plugins/events.ts";
import { applyPluginMigrations } from "../../src/modules/plugins/migrations.ts";
import { pluginEventDeliveries, pluginKv, pluginMigrations, pluginSettings } from "../../src/modules/plugins/tables.ts";
import { runDuePluginTasks } from "../../src/modules/plugins/tasks.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { createTestPlatform, TEST_CREDENTIALS } from "../helpers/platform.ts";
import { brokenHook, kitchenSink } from "../fixtures/plugins/kitchen-sink/index.ts";
import { orderAlerts } from "../fixtures/plugins/order-alerts/index.ts";

const WEBHOOK = "https://chat.example.test/hooks/abc";
const CA_ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const guest = { customerId: null };
const staff = { type: "staff" as const, id: null };

/** What plugins sent through platform.fetch. */
const sent: { url: string; body: any }[] = [];
const fetchStub: typeof fetch = async (input, init) => {
  sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
  return new Response("ok", { status: 200 });
};

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp({ plugins: [kitchenSink(), brokenHook(), orderAlerts()], fetch: fetchStub, env: { ORDER_ALERTS_WEBHOOK_URL: WEBHOOK, WEBHOOK_MAX_ATTEMPTS: "3" } });
  // The seed's events, while the kitchen sink is not configured yet: it receives none of them.
  while ((await processOutbox(t.platform)) > 0);
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

const admin = <T = any>(query: string, variables?: Record<string, unknown>) => t.admin<T>(query, variables, auth);
const update = (input: Record<string, unknown>) =>
  admin(
    `mutation($input: PluginUpdateInput!) { pluginUpdate(name: "kitchen-sink", input: $input) {
      __typename
      ... on PluginUpdatePayload { plugin { enabled configured active missingSettings settings { key value isSet source } } }
      ... on ValidationError { fieldErrors { path message } }
    } }`,
    { input },
  );
const route = (path: string, init?: RequestInit) => t.app.fetch(new Request(`http://ecom.test/plugins/kitchen-sink${path}`, init));
const drain = async () => {
  while ((await processOutbox(t.platform)) > 0);
};

const readyCart = async (email: string, payment = "card") => {
  const db = t.platform.db;
  const cart = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { email, lines: [{ sku: "TEE-BLACK-M", quantity: 5 }] });
  await setCartShippingAddress(db, cart.id, { address: CA_ADDRESS }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  await setCartShippingMethod(db, cart.id, "us_standard", guest);
  await setCartPaymentMethod(db, cart.id, payment, guest, quoteProviders(t.platform));
  return cart;
};

describe("plugin management API", () => {
  it("lists installed plugins with their settings, capabilities and state", async () => {
    const result = await admin(`{ plugins {
      name title version enabled configured active missingSettings hasAdmin canCheck
      settings { key label type required value isSet source env options { value label } placeholder multiline min max integer }
      capabilities { events hooks paymentProviders shippingProviders emits graphql routes tasks migrations admin }
      permissions { code description plugin pluginTitle }
      tasks { name description intervalMinutes lastStatus }
    } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.plugins.map((p: { name: string }) => p.name)).toEqual(["kitchen-sink", "broken-hook", "order-alerts"]);
    const sink = result.data.plugins[0];
    expect(sink).toMatchObject({ title: "Kitchen sink", version: "0.1.0", enabled: true, configured: false, active: false, missingSettings: ["apiKey"], hasAdmin: false, canCheck: true });
    expect(sink.settings).toEqual([
      { key: "apiKey", label: "API key", type: "SECRET", required: true, value: null, isSet: false, source: "UNSET", env: "KITCHEN_SINK_API_KEY", options: null, placeholder: null, multiline: null, min: null, max: null, integer: null },
      { key: "greeting", label: "Greeting", type: "STRING", required: false, value: "hello", isSet: true, source: "DEFAULT", env: "KITCHEN_SINK_GREETING", options: null, placeholder: null, multiline: false, min: null, max: null, integer: null },
      { key: "rate", label: "Rate", type: "NUMBER", required: false, value: 500, isSet: true, source: "DEFAULT", env: null, options: null, placeholder: null, multiline: null, min: 0, max: null, integer: true },
      { key: "mode", label: "Mode", type: "SELECT", required: false, value: "test", isSet: true, source: "DEFAULT", env: null, options: [{ value: "test", label: "Test" }, { value: "live", label: "Live" }], placeholder: null, multiline: null, min: null, max: null, integer: null },
      { key: "verbose", label: "Verbose", type: "BOOLEAN", required: false, value: false, isSet: true, source: "DEFAULT", env: null, options: null, placeholder: null, multiline: null, min: null, max: null, integer: null },
      { key: "note", label: "Note", type: "STRING", required: false, value: null, isSet: false, source: "UNSET", env: null, options: null, placeholder: null, multiline: true, min: null, max: null, integer: null },
    ]);
    expect(sink.capabilities).toEqual({
      events: ["order.placed", "kitchen-sink.*"],
      hooks: ["checkoutValidate"],
      paymentProviders: ["kitchen_pay"],
      shippingProviders: ["kitchen_ship"],
      emits: ["kitchen-sink.pinged"],
      graphql: true,
      routes: true,
      tasks: ["count"],
      migrations: true,
      admin: false,
    });
    expect(sink.permissions).toEqual([{ code: "kitchen-sink:use", description: "Read the kitchen sink's greeting", plugin: "kitchen-sink", pluginTitle: "Kitchen sink" }]);
    expect(sink.tasks).toEqual([{ name: "count", description: "Counts its runs.", intervalMinutes: 60, lastStatus: null }]);
    // Configured by its environment variable, which the admin shows but cannot change.
    const alerts = result.data.plugins[2];
    expect(alerts).toMatchObject({ active: true, missingSettings: [] });
    expect(alerts.settings[0]).toMatchObject({ key: "webhookUrl", value: null, isSet: true, source: "ENV" });
    expect(JSON.stringify(result.data)).not.toContain(WEBHOOK);
  });

  it("validates settings with field paths", async () => {
    const result = await update({ settings: { apiKey: "good-key", rate: -1, mode: "mars", nope: true } });
    expect(result.data.pluginUpdate.__typename).toBe("ValidationError");
    expect(result.data.pluginUpdate.fieldErrors.map((e: { path: string[] }) => e.path)).toEqual([
      ["input", "settings", "nope"],
      ["input", "settings", "rate"],
      ["input", "settings", "mode"],
    ]);
    expect((await t.platform.plugins.status("kitchen-sink")).configured).toBe(false);
  });

  it("stores settings, sealing secrets, and never returns or logs them", async () => {
    const result = await update({ settings: { apiKey: "good-key", greeting: "hi", rate: "750" } });
    expect(result.errors).toBeUndefined();
    const plugin = result.data.pluginUpdate.plugin;
    expect(plugin).toMatchObject({ enabled: true, configured: true, active: true, missingSettings: [] });
    expect(plugin.settings.slice(0, 3)).toEqual([
      { key: "apiKey", value: null, isSet: true, source: "ADMIN" },
      { key: "greeting", value: "hi", isSet: true, source: "ADMIN" },
      { key: "rate", value: 750, isSet: true, source: "ADMIN" },
    ]);
    const [row] = await t.platform.db.select().from(pluginSettings).where(eq(pluginSettings.plugin, "kitchen-sink"));
    expect(row!.values).toEqual({ greeting: "hi", rate: 750 });
    expect(row!.secrets).toMatch(/^v1\./);
    expect(row!.secrets).not.toContain("good-key");
    const [entry] = await t.platform.db.select().from(auditLog).where(eq(auditLog.operation, "pluginUpdate")).orderBy(sql`${auditLog.id} desc`).limit(1);
    expect(entry!.input).toMatchObject({ name: "kitchen-sink", input: { settings: { apiKey: "[redacted]", greeting: "hi" } } });
    const listed = await admin(`{ plugin(name: "kitchen-sink") { settings { key value isSet } } }`);
    expect(JSON.stringify(listed)).not.toContain("good-key");
    // Plugin code sees the opened value.
    expect((await t.platform.plugins.context("kitchen-sink")).settings).toMatchObject({ apiKey: "good-key", greeting: "hi", rate: 750, mode: "test", verbose: false });
  });

  it("keeps a secret on an empty string and clears with null", async () => {
    expect((await update({ settings: { apiKey: "", note: "kept" } })).data.pluginUpdate.plugin).toMatchObject({ active: true });
    const cleared = (await update({ settings: { apiKey: null } })).data.pluginUpdate.plugin;
    expect(cleared).toMatchObject({ configured: false, active: false, missingSettings: ["apiKey"] });
    await expect(t.platform.plugins.context("kitchen-sink")).rejects.toThrow(/not active: it is not configured \(missing API key\)/);
    expect((await update({ settings: { apiKey: "good-key", note: null } })).data.pluginUpdate.plugin).toMatchObject({ active: true });
  });

  it("runs the connection check", async () => {
    const check = `mutation { pluginCheck(name: "kitchen-sink") { __typename ... on PluginCheckPayload { ok message } ... on InvalidStateError { message } } }`;
    expect((await admin(check)).data.pluginCheck).toEqual({ __typename: "PluginCheckPayload", ok: true, message: "Connected in test mode" });
    await update({ settings: { apiKey: "wrong-key" } });
    expect((await admin(check)).data.pluginCheck).toEqual({ __typename: "PluginCheckPayload", ok: false, message: "The API key was refused" });
    await update({ settings: { apiKey: "good-key" } });
    const none = await admin(`mutation { pluginCheck(name: "broken-hook") { __typename ... on InvalidStateError { message } } }`);
    expect(none.data.pluginCheck).toEqual({ __typename: "InvalidStateError", message: "The plugin broken-hook has no connection check" });
  });

  it("reports active plugins to every staff user, and makes plugin permissions grantable", async () => {
    const result = await admin(`{ activePlugins permissions pluginPermissions { code pluginTitle } }`);
    expect(result.data.activePlugins).toEqual(["kitchen-sink", "broken-hook", "order-alerts"]);
    expect(result.data.permissions).toEqual(expect.arrayContaining(["orders:read", "kitchen-sink:use", "order-alerts:read"]));
    expect(result.data.pluginPermissions).toEqual([
      { code: "kitchen-sink:use", pluginTitle: "Kitchen sink" },
      { code: "order-alerts:read", pluginTitle: "Order alerts" },
    ]);
    const role = await admin(`mutation { roleCreate(code: "greeter", name: "Greeter", permissions: ["kitchen-sink:use"]) { __typename ... on RolePayload { role { permissions } } } }`);
    expect(role.data.roleCreate).toEqual({ __typename: "RolePayload", role: { permissions: ["kitchen-sink:use"] } });
    const unknown = await admin(`mutation { roleCreate(code: "nobody", name: "Nobody", permissions: ["kitchen-sink:delete"]) { __typename } }`);
    expect(unknown.data.roleCreate.__typename).toBe("ValidationError");
  });

  it("lets webhooks subscribe to plugin events", async () => {
    expect((await admin(`{ eventTypes }`)).data.eventTypes).toEqual(expect.arrayContaining(["order.placed", "kitchen-sink.pinged", "order-alerts.sent"]));
    const created = await admin(`mutation { webhookSubscriptionCreate(name: "Pings", url: "https://hooks.example.com/pings", events: ["kitchen-sink.*"]) { __typename } }`);
    expect(created.data.webhookSubscriptionCreate.__typename).toBe("WebhookSubscriptionCreatePayload");
  });
});

describe("plugin routes", () => {
  it("serve under /plugins/<name>/ and answer 503 while the plugin is inactive", async () => {
    const ping = await route("/ping");
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: "hi" });
    expect((await update({ enabled: false })).data.pluginUpdate.plugin).toMatchObject({ enabled: false, configured: true, active: false });
    const off = await route("/ping");
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: { code: "PLUGIN_UNAVAILABLE", message: "The kitchen-sink plugin is not active" } });
    expect((await update({ enabled: true })).data.pluginUpdate.plugin.active).toBe(true);
    expect((await route("/ping")).status).toBe(200);
  });

  it("turn a throwing handler into a 500 and leave other paths alone", async () => {
    const boom = await route("/boom");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toMatchObject({ error: { code: "INTERNAL_SERVER_ERROR" } });
    expect((await t.app.fetch(new Request("http://ecom.test/plugins/nobody/ping"))).status).toBe(404);
  });
});

describe("plugin GraphQL", () => {
  it("adds fields to the admin API that resolve with the plugin's context", async () => {
    expect((await admin(`{ kitchenSinkGreeting }`)).data.kitchenSinkGreeting).toBe("hi");
    // Admin only: the storefront schema does not have it.
    const storefront = await t.storefront(`{ kitchenSinkGreeting }`, {}, { "x-channel": "us" });
    expect(storefront.errors?.[0]?.message).toMatch(/Cannot query field "kitchenSinkGreeting"/);
    await update({ enabled: false });
    const off = await admin(`{ kitchenSinkGreeting }`);
    expect(off.errors?.[0]?.extensions?.code).toBe("INVALID_STATE");
    await update({ enabled: true });
  });
});

describe("plugin kv store", () => {
  it("gets, sets, adds, lists and deletes in the plugin's namespace", async () => {
    const { kv } = await t.platform.plugins.context("kitchen-sink");
    const other = (await t.platform.plugins.context("order-alerts")).kv;
    await kv.set("a_1", { n: 1 });
    await kv.set("a_2", [2]);
    await kv.set("ab", "x");
    expect(await kv.get("a_1")).toEqual({ n: 1 });
    expect(await other.get("a_1")).toBeNull();
    expect(await kv.add("a_1", "again")).toBe(false);
    expect(await kv.add("a_3", 3)).toBe(true);
    // The prefix is literal: _ is not a wildcard.
    expect((await kv.list("a_")).map((e) => e.key)).toEqual(["a_1", "a_2", "a_3"]);
    expect(await kv.list("a_", { limit: 1 })).toEqual([{ key: "a_1", value: { n: 1 } }]);
    await kv.delete("a_1");
    expect(await kv.get("a_1")).toBeNull();
    await expect(kv.set("nothing", undefined)).rejects.toThrow(/use kv.delete/);
  });

  it("ignores expired entries, which add may then take", async () => {
    const { kv } = await t.platform.plugins.context("kitchen-sink");
    await kv.set("lease", "first", { ttlSeconds: 60 });
    expect(await kv.add("lease", "second")).toBe(false);
    await t.platform.db.update(pluginKv).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(pluginKv.plugin, "kitchen-sink"), eq(pluginKv.key, "lease")));
    expect(await kv.get("lease")).toBeNull();
    expect(await kv.list("lease")).toEqual([]);
    expect(await kv.add("lease", "second")).toBe(true);
    expect(await kv.get("lease")).toBe("second");
  });

  it("runs a once() function once per key, and again after it throws", async () => {
    const ctx = await t.platform.plugins.context("kitchen-sink");
    let runs = 0;
    expect(await ctx.once("welcome:1", async () => void runs++)).toBe(true);
    expect(await ctx.once("welcome:1", async () => void runs++)).toBe(false);
    expect(runs).toBe(1);
    await expect(ctx.once("welcome:2", async () => Promise.reject(new Error("mail server down")))).rejects.toThrow("mail server down");
    expect(await ctx.once("welcome:2", async () => void runs++)).toBe(true);
    expect(runs).toBe(2);
  });
});

describe("plugin events", () => {
  it("delivers committed events to active plugins' handlers, once per handler", async () => {
    sent.length = 0;
    const cart = await readyCart("sam@example.test");
    const order = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "plugins-1" }, guest);
    await drain();
    const deliveries = await t.platform.db.select().from(pluginEventDeliveries).where(eq(pluginEventDeliveries.status, "pending"));
    expect(deliveries.map((d) => `${d.plugin} ${d.handler}`).sort()).toEqual(["kitchen-sink order.placed", "order-alerts order.placed"]);
    expect(await deliverDuePluginEvents(t.platform)).toEqual({ delivered: 2, failed: 0 });
    const ctx = await t.platform.plugins.context("kitchen-sink");
    expect(await ctx.kv.get(`seen:${deliveries[0]!.eventId}`)).toEqual({ type: "order.placed", orderId: order.id });
    // The example plugin posted the order to its webhook, once, and emitted its own event.
    expect(sent).toEqual([{ url: WEBHOOK, body: { text: expect.stringContaining(`Order ${order.number}:`) } }]);
    await drain();
    const [emitted] = await queryRows<{ type: string }>(t.platform.db, sql`select type from outbox_events where type = 'order-alerts.sent' and aggregate_id = ${order.id}`);
    expect(emitted?.type).toBe("order-alerts.sent");
    // A redelivery (at least once) does not post again.
    await t.platform.db.update(pluginEventDeliveries).set({ status: "pending" }).where(eq(pluginEventDeliveries.plugin, "order-alerts"));
    await deliverDuePluginEvents(t.platform);
    expect(sent).toHaveLength(1);
    const alerted = await admin(`query($n: String!) { order(number: $n) { alertSentAt } }`, { n: order.number });
    expect(alerted.data.order.alertSentAt).toEqual(expect.any(String));
  });

  it("retries a failing handler with backoff until it gives up, and retries on request", async () => {
    const response = await route("/emit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: newId(), fail: true }) });
    expect(response.status).toBe(202);
    await drain();
    const [delivery] = await t.platform.db.select().from(pluginEventDeliveries).where(eq(pluginEventDeliveries.handler, "kitchen-sink.*"));
    expect(delivery).toMatchObject({ plugin: "kitchen-sink", status: "pending", attempts: 0 });
    // Each round runs at a time past the previous backoff (at most six hours).
    const at = (round: number) => new Date(Date.now() + round * 7 * 3600_000);
    expect(await deliverDuePluginEvents(t.platform, { now: at(0) })).toEqual({ delivered: 0, failed: 1 });
    expect(await deliverDuePluginEvents(t.platform, { now: at(0) })).toEqual({ delivered: 0, failed: 0 });
    await deliverDuePluginEvents(t.platform, { now: at(1) });
    await deliverDuePluginEvents(t.platform, { now: at(2) });
    const [dead] = await t.platform.db.select().from(pluginEventDeliveries).where(eq(pluginEventDeliveries.id, delivery!.id));
    expect(dead).toMatchObject({ status: "dead", attempts: 3, lastError: "the remote service is down" });

    const listed = await admin(`{ plugin(name: "kitchen-sink") { deliveries(status: DEAD) { id eventType handler status attempts lastError nextAttemptAt } } }`);
    expect(listed.data.plugin.deliveries).toEqual([
      { id: `gid://ecom/PluginDelivery/${delivery!.id}`, eventType: "kitchen-sink.pinged", handler: "kitchen-sink.*", status: "DEAD", attempts: 3, lastError: "the remote service is down", nextAttemptAt: null },
    ]);
    const retried = await admin(`mutation($id: ID!) { pluginDeliveryRetry(id: $id) { __typename ... on PluginDeliveryRetryPayload { delivery { status attempts } } } }`, { id: listed.data.plugin.deliveries[0].id });
    expect(retried.data.pluginDeliveryRetry).toEqual({ __typename: "PluginDeliveryRetryPayload", delivery: { status: "PENDING", attempts: 3 } });
    expect(await deliverDuePluginEvents(t.platform)).toEqual({ delivered: 0, failed: 1 });
    const missing = await admin(`mutation { pluginDeliveryRetry(id: "gid://ecom/PluginDelivery/${newId()}") { __typename } }`);
    expect(missing.data.pluginDeliveryRetry.__typename).toBe("NotFoundError");
  });

  it("creates no deliveries for an inactive plugin", async () => {
    await update({ enabled: false });
    await route("/emit", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const ctx = (await t.platform.plugins.status("kitchen-sink")).active;
    expect(ctx).toBe(false);
    const cart = await readyCart("pat@example.test");
    await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "plugins-inactive" }, guest);
    await drain();
    const pending = await t.platform.db.select().from(pluginEventDeliveries).where(and(eq(pluginEventDeliveries.plugin, "kitchen-sink"), eq(pluginEventDeliveries.status, "pending")));
    expect(pending).toEqual([]);
    await update({ enabled: true });
  });
});

describe("checkout hook", () => {
  it("refuses an order with the plugin's issue, and ignores a plugin that throws", async () => {
    const cart = await readyCart("blocked@example.test");
    const refused = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "blocked-1" }, guest).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).message).toBe("This customer cannot order");
    expect((refused as ValidationError).fieldErrors).toEqual([{ path: ["email"], message: "This customer cannot order" }]);
    // broken-hook throws on every checkout: the others still place orders (see the events tests).
    expect(await t.platform.plugins.checkoutValidate({ cartId: cart.id, channelId: newId(), customerId: null, email: "ok@example.test", currency: "USD", grandTotal: 100, shippingAddress: null, billingAddress: null, shippingMethodCode: null, paymentMethodCode: null, lines: [] })).toEqual([]);
  });
});

describe("plugin tasks", () => {
  it("run at most once per interval, on one worker at a time", async () => {
    const ctx = await t.platform.plugins.context("kitchen-sink");
    await ctx.kv.delete("runs");
    const now = new Date();
    // Two workers ticking at once: each due task (the kitchen sink's count, order-alerts' forget) runs once.
    const ticks = await Promise.all([runDuePluginTasks(t.platform, { now }), runDuePluginTasks(t.platform, { now })]);
    expect(ticks.reduce((sum, tick) => sum + tick.ran, 0)).toBe(2);
    expect(await ctx.kv.get("runs")).toBe(1);
    expect(await runDuePluginTasks(t.platform, { now: new Date(now.getTime() + 30 * 60_000) })).toEqual({ ran: 0, failed: 0 });
    // An hour on, count (hourly) is due again; forget (daily) is not.
    expect(await runDuePluginTasks(t.platform, { now: new Date(now.getTime() + 61 * 60_000) })).toEqual({ ran: 1, failed: 0 });
    expect(await ctx.kv.get("runs")).toBe(2);
    expect(await runDuePluginTasks(t.platform, { now, deadline: Date.now() - 1 })).toEqual({ ran: 0, failed: 0 });
  });

  it("run now on request, and report the last run", async () => {
    const result = await admin(`mutation { pluginTaskRun(name: "kitchen-sink", task: "count") { __typename ... on PluginTaskRunPayload { task { name lastStatus lastError lastStartedAt lastFinishedAt } } } }`);
    expect(result.data.pluginTaskRun).toMatchObject({ __typename: "PluginTaskRunPayload", task: { name: "count", lastStatus: "succeeded", lastError: null } });
    expect(await (await t.platform.plugins.context("kitchen-sink")).kv.get("runs")).toBe(3);
    const missing = await admin(`mutation { pluginTaskRun(name: "kitchen-sink", task: "nope") { __typename } }`);
    expect(missing.data.pluginTaskRun.__typename).toBe("NotFoundError");
  });
});

describe("plugin migrations", () => {
  it("are applied once each, in name order, after the platform's", async () => {
    const applied = await t.platform.db.select().from(pluginMigrations).where(eq(pluginMigrations.plugin, "kitchen-sink"));
    expect(applied.map((m) => m.name)).toEqual(["0001_notes.sql", "0002_pinned.sql"]);
    const [note] = await queryRows<{ body: string; pinned: boolean; shout: string }>(t.platform.db, sql`select body, pinned, kitchen_sink_shout('hi') as shout from kitchen_sink_notes`);
    expect(note).toEqual({ body: "first; note", pinned: false, shout: "HI!" });
    expect(await applyPluginMigrations(t.platform.db, t.platform.plugins.definitions)).toEqual([]);
  });
});

describe("plugin providers", () => {
  it("take payments through checkout with the plugin's context", async () => {
    await createPaymentMethod(t.platform.db, t.platform.payments, { code: "kitchen", name: { "en-US": "Kitchen pay" }, provider: "kitchen_pay" });
    const cart = await readyCart("pay@example.test", "kitchen");
    const order = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "kitchen-pay-1" }, guest);
    expect(order.paymentStatus).toBe("authorized");
    const ctx = await t.platform.plugins.context("kitchen-sink");
    expect(await ctx.kv.get(`authorized:${order.id}`)).toEqual({ mode: "test", amount: order.grandTotal });
    const captured = await capturePayment(t.platform, order.id, {}, staff);
    expect(captured.paymentStatus).toBe("paid");
    expect(await ctx.kv.get(`captured:${order.id}`)).toEqual({ amount: order.grandTotal, pspReference: `ks_${order.number}` });
  });

  it("are hidden and refuse calls while the plugin is inactive", async () => {
    const provider = t.platform.payments.get("kitchen_pay")!;
    expect(provider.plugin).toBe("kitchen-sink");
    expect(await provider.isAvailable!({ currency: "USD", countryCode: "US", amount: 100 })).toBe(true);
    expect(await provider.isAvailable!({ currency: "JPY", countryCode: "JP", amount: 100 })).toBe(false);
    const shipping = t.platform.shipping.get("kitchen_ship")!;
    expect(await shipping.isActive!()).toBe(true);
    const rates = await shipping.rates({ method: { id: newId(), code: "k", name: "Standard", options: {} }, channelId: newId(), locale: "en-US", currency: "USD", subtotal: 0, weightGrams: 0, quantity: 1, destination: CA_ADDRESS, origin: null, lines: [] });
    expect(rates).toEqual([{ code: "standard", name: "Kitchen Standard", amount: 750, carrier: "Kitchen" }]);

    await update({ enabled: false });
    expect(await provider.isAvailable!({ currency: "USD", countryCode: "US", amount: 100 })).toBe(false);
    await expect(provider.authorize({ orderId: newId(), orderNumber: "X", cartId: null, amount: 100, currency: "USD", paymentData: {}, captureImmediately: false, session: null })).rejects.toBeInstanceOf(InvalidStateError);
    expect(await shipping.isActive!()).toBe(false);
    const cart = await readyCart("pat@example.test");
    const quote = await buildQuote(t.platform.db, cart.id, quoteProviders(t.platform));
    expect(quote.paymentMethods.map((m) => m.code)).not.toContain("kitchen");
    await update({ enabled: true });
  });
});

describe("plugin services", () => {
  it("read orders, customers, channels and locations, and add notes that name the plugin", async () => {
    const ctx = await t.platform.plugins.context("kitchen-sink");
    const cart = await readyCart("notes@example.test");
    const order = await placeOrder(t.platform, { cartId: cart.id, idempotencyKey: "services-1" }, guest);
    expect(await ctx.services.orders.get(order.id)).toMatchObject({
      number: order.number,
      email: "notes@example.test",
      lines: [expect.objectContaining({ sku: "TEE-BLACK-M", quantity: 5 })],
      fulfillments: [],
      couponCodes: [],
    });
    expect(await ctx.services.orders.getByNumber(order.number)).toMatchObject({ id: order.id });
    expect(await ctx.services.orders.get("not-an-id")).toBeNull();
    await ctx.services.orders.addNote(order.id, "Synced to the ERP");
    const [note] = await t.platform.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.type, "note")));
    expect(note).toMatchObject({ message: "Synced to the ERP", actorType: "system", data: { plugin: "kitchen-sink" } });
    // The seeded storefront serves every channel.
    expect(await ctx.services.channels.get(order.channelId)).toMatchObject({ code: "us", defaultLocale: "en-US", storefrontUrl: "http://localhost:3000" });
    expect(await ctx.services.locations.shipFrom(order.channelId)).toMatchObject({ name: "Newark warehouse", address: { countryCode: "US" } });
    expect(await ctx.services.channels.getDefault()).toMatchObject({ code: "us" });
    expect(await ctx.services.channels.getByCode("eu")).toMatchObject({ id: expect.any(String), code: "eu", defaultLocale: "de-DE" });
    expect(await ctx.services.channels.getByCode("nowhere")).toBeNull();
    expect((await ctx.services.channels.list()).map((c) => c.code)).toEqual(["eu", "us"]);
    expect(await ctx.services.customers.get(newId())).toBeNull();
    // A customer's locale is the one they last shopped in.
    const customer = t.seed.customer;
    // The seeded customer opted in to marketing when registering.
    expect(await ctx.services.customers.get(customer.id)).toMatchObject({ email: customer.email, locale: null, phone: null, acceptsMarketing: true });
    await createCart(t.platform.db, await resolveScope(t.platform.db, { channel: "eu", locale: "de-DE" }), { customerId: customer.id }, { lines: [] });
    expect(await ctx.services.customers.get(customer.id)).toMatchObject({ locale: "de-DE" });
    expect(ctx.urls).toEqual({ admin: "http://localhost:4000/admin", api: "http://localhost:4000" });
  });
});

describe("plugin lifecycle", () => {
  it("runs onStart once per process for active plugins", async () => {
    await t.platform.plugins.start();
    await t.platform.plugins.start();
    expect(await (await t.platform.plugins.context("kitchen-sink")).kv.get("started")).toBe(1);
  });

  it("takes settings from the environment over stored ones", async () => {
    const other = await createTestPlatform({ plugins: [kitchenSink()], env: { KITCHEN_SINK_API_KEY: "env-key", KITCHEN_SINK_GREETING: "from env" } });
    try {
      const status = await other.platform.plugins.status("kitchen-sink");
      expect(status).toMatchObject({ configured: true, active: true });
      expect(status.settings.slice(0, 2)).toMatchObject([
        { key: "apiKey", value: null, isSet: true, source: "env" },
        { key: "greeting", value: "from env", source: "env" },
      ]);
      await expect(other.platform.plugins.update("kitchen-sink", { settings: { apiKey: "admin-key" } })).rejects.toMatchObject({
        fieldErrors: [{ path: ["input", "settings", "apiKey"], message: "Set by the environment variable KITCHEN_SINK_API_KEY; change it there" }],
      });
      expect((await other.platform.plugins.context("kitchen-sink")).settings).toMatchObject({ apiKey: "env-key", greeting: "from env" });
    } finally {
      await other.close();
    }
  });
});
