import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emailMessages } from "../../plugins/email/messages.ts";
import { onCustomerPasswordReset, onOrderCanceled, onOrderFulfilled, onOrderPlaced, onStaffPasswordReset } from "../../plugins/email/service.ts";
import type { EmailContext } from "../../plugins/email/settings.ts";
import { sampleOrder } from "../../plugins/email/templates.ts";
import type { PluginEvent, PluginOrder } from "../../src/plugins/sdk.ts";

const CHANNEL = { id: "0192f0c4-0000-7000-8000-000000000001", code: "us", name: "Ecom US", defaultLocale: "en-US", storefrontUrl: "https://shop.example.test" };

let client: PGlite;
let db: EmailContext["db"];
beforeAll(async () => {
  client = new PGlite();
  await client.exec(readFileSync(new URL("../../plugins/email/migrations/0001_email_messages.sql", import.meta.url), "utf8"));
  // The one platform table the plugin reads besides its own: the default channel for account emails.
  await client.exec(`create table channels (id uuid primary key, code text, is_active boolean, created_at timestamptz default now()); insert into channels (id, code, is_active) values ('${CHANNEL.id}', 'us', true);`);
  db = drizzle(client) as unknown as EmailContext["db"];
});
afterAll(() => client.close());

/** The plugin context a runtime would provide, built by hand. */
const setup = (options: { settings?: Partial<EmailContext["settings"]>; order?: PluginOrder; reply?: () => Response } = {}) => {
  const ran = new Set<string>();
  const kv = new Map<string, unknown>();
  const requests: { url: string; body: any }[] = [];
  const order = options.order ?? { ...sampleOrder("en-US"), id: "0192f0c4-0000-7000-8000-0000000000aa", number: "US-000042", channelId: CHANNEL.id, email: "sam@example.test" };
  const ctx = {
    plugin: { name: "email", version: "1.0.0" },
    settings: { transport: "log", ...options.settings },
    db,
    logger: pino({ level: "silent" }),
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
      return (options.reply ?? (() => Response.json({ id: `re_${requests.length}` })))();
    }) as typeof fetch,
    once: async (key: string, fn: () => Promise<void>) => {
      if (ran.has(key)) return false;
      await fn();
      ran.add(key);
      return true;
    },
    kv: {
      get: async (key: string) => kv.get(key) ?? null,
      set: async (key: string, value: unknown) => void kv.set(key, value),
      add: async (key: string, value: unknown) => (kv.has(key) ? false : (kv.set(key, value), true)),
      delete: async (key: string) => void kv.delete(key),
      list: async () => [],
    },
    services: {
      orders: { get: async (id: string) => (id === order.id ? order : null), getByNumber: async () => null, addNote: async () => {} },
      customers: { get: async () => ({ id: "c1", email: "mia@example.test", firstName: "Mia", lastName: "Schmidt", locale: null }) },
      channels: { get: async (id: string) => (id === CHANNEL.id ? CHANNEL : null), getDefault: async () => CHANNEL },
      locations: { shipFrom: async () => null },
    },
    urls: { admin: "https://api.example.test/admin", api: "https://api.example.test" },
    production: false,
    platform: { config: { defaultChannelCode: undefined } },
  } as unknown as EmailContext;
  return { ctx, order, requests };
};

const event = (type: string, aggregateId: string, payload: Record<string, unknown> = {}): PluginEvent => ({ id: crypto.randomUUID(), type, aggregateType: "Order", aggregateId, payload, occurredAt: new Date() });
const messages = () => db.select().from(emailMessages).orderBy(emailMessages.id);

