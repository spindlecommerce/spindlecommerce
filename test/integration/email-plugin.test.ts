import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { email } from "../../plugins/email/index.ts";
import { emailMessages, recordMessage } from "../../plugins/email/messages.ts";
import { createCart, setCartBillingAddress, setCartEmail, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../../src/modules/carts/service.ts";
import { getVariantsBySkus } from "../../src/modules/catalog/read.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { placeOrder } from "../../src/modules/checkout/service.ts";
import { requestCustomerPasswordReset } from "../../src/modules/customers/service.ts";
import { setStockLevel } from "../../src/modules/inventory/service.ts";
import { emit } from "../../src/modules/integrations/outbox.ts";
import { createWebhookSubscription, deleteWebhookSubscription, listWebhookDeliveries } from "../../src/modules/integrations/webhooks.ts";
import { drainOutbox, processOutbox } from "../../src/modules/integrations/worker.ts";
import { fulfillOrder } from "../../src/modules/orders/service.ts";
import { deliverDuePluginEvents, retryPluginDelivery } from "../../src/modules/plugins/events.ts";
import { pluginEventDeliveries } from "../../src/modules/plugins/tables.ts";
import { runPluginTaskNow } from "../../src/modules/plugins/tasks.ts";
import { requestStaffPasswordReset } from "../../src/modules/staff/service.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

/** Resend's API as the plugin sees it: requests recorded, answers from `resend.respond`. */
const resend = {
  requests: [] as { url: string; headers: Record<string, string>; body: any }[],
  respond: (): Response => Response.json({ id: `email_${resend.requests.length}` }),
};
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  resend.requests.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
  return resend.respond();
}) as typeof fetch;

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp({ plugins: [email()], fetch: fakeFetch });
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

const ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const guest = { customerId: null };
const staff = { type: "staff" as const, id: null };

const order = async (key: string, sku = "TOTE-BLACK") => {
  const db = t.platform.db;
  const cart = await createCart(db, await resolveScope(db, { channel: "us" }), guest, { lines: [{ sku, quantity: 1 }] });
  await setCartEmail(db, cart.id, "sam@example.test", guest);
  await setCartShippingAddress(db, cart.id, { address: ADDRESS }, guest);
  await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, guest);
  await setCartShippingMethod(db, cart.id, "us_standard", guest);
  await setCartPaymentMethod(db, cart.id, "card", guest);
  return placeOrder(t.platform, { cartId: cart.id, idempotencyKey: key }, guest);
};

const settings = (values: Record<string, unknown>) => t.platform.plugins.update("email", { settings: values });
const drain = () => drainOutbox(t.platform);
const sent = (where: { orderId?: string; template?: string; to?: string }) =>
  t.platform.db
    .select()
    .from(emailMessages)
    .where(
      and(
        where.orderId ? eq(emailMessages.orderId, where.orderId) : undefined,
        where.template ? eq(emailMessages.template, where.template) : undefined,
        where.to ? eq(emailMessages.to, where.to) : undefined,
      ),
    )
    .orderBy(emailMessages.id);

describe("email plugin", () => {
  it("logs one confirmation per order, even when the event is redelivered", async () => {
    await settings({ staffOrderNotifications: "orders@shop.example.test" });
    const placed = await order("email-1");
    await drain();
    const messages = await sent({ orderId: placed.id });
    expect(messages.map((m) => [m.template, m.to, m.status, m.provider])).toEqual([
      ["order_confirmation", "sam@example.test", "logged", "log"],
      ["staff_new_order", "orders@shop.example.test", "logged", "log"],
    ]);
    expect(messages[0]).toMatchObject({ subject: `Order ${placed.number} confirmed`, orderNumber: placed.number });
    expect(messages[0]!.html).toContain("Ecom US");
    expect(messages[1]!.html).toContain(`/admin/orders/${placed.number}`);

    // The runtime delivers at least once: run the order.placed delivery again.
    const [delivery] = await t.platform.db.select().from(pluginEventDeliveries).where(and(eq(pluginEventDeliveries.plugin, "email"), eq(pluginEventDeliveries.handler, "order.placed")));
    expect(delivery!.status).toBe("succeeded");
    await retryPluginDelivery(t.platform.db, delivery!.id);
    expect(await deliverDuePluginEvents(t.platform)).toMatchObject({ delivered: 1, failed: 0 });
    expect(await sent({ orderId: placed.id })).toHaveLength(2);
    await settings({ staffOrderNotifications: null });
  });

  it("emails each shipment with its tracking links", async () => {
    const placed = await order("email-2");
    await fulfillOrder(t.platform.db, placed.id, { tracking: [{ carrier: "UPS", number: "1Z999AA10123456784" }] }, staff);
    await drain();
    const [shipped] = await sent({ orderId: placed.id, template: "order_shipped" });
    expect(shipped).toMatchObject({ to: "sam@example.test", subject: `Your order ${placed.number} has shipped`, status: "logged" });
    expect(shipped!.html).toContain('href="https://www.ups.com/track?tracknum=1Z999AA10123456784"');
    expect(shipped!.text).toContain("1 × Market Tote");
  });

  it("sends customer reset links to the storefront, or to the configured URL", async () => {
    // By default: the default channel's storefront (the demo data's sample storefront).
    await requestCustomerPasswordReset(t.platform.db, t.platform.config, TEST_CREDENTIALS.customerEmail);
    await drain();
    await settings({ customerResetUrl: "https://shop.example.test/account/reset?token={token}&email={email}" });
    await requestCustomerPasswordReset(t.platform.db, t.platform.config, TEST_CREDENTIALS.customerEmail);
    await drain();
    const [byDefault, configured] = await sent({ template: "customer_password_reset" });
    expect(byDefault).toMatchObject({ to: TEST_CREDENTIALS.customerEmail, subject: "Reset your password", status: "logged" });
    expect(byDefault!.text).toBe("Password reset email body not stored.");
    expect(configured!.text).toBe("Password reset email body not stored.");
    await settings({ customerResetUrl: null });
  });

  it("sends reset links through plugins only, never to webhooks", async () => {
    // A subscription to every event, as anyone with integrations:write could make.
    const everything = await createWebhookSubscription(t.platform.db, { name: "Everything", url: "https://hooks.example.test/all", events: ["*"] });
    const customerResets = (await sent({ template: "customer_password_reset" })).length;
    const url = await requestStaffPasswordReset(t.platform.db, t.platform.config, TEST_CREDENTIALS.adminEmail);
    await requestCustomerPasswordReset(t.platform.db, t.platform.config, TEST_CREDENTIALS.customerEmail);
    await emit(t.platform.db, { type: "customer.updated", aggregateType: "Customer", aggregateId: t.seed.customer.id });
    await processOutbox(t.platform);
    const webhooked = (await listWebhookDeliveries(t.platform.db, everything.id)).map((d) => d.eventType);
    expect(webhooked).toContain("customer.updated");
    expect(webhooked).not.toContain("customer.password_reset_requested");
    expect(webhooked).not.toContain("staff.password_reset_requested");
    // Before draining, which would send its deliveries.
    await deleteWebhookSubscription(t.platform.db, everything.id);

    await drain();
    const [reset] = await sent({ template: "staff_password_reset" });
    expect(reset).toMatchObject({ to: TEST_CREDENTIALS.adminEmail, subject: "Reset your Ecom US admin password" });
    expect(reset!.text).toBe("Password reset email body not stored.");
    expect(reset!.text).not.toContain(url!);
    expect(await sent({ template: "customer_password_reset" })).toHaveLength(customerResets + 1);
  });

  it("alerts staff once per dip below the low stock threshold", async () => {
    await settings({ lowStockThreshold: 5, lowStockRecipients: "buyer@shop.example.test" });
    const [variant] = await getVariantsBySkus(t.platform.db, ["SOCK-BLUE"]);
    const level = (quantity: number) => setStockLevel(t.platform.db, { variantId: variant!.id, locationId: t.seed.locations.usEast.id, quantity });
    await level(4);
    await drain();
    await level(2);
    await drain();
    expect((await sent({ template: "low_stock" })).map((m) => m.subject)).toEqual(["Low stock: SOCK-BLUE (4 left)"]);
    await level(30);
    await drain();
    await level(1);
    await drain();
    const alerts = await sent({ template: "low_stock" });
    expect(alerts.map((m) => [m.to, m.subject])).toEqual([
      ["buyer@shop.example.test", "Low stock: SOCK-BLUE (4 left)"],
      ["buyer@shop.example.test", "Low stock: SOCK-BLUE (1 left)"],
    ]);
    expect(alerts[1]!.text).toContain("is down to 1 at Newark warehouse");
    await settings({ lowStockThreshold: null, lowStockRecipients: null });
  });

  it("records Resend failures and sends on the runtime's retry", async () => {
    await settings({ transport: "resend", resendApiKey: "re_test_key", from: "Ecom <orders@shop.example.test>", replyTo: "help@shop.example.test" });
    resend.requests = [];
    resend.respond = () => Response.json({ statusCode: 500, name: "application_error", message: "Something went wrong" }, { status: 500 });
    const placed = await order("email-3");
    await drain();
    expect((await sent({ orderId: placed.id })).map((m) => [m.status, m.provider, m.error])).toEqual([["failed", "resend", "Resend answered 500: Something went wrong"]]);
    const [delivery] = await t.platform.db.select().from(pluginEventDeliveries).where(eq(pluginEventDeliveries.status, "failed"));
    expect(delivery).toMatchObject({ handler: "order.placed", attempts: 1 });
    expect(delivery!.lastError).toContain("Resend answered 500");

    resend.respond = () => Response.json({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    // The retry is due after its backoff.
    expect(await deliverDuePluginEvents(t.platform, { now: new Date(Date.now() + 3_600_000) })).toMatchObject({ delivered: 1 });
    expect((await sent({ orderId: placed.id })).map((m) => [m.status, m.providerMessageId])).toEqual([
      ["failed", null],
      ["sent", "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"],
    ]);
    expect(resend.requests).toHaveLength(2);
    const request = resend.requests[1]!;
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(request.headers.authorization).toBe("Bearer re_test_key");
    expect(request.headers["idempotency-key"]).toBe(resend.requests[0]!.headers["idempotency-key"]);
    expect(request.body).toMatchObject({ from: "Ecom <orders@shop.example.test>", to: ["sam@example.test"], reply_to: "help@shop.example.test", subject: `Order ${placed.number} confirmed` });

    expect(await t.platform.plugins.check("email")).toMatchObject({ ok: false, message: expect.stringContaining("shop.example.test is not set up") });
    await settings({ transport: "log" });
    expect(await t.platform.plugins.check("email")).toMatchObject({ ok: true });
  });

  it("serves the log, previews and test sends to staff with the email permissions", async () => {
    const log = await t.admin(`{ emailMessages(first: 2, template: ORDER_CONFIRMATION) { totalCount edges { node { id template to status orderNumber } } pageInfo { hasNextPage endCursor } } }`, {}, auth);
    expect(log.errors).toBeUndefined();
    expect(log.data.emailMessages.totalCount).toBe(4);
    expect(log.data.emailMessages.edges).toHaveLength(2);
    expect(log.data.emailMessages.pageInfo.hasNextPage).toBe(true);
    const next = await t.admin(`query($after: String) { emailMessages(first: 10, after: $after, template: ORDER_CONFIRMATION) { edges { node { id } } } }`, { after: log.data.emailMessages.pageInfo.endCursor }, auth);
    expect(next.data.emailMessages.edges).toHaveLength(2);
    const failed = await t.admin(`{ emailMessages(status: FAILED) { edges { node { error provider } } } }`, {}, auth);
    expect(failed.data.emailMessages.edges).toEqual([{ node: { error: "Resend answered 500: Something went wrong", provider: "resend" } }]);

    const { id, orderNumber } = log.data.emailMessages.edges[0].node;
    const one = await t.admin(`query($id: ID!) { emailMessage(id: $id) { subject html text orderId } }`, { id }, auth);
    expect(one.data.emailMessage.html).toContain("<!doctype html>");
    expect(one.data.emailMessage.orderId).toMatch(/^gid:\/\/ecom\/Order\//);
    const search = await t.admin(`query($q: String) { emailMessages(query: $q) { edges { node { orderNumber } } } }`, { q: orderNumber }, auth);
    expect(search.data.emailMessages.edges.every((e: any) => e.node.orderNumber === orderNumber)).toBe(true);

    const sample = await t.admin(`{ emailPreview(template: ORDER_CONFIRMATION, locale: "de-DE") { subject html text } }`, {}, auth);
    expect(sample.data.emailPreview.subject).toBe("Bestellung 100123 bestätigt");
    expect(sample.data.emailPreview.text).toMatch(/Gesamt: 67,19\s€/);
    const real = await t.admin(`query($n: String) { emailPreview(template: ORDER_SHIPPED, orderNumber: $n) { subject } }`, { n: orderNumber }, auth);
    expect(real.data.emailPreview.subject).toBe(`Your order ${orderNumber} has shipped`);
    const missing = await t.admin(`{ emailPreview(template: ORDER_CANCELED, orderNumber: "NOPE") { subject } }`, {}, auth);
    expect(missing.errors?.[0]?.message).toMatch(/not found/);

    // Spreads the error fields as the admin does: the payload's field must not clash with their `message`.
    const test = await t.admin(
      `mutation { emailSendTest(to: "Me@Example.test") { __typename ... on EmailSendTestPayload { emailMessage { template to status subject } } ... on Error { code message } } }`,
      {},
      auth,
    );
    expect(test.errors).toBeUndefined();
    expect(test.data.emailSendTest).toEqual({ __typename: "EmailSendTestPayload", emailMessage: { template: "TEST", to: "me@example.test", status: "LOGGED", subject: "Test email from Ecom US" } });

    // Plugin permissions: grantable to API keys and roles, and enforced field by field.
    const key = async (permissions: string[]) => {
      const created = await t.admin(`mutation($p: [String!]!) { apiKeyCreate(name: "Email", permissions: $p) { ... on ApiKeyCreatePayload { secret } } }`, { p: permissions }, auth);
      return bearer(created.data.apiKeyCreate.secret);
    };
    const orders = await key(["orders:read"]);
    expect((await t.admin(`{ emailMessages { totalCount } }`, {}, orders)).errors?.[0]?.extensions?.code).toBe("PERMISSION_DENIED");
    const reader = await key(["email:read"]);
    expect((await t.admin(`{ emailMessages { totalCount } }`, {}, reader)).errors).toBeUndefined();
    const denied = await t.admin(`mutation { emailSendTest(to: "me@example.test") { __typename ... on PermissionDeniedError { permission } } }`, {}, reader);
    expect(denied.data.emailSendTest).toEqual({ __typename: "PermissionDeniedError", permission: "email:send" });
  });

  it("prunes messages older than 30 days", async () => {
    const old = await recordMessage(t.platform.db, { template: "test", to: "old@example.test", subject: "Old", status: "logged", provider: "log", html: "", text: "", createdAt: new Date(Date.now() - 31 * 86_400_000) });
    const before = (await sent({})).length;
    const run = await runPluginTaskNow(t.platform, "email", "prune-messages");
    expect(run.lastStatus).toBe("succeeded");
    const after = await sent({});
    expect(after).toHaveLength(before - 1);
    expect(after.some((m) => m.id === old.id)).toBe(false);
  });
});