describe("email delivery", () => {
  beforeEach(async () => {
    await db.delete(emailMessages);
  });

  it("sends the confirmation and staff notices once per event and recipient", async () => {
    const { ctx, order } = setup({ settings: { staffOrderNotifications: "ops@example.test, Ops@example.test, boss@example.test" } });
    const placed = event("order.placed", order.id);
    await onOrderPlaced(placed, ctx);
    await onOrderPlaced(placed, ctx); // redelivered
    const rows = await messages();
    expect(rows.map((m) => [m.template, m.to, m.status, m.provider])).toEqual([
      ["order_confirmation", "sam@example.test", "logged", "log"],
      ["staff_new_order", "ops@example.test", "logged", "log"],
      ["staff_new_order", "boss@example.test", "logged", "log"],
    ]);
    expect(rows[0]).toMatchObject({ orderId: order.id, orderNumber: "US-000042", subject: "Order US-000042 confirmed" });
    expect(rows[1]!.html).toContain('href="https://api.example.test/admin/orders/US-000042"');
  });

  it("records failures, retries only what failed, and sends with the provider", async () => {
    let fail = true;
    const { ctx, order, requests } = setup({
      settings: { transport: "resend", resendApiKey: "re_test", from: "Shop <orders@shop.example.test>", staffOrderNotifications: "ops@example.test" },
      reply: () => (fail ? Response.json({ statusCode: 500, name: "internal_server_error", message: "Try again" }, { status: 500 }) : Response.json({ id: "email_123" })),
    });
    const placed = event("order.placed", order.id);
    await expect(onOrderPlaced(placed, ctx)).rejects.toThrow("order_confirmation to sam@example.test: Resend answered 500: Try again; staff_new_order to ops@example.test: Resend answered 500: Try again");
    fail = false;
    await onOrderPlaced(placed, ctx);
    await onOrderPlaced(placed, ctx);
    const rows = await messages();
    expect(rows.map((m) => [m.template, m.status, m.error, m.providerMessageId])).toEqual([
      ["order_confirmation", "failed", "Resend answered 500: Try again", null],
      ["staff_new_order", "failed", "Resend answered 500: Try again", null],
      ["order_confirmation", "sent", null, "email_123"],
      ["staff_new_order", "sent", null, "email_123"],
    ]);
    expect(requests).toHaveLength(4);
    expect(requests[2]!.body).toMatchObject({ from: "Shop <orders@shop.example.test>", to: ["sam@example.test"], subject: "Order US-000042 confirmed" });
  });

  it("leaves sends it has no time for to the retry", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { ctx, order, requests } = setup({
        settings: { transport: "resend", resendApiKey: "re_test", from: "Shop <orders@shop.example.test>", staffOrderNotifications: "ops@example.test" },
        // A provider taking 16 seconds: past the budget after the first email.
        reply: () => {
          now += 16_000;
          return Response.json({ id: "email_slow" });
        },
      });
      const placed = event("order.placed", order.id);
      await expect(onOrderPlaced(placed, ctx)).rejects.toThrow("staff_new_order to ops@example.test: not attempted in time");
      expect(requests).toHaveLength(1);
      await onOrderPlaced(placed, ctx);
      expect(requests.map((r) => r.body.to)).toEqual([["sam@example.test"], ["ops@example.test"]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("stays quiet about orders declined at checkout", async () => {
    const declined = { ...sampleOrder("en-US"), id: "0192f0c4-0000-7000-8000-0000000000bb", number: "US-000043", channelId: CHANNEL.id, status: "canceled" };
    const { ctx } = setup({ order: declined });
    await onOrderPlaced(event("order.placed", declined.id), ctx);
    await onOrderCanceled(event("order.canceled", declined.id, { reason: "payment_declined" }), ctx);
    expect(await messages()).toEqual([]);
    // A cancellation by staff is always worth an email.
    await onOrderCanceled(event("order.canceled", declined.id, { reason: "customer request" }), ctx);
    expect((await messages()).map((m) => [m.template, m.subject])).toEqual([["order_canceled", "Order US-000043 canceled"]]);
  });

  it("sends the shipment that the event names, with its tracking", async () => {
    const { ctx, order } = setup();
    order.fulfillments = [
      { id: "f1", number: "FUL-000001", tracking: [{ carrier: "UPS", number: "1ZFIRST" }], lines: [{ orderLineId: order.lines[0]!.id, quantity: 2 }], createdAt: new Date() },
      { id: "f2", number: "FUL-000002", tracking: [{ carrier: "USPS", number: "9400SECOND" }], lines: [{ orderLineId: order.lines[1]!.id, quantity: 1 }], createdAt: new Date() },
    ];
    await onOrderFulfilled(event("order.fulfilled", order.id, { fulfillmentNumber: "FUL-000001", fulfillmentStatus: "partially_fulfilled" }), ctx);
    const [shipped] = await messages();
    expect(shipped!.text).toContain("Tracking (UPS): 1ZFIRST");
    expect(shipped!.text).not.toContain("9400SECOND");
    expect(shipped!.text).toContain("Part of your order is on its way.");
  });

  it("sends password resets with the right links", async () => {
    const { ctx, requests } = setup({ settings: { transport: "resend", resendApiKey: "re_test", from: "store@example.test", customerResetUrl: "https://shop.example.test/reset?token={token}&email={email}" } });
    const printed = vi.spyOn(ctx.logger, "info");
    await onCustomerPasswordReset(event("customer.password_reset_requested", "c1", { email: "mia@example.test", token: "pr_abc" }), ctx);
    await onStaffPasswordReset(event("staff.password_reset_requested", "s1", { email: "admin@example.test", name: "Ada", token: "pr_s", url: "https://api.example.test/admin/reset-password?token=pr_s" }), ctx);
    const [customer, staff] = await messages();
    expect(customer).toMatchObject({ template: "customer_password_reset", to: "mia@example.test", subject: "Reset your password" });
    expect(requests[0]!.body.text).toContain("https://shop.example.test/reset?token=pr_abc&email=mia%40example.test");
    expect(requests[0]!.body.text).toContain("Hi Mia,");
    expect(staff).toMatchObject({ template: "staff_password_reset", to: "admin@example.test", subject: "Reset your Ecom US admin password" });
    expect(requests[1]!.body.text).toContain("https://api.example.test/admin/reset-password?token=pr_s");
    // Reset links are never stored, and only the log transport prints them.
    expect([customer!.html, customer!.text, staff!.html, staff!.text].join(" ")).not.toMatch(/pr_(abc|s)/);
    expect(customer!.text).toBe("Password reset email body not stored.");
    expect(JSON.stringify(printed.mock.calls)).not.toMatch(/pr_(abc|s)/);

    // The default link is the default channel's storefront. The log transport prints it, outside production only.
    const fallback = setup();
    const printedLocally = vi.spyOn(fallback.ctx.logger, "info");
    await onCustomerPasswordReset(event("customer.password_reset_requested", "c1", { email: "mia@example.test", token: "pr_def" }), fallback.ctx);
    expect((await messages()).at(-1)!.text).toBe("Password reset email body not stored.");
    expect(printedLocally).toHaveBeenCalledWith(expect.objectContaining({ url: "https://shop.example.test/account/reset-password?token=pr_def" }), expect.any(String));
    Object.assign(fallback.ctx, { production: true });
    await onCustomerPasswordReset(event("customer.password_reset_requested", "c1", { email: "mia@example.test", token: "pr_prod" }), fallback.ctx);
    expect(JSON.stringify(printedLocally.mock.calls)).not.toContain("pr_prod");

    // Without a storefront the email is skipped.
    const none = setup();
    const bare = async () => ({ ...CHANNEL, storefrontUrl: null });
    Object.assign(none.ctx.services.channels, { get: bare, getDefault: bare });
    await onCustomerPasswordReset(event("customer.password_reset_requested", "c1", { email: "mia@example.test", token: "pr_none" }), none.ctx);
    expect(await messages()).toHaveLength(4);
  });
});
