import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.ts";
import { parseGlobalId, toGlobalId } from "../../src/lib/ids.ts";
import { hotp, totpCounter } from "../../src/lib/totp.ts";
import { consumePasswordResetToken, createPasswordResetToken, issueSession, rotateRefreshToken } from "../../src/modules/auth/service.ts";
import { emit } from "../../src/modules/integrations/outbox.ts";
import { outboxEvents, webhookDeliveries, webhookSubscriptions } from "../../src/modules/integrations/tables.ts";
import { deliverDueWebhooks } from "../../src/modules/integrations/webhooks.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { completeStaffSignIn, getStaffUser } from "../../src/modules/staff/service.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;
const gid = (type: string, id: string) => toGlobalId(type, id);
const address = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };

const LOGIN = `mutation($e: EmailAddress!, $p: String!) {
  staffLogin(email: $e, password: $p) {
    __typename
    ... on StaffAuthPayload { staffUser { id } session { accessToken } twoFactorChallenge { token } }
    ... on Error { code message }
  }
}`;
const login = async (email: string, password: string) => (await t.admin(LOGIN, { e: email, p: password })).data.staffLogin;
const verify = async (token: string, code: string) =>
  (await t.admin(`mutation($t: String!, $c: String!) { staffLoginVerify(challengeToken: $t, code: $c) { __typename ... on StaffAuthPayload { session { accessToken } } ... on Error { code } } }`, { t: token, c: code })).data.staffLoginVerify;

beforeAll(async () => {
  t = await createTestApp();
  auth = bearer((await login(TEST_CREDENTIALS.adminEmail, TEST_CREDENTIALS.adminPassword)).session.accessToken);
});
afterAll(() => t.close());

const createStaff = async (email: string, password: string, role = "fulfillment") => {
  const roles = (await t.admin(`{ roles { id code } }`, {}, auth)).data.roles as { id: string; code: string }[];
  const created = await t.admin(
    `mutation($i: StaffUserInput!) { staffUserCreate(input: $i) { __typename ... on StaffUserPayload { staffUser { id } } ... on ValidationError { fieldErrors { path message } } } }`,
    { i: { email, name: email.split("@")[0], password, roleIds: [roles.find((r) => r.code === role)!.id] } },
    auth,
  );
  return created.data.staffUserCreate.staffUser.id as string;
};

const placeStorefrontOrder = async (sku: string, quantity: number, key: string) => {
  const cart = await t.storefront(`mutation($sku: String!, $q: Int!) { cartCreate(input: { email: "ana@example.test", lines: [{ sku: $sku, quantity: $q }] }) { ... on CartPayload { cart { id } } } }`, { sku, q: quantity });
  const id = cart.data.cartCreate.cart.id;
  await t.storefront(`mutation($id: ID!, $a: AddressInput!) {
    a: cartShippingAddressSet(cartId: $id, address: { address: $a }) { __typename }
    b: cartBillingAddressSet(cartId: $id, address: { sameAsShipping: true }) { __typename }
    c: cartShippingMethodSet(cartId: $id, shippingMethodCode: "us_standard") { __typename }
    d: cartPaymentMethodSet(cartId: $id, paymentMethodCode: "card") { __typename }
  }`, { id, a: address });
  const order = await t.storefront(`mutation($id: ID!, $k: String!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: $k) { ... on CheckoutPayload { order { id number totals { total { amount } } } } } }`, { id, k: key });
  return order.data.checkoutPlaceOrder.order as { id: string; number: string; totals: { total: { amount: string } } };
};

describe("staff sign-in security", () => {
  it("locks an account after repeated failures until an administrator unlocks it", async () => {
    const id = await createStaff("locked@example.test", "correct-horse-battery");
    for (let i = 0; i < 5; i++) expect((await login("locked@example.test", "wrong-password-123")).__typename).toBe("AuthenticationError");
    // Locked now: even the right password is refused, with the same message.
    const refused = await login("locked@example.test", "correct-horse-battery");
    expect(refused).toMatchObject({ __typename: "AuthenticationError", code: "UNAUTHENTICATED" });
    const users = (await t.admin(`{ staffUsers { id lockedUntil } }`, {}, auth)).data.staffUsers as { id: string; lockedUntil: string | null }[];
    expect(users.find((u) => u.id === id)?.lockedUntil).not.toBeNull();
    const unlocked = await t.admin(`mutation($id: ID!) { staffUserUnlock(id: $id) { ... on StaffUserPayload { staffUser { lockedUntil } } } }`, { id }, auth);
    expect(unlocked.data.staffUserUnlock.staffUser.lockedUntil).toBeNull();
    expect((await login("locked@example.test", "correct-horse-battery")).session.accessToken).toBeTruthy();
  });

  it("requires a one-time code once two-factor authentication is enabled", async () => {
    await createStaff("totp@example.test", "totp-password-123");
    const me = bearer((await login("totp@example.test", "totp-password-123")).session.accessToken);
    const setup = (await t.admin(`mutation { staffTwoFactorSetup { ... on StaffTwoFactorSetupPayload { secret uri } } }`, {}, me)).data.staffTwoFactorSetup;
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Ecom%20Admin:totp%40example.test\?secret=/);

    const wrong = await t.admin(`mutation { staffTwoFactorEnable(code: "000000") { __typename } }`, {}, me);
    expect(wrong.data.staffTwoFactorEnable.__typename).toBe("ValidationError");
    const enabled = await t.admin(
      `mutation($c: String!) { staffTwoFactorEnable(code: $c) { ... on StaffTwoFactorEnablePayload { recoveryCodes staffUser { twoFactorEnabled recoveryCodesRemaining } } } }`,
      { c: hotp(setup.secret, totpCounter()) },
      me,
    );
    const { recoveryCodes, staffUser } = enabled.data.staffTwoFactorEnable;
    expect(recoveryCodes).toHaveLength(10);
    expect(staffUser).toEqual({ twoFactorEnabled: true, recoveryCodesRemaining: 10 });

    const challenged = await login("totp@example.test", "totp-password-123");
    expect(challenged.session).toBeNull();
    // The enrollment code's time step is spent; the next step's code is within the drift window.
    const next = hotp(setup.secret, totpCounter() + 1);
    expect((await verify(challenged.twoFactorChallenge.token, next)).session.accessToken).toBeTruthy();
    const again = await login("totp@example.test", "totp-password-123");
    expect((await verify(again.twoFactorChallenge.token, next)).code).toBe("UNAUTHENTICATED");

    const recovery = await login("totp@example.test", "totp-password-123");
    expect((await verify(recovery.twoFactorChallenge.token, recoveryCodes[0].toUpperCase())).session.accessToken).toBeTruthy();
    const reused = await login("totp@example.test", "totp-password-123");
    expect((await verify(reused.twoFactorChallenge.token, recoveryCodes[0])).code).toBe("UNAUTHENTICATED");

    const disabled = await t.admin(`mutation { staffTwoFactorDisable(password: "totp-password-123") { ... on StaffUserPayload { staffUser { twoFactorEnabled } } } }`, {}, me);
    expect(disabled.data.staffTwoFactorDisable.staffUser.twoFactorEnabled).toBe(false);
  });

  it("changes your own password and signs out every other session", async () => {
    await createStaff("rotate@example.test", "first-password-123");
    const first = bearer((await login("rotate@example.test", "first-password-123")).session.accessToken);
    const changed = await t.admin(
      `mutation { staffPasswordChange(currentPassword: "first-password-123", newPassword: "second-password-123") { __typename ... on StaffSessionPayload { session { accessToken refreshToken } } } }`,
      {},
      first,
    );
    expect(changed.data.staffPasswordChange.session.refreshToken).toMatch(/^rt_/);
    expect((await login("rotate@example.test", "first-password-123")).__typename).toBe("AuthenticationError");
    expect((await login("rotate@example.test", "second-password-123")).session).not.toBeNull();
  });
});

describe("browser sessions", () => {
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    t.app.fetch(
      new Request(`http://ecom.test/admin/auth/${path}`, {
        method: "POST",
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] ?? "";

  it("keeps the refresh token in an httpOnly cookie and rotates it", async () => {
    const signedIn = await post("login", { email: TEST_CREDENTIALS.adminEmail, password: TEST_CREDENTIALS.adminPassword });
    expect(signedIn.status).toBe(200);
    const header = signedIn.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^ecom_admin_rt=rt_/);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\/admin\/auth/);
    const json = (await signedIn.json()) as Record<string, unknown>;
    expect(json.accessToken).toBeTruthy();
    expect(json).not.toHaveProperty("refreshToken");

    const cookie = cookieOf(signedIn);
    expect((await post("refresh", undefined, { cookie })).status).toBe(415);
    const refreshed = await post("refresh", undefined, { cookie, "x-requested-with": "ecom-admin" });
    expect(refreshed.status).toBe(200);
    expect(cookieOf(refreshed)).not.toBe(cookie);
    // Replaying the rotated token revokes the whole session family.
    expect((await post("refresh", undefined, { cookie, "x-requested-with": "ecom-admin" })).status).toBe(401);
    expect((await post("refresh", undefined, { cookie: cookieOf(refreshed), "x-requested-with": "ecom-admin" })).status).toBe(401);
  });

  it("signs out and rejects bad credentials", async () => {
    const signedIn = await post("login", { email: TEST_CREDENTIALS.adminEmail, password: TEST_CREDENTIALS.adminPassword });
    const out = await post("logout", undefined, { cookie: cookieOf(signedIn), "x-requested-with": "ecom-admin" });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/ecom_admin_rt=;/);
    expect((await post("refresh", undefined, { cookie: cookieOf(signedIn), "x-requested-with": "ecom-admin" })).status).toBe(401);
    const bad = await post("login", { email: TEST_CREDENTIALS.adminEmail, password: "nope-nope-nope" });
    expect(bad.status).toBe(401);
  });
});

describe("single-use tokens", () => {
  const password = "racing-password-123";
  const staffId = async (email: string) => parseGlobalId(await createStaff(email, password))!.id;
  // PGlite runs one transaction at a time. Without them, two calls interleave statement by
  // statement, as concurrent transactions do on PostgreSQL.
  const racing = () => Object.assign(Object.create(t.platform.db) as Database, { transaction: (run: (tx: Database) => Promise<unknown>) => run(t.platform.db) });
  const outcomes = async (...calls: Promise<unknown>[]) => (await Promise.allSettled(calls)).map((r) => r.status).sort();

  it("rotates a refresh token once when two requests race with it", async () => {
    const { config } = t.platform;
    const { session } = await issueSession(t.platform.db, config, "staff", await staffId("race-refresh@example.test"));
    const db = racing();
    expect(await outcomes(rotateRefreshToken(db, config, session.refreshToken, "staff"), rotateRefreshToken(db, config, session.refreshToken, "staff"))).toEqual(["fulfilled", "rejected"]);
  });

  it("resets a password once per token when two requests race with it", async () => {
    const { config } = t.platform;
    const token = await createPasswordResetToken(t.platform.db, config, "staff", await staffId("race-reset@example.test"));
    const db = racing();
    expect(await outcomes(consumePasswordResetToken(db, token, "staff"), consumePasswordResetToken(db, token, "staff"))).toEqual(["fulfilled", "rejected"]);
  });

  it("accepts a one-time or recovery code once, even for a sign-in that read the user before another spent it", async () => {
    const { db, config } = t.platform;
    const id = await staffId("race-totp@example.test");
    const me = bearer((await login("race-totp@example.test", password)).session.accessToken);
    const { secret } = (await t.admin(`mutation { staffTwoFactorSetup { ... on StaffTwoFactorSetupPayload { secret } } }`, {}, me)).data.staffTwoFactorSetup;
    const enabled = await t.admin(`mutation($c: String!) { staffTwoFactorEnable(code: $c) { ... on StaffTwoFactorEnablePayload { recoveryCodes } } }`, { c: hotp(secret, totpCounter()) }, me);
    const challenge = async () => (await login("race-totp@example.test", password)).twoFactorChallenge.token as string;
    for (const code of [hotp(secret, totpCounter() + 1), enabled.data.staffTwoFactorEnable.recoveryCodes[0] as string]) {
      // Each sign-in checks a JWT before it reads, so on PGlite one finishes before the other reads.
      // Give the second the read it would get on PostgreSQL: the user before the first spent the code.
      const before = await getStaffUser(db, id);
      const late = Object.assign(Object.create(db) as Database, { query: { ...db.query, staffUsers: { findFirst: async () => before } } });
      await completeStaffSignIn(db, config, await challenge(), code);
      await expect(completeStaffSignIn(late, config, await challenge(), code), code).rejects.toThrow(/already used/);
    }
  });
});

describe("audit log", () => {
  it("records who changed what, with secrets redacted", async () => {
    const id = await createStaff("audited@example.test", "audited-password-123");
    await t.admin(`mutation($id: ID!) { staffUserSetPassword(id: $id, password: "replacement-password-123") { __typename } }`, { id }, auth);
    const log = await t.admin(
      `{ auditLog(first: 5, filter: { operation: "staffUserSetPassword" }) { totalCount edges { node { actorType actorLabel operation targetType targetId outcome input } } } }`,
      {},
      auth,
    );
    const entry = log.data.auditLog.edges[0].node;
    expect(entry).toMatchObject({ actorType: "STAFF", actorLabel: TEST_CREDENTIALS.adminEmail, operation: "staffUserSetPassword", targetType: "StaffUser", targetId: id, outcome: "SUCCESS" });
    expect(entry.input).toEqual({ id, password: "[redacted]" });

    const failures = await t.admin(`{ auditLog(first: 50, filter: { operation: "staffLogin", outcome: ERROR }) { totalCount edges { node { actorType actorLabel errorCode input } } } }`, {}, auth);
    expect(failures.data.auditLog.totalCount).toBeGreaterThan(0);
    expect(failures.data.auditLog.edges[0].node).toMatchObject({ actorType: "ANONYMOUS", errorCode: "UNAUTHENTICATED" });
    // GraphQL sign-ins keep the field, redacted; browser sign-ins never log it. No password is stored either way.
    const inputs = failures.data.auditLog.edges.map((e: { node: { input: Record<string, unknown> } }) => e.node.input);
    expect(inputs.filter((i: Record<string, unknown>) => "password" in i).every((i: Record<string, unknown>) => i.password === "[redacted]")).toBe(true);
    expect(JSON.stringify(inputs)).not.toMatch(/wrong-password-123|nope-nope-nope/);
  });

  it("records the connection's address, and reads X-Forwarded-For only behind trusted proxies", async () => {
    const forwarded = { "x-forwarded-for": "203.0.113.7, 198.51.100.4" };
    const signInIps = async (app: typeof t, email: string) => {
      await app.app.fetch(new Request("http://ecom.test/admin/auth/login", { method: "POST", headers: { "content-type": "application/json", ...forwarded }, body: JSON.stringify({ email, password: "not-the-password" }) }));
      await app.admin(LOGIN, { e: email, p: "not-the-password" }, forwarded);
      const admin = bearer((await app.admin(LOGIN, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword })).data.staffLogin.session.accessToken);
      const log = await app.admin(`query($s: String!) { auditLog(first: 5, filter: { search: $s }) { edges { node { ip } } } }`, { s: email }, admin);
      return log.data.auditLog.edges.map((e: { node: { ip: string | null } }) => e.node.ip);
    };
    // In-process requests have no connection address, and a header the client sent proves nothing.
    expect(await signInIps(t, "forged-ip@example.test")).toEqual([null, null]);
    const proxied = await createTestApp({ env: { TRUST_PROXY: "1" } });
    try {
      // Behind one proxy: the address it appended, not the one the client put before it.
      expect(await signInIps(proxied, "proxied-ip@example.test")).toEqual(["198.51.100.4", "198.51.100.4"]);
    } finally {
      await proxied.close();
    }
  });
});

describe("reports", () => {
  let order: Awaited<ReturnType<typeof placeStorefrontOrder>>;
  const range = () => ({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
  beforeAll(async () => {
    order = await placeStorefrontOrder("OXF-BLUE-L", 2, "report-order");
  });

  it("shows live dashboard figures per currency with work waiting", async () => {
    const result = await t.admin(
      `query($r: DateRangeInput!) { dashboard(range: $r, timeZone: "America/New_York") {
        totals { currencyCode orders itemsSold gross { amount } averageOrderValue { amount } }
        previousTotals { orders }
        series { period currencyCode orders }
        topProducts { sku quantity revenue { amount } }
        attention { awaitingFulfillment awaitingPayment failedWebhookDeliveries lowStockVariants }
      } }`,
      { r: range() },
      auth,
    );
    expect(result.errors).toBeUndefined();
    const usd = result.data.dashboard.totals.find((x: { currencyCode: string }) => x.currencyCode === "USD");
    expect(usd.orders).toBeGreaterThanOrEqual(1);
    expect(usd.itemsSold).toBeGreaterThanOrEqual(2);
    expect(Number(usd.gross.amount)).toBeGreaterThanOrEqual(Number(order.totals.total.amount));
    expect(result.data.dashboard.series.length).toBeGreaterThanOrEqual(1);
    expect(result.data.dashboard.topProducts.some((p: { sku: string }) => p.sku === "OXF-BLUE-L")).toBe(true);
    expect(result.data.dashboard.attention.awaitingFulfillment).toBeGreaterThanOrEqual(1);
  });

  it("reports sales by period, best sellers, customers, low stock and abandoned carts", async () => {
    await t.storefront(`mutation { cartCreate(input: { email: "idle@example.test", lines: [{ sku: "SOCK-BLUE", quantity: 1 }] }) { __typename } }`);
    const result = await t.admin(
      `query($r: DateRangeInput!) {
        salesReport(range: $r, granularity: DAY) { periods rows { period currencyCode orders gross { amount } } totals { currencyCode orders } }
        productSalesReport(range: $r, sortBy: REVENUE) { sku quantity variant { sku } }
        customerSalesReport(range: $r) { email orders total { amount } }
        customerSignupsReport(range: $r) { period count }
        promotionUsageReport(range: $r) { name }
        lowStockReport(threshold: 100) { onHand variant { sku } }
        abandonedCartsReport(idleMinutes: 0) { email items subtotal { amount currencyCode } }
      }`,
      { r: range() },
      auth,
    );
    expect(result.errors).toBeUndefined();
    const { salesReport, productSalesReport, customerSalesReport, lowStockReport, abandonedCartsReport } = result.data;
    expect(salesReport.periods.length).toBeGreaterThanOrEqual(1);
    expect(salesReport.rows).toHaveLength(salesReport.periods.length * salesReport.totals.length);
    expect(productSalesReport.find((p: { sku: string }) => p.sku === "OXF-BLUE-L")).toMatchObject({ quantity: 2, variant: { sku: "OXF-BLUE-L" } });
    expect(customerSalesReport[0].email).toBe("ana@example.test");
    expect(lowStockReport.length).toBeGreaterThan(0);
    expect(abandonedCartsReport.find((c: { email: string }) => c.email === "idle@example.test")).toMatchObject({ items: 1, subtotal: { amount: "18.00", currencyCode: "USD" } });
  });
});

describe("orders created by staff", () => {
  let toteVariant: string;
  beforeAll(async () => {
    const found = await t.admin(`{ productVariants(query: "TOTE-BLACK", first: 1) { totalCount edges { node { id sku } } } }`, {}, auth);
    expect(found.data.productVariants.edges[0].node.sku).toBe("TOTE-BLACK");
    toteVariant = found.data.productVariants.edges[0].node.id;
  });
  const QUOTE = `query($i: OrderDraftInput!) { orderDraftQuote(input: $i) {
    missing total { amount } shipping { amount } lines { sku quantity unitPrice { amount } issue { code } } shippingRates { code } paymentMethods { code } coupons { code applied }
  } }`;

  it("quotes a draft with the storefront pricing pipeline and reports what is missing", async () => {
    const channelId = gid("Channel", t.seed.channels.us.id);
    const bare = await t.admin(QUOTE, { i: { channelId, lines: [{ variantId: toteVariant, quantity: 2 }] } }, auth);
    expect(bare.errors).toBeUndefined();
    expect(bare.data.orderDraftQuote.missing).toEqual(expect.arrayContaining(["EMAIL", "SHIPPING_ADDRESS", "SHIPPING_METHOD", "PAYMENT_METHOD"]));
    expect(bare.data.orderDraftQuote.lines[0]).toMatchObject({ sku: "TOTE-BLACK", quantity: 2, unitPrice: { amount: "35.00" }, issue: null });

    const full = await t.admin(
      QUOTE,
      { i: { channelId, email: "phone.order@example.test", lines: [{ variantId: toteVariant, quantity: 2 }], shippingAddress: address, billingSameAsShipping: true, shippingMethodCode: "us_standard", paymentMethodCode: "checkmo", couponCodes: ["FREESHIP"] } },
      auth,
    );
    const quote = full.data.orderDraftQuote;
    expect(quote.missing).toEqual([]);
    expect(quote.shippingRates.map((r: { code: string }) => r.code)).toContain("us_standard");
    expect(quote.coupons).toEqual([{ code: "FREESHIP", applied: true }]);
    expect(quote.shipping.amount).toBe("0.00");
    // Quoting creates nothing.
    const orders = await t.admin(`{ orders(first: 1, filter: { query: "phone.order@example.test" }) { totalCount } }`, {}, auth);
    expect(orders.data.orders.totalCount).toBe(0);
  });

  it("places the draft through checkout and lets staff correct the address", async () => {
    const created = await t.admin(
      `mutation($i: OrderDraftInput!) { orderCreate(input: $i) { __typename ... on OrderPayload { order { id number email paymentMethodCode timeline { type message } } } ... on CartNotReadyError { missing } } }`,
      {
        i: {
          channelId: gid("Channel", t.seed.channels.us.id),
          customerId: gid("Customer", t.seed.customer.id),
          lines: [{ variantId: toteVariant, quantity: 1 }],
          shippingAddress: address,
          billingSameAsShipping: true,
          shippingMethodCode: "us_standard",
          paymentMethodCode: "checkmo",
          note: "Phone order",
        },
      },
      auth,
    );
    const order = created.data.orderCreate.order;
    expect(created.data.orderCreate.__typename).toBe("OrderPayload");
    expect(order.email).toBe(TEST_CREDENTIALS.customerEmail);
    expect(order.timeline.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["created_by_staff", "note"]));

    const moved = await t.admin(
      `mutation($id: ID!, $a: AddressInput!) { orderUpdateAddresses(orderId: $id, shippingAddress: $a) { __typename ... on OrderPayload { order { shippingAddress { line1 } timeline { type } } } } }`,
      { id: order.id, a: { ...address, line1: "2 Broad St" } },
      auth,
    );
    expect(moved.data.orderUpdateAddresses.order.shippingAddress.line1).toBe("2 Broad St");
    expect(moved.data.orderUpdateAddresses.order.timeline.map((e: { type: string }) => e.type)).toContain("address_updated");
  });
});

describe("customer administration", () => {
  it("manages a customer's addresses, groups and account", async () => {
    const created = await t.admin(`mutation { customerCreate(input: { email: "managed@example.test", firstName: "Mia", lastName: "Lee" }) { ... on CustomerPayload { customer { id } } } }`, {}, auth);
    const customerId = created.data.customerCreate.customer.id;
    const added = await t.admin(
      `mutation($c: ID!, $a: AddressInput!) { customerAddressCreate(customerId: $c, input: { address: $a, isDefaultShipping: true }) { __typename ... on CustomerAddressPayload { address { id isDefaultShipping } } } }`,
      { c: customerId, a: address },
      auth,
    );
    expect(added.data.customerAddressCreate.address.isDefaultShipping).toBe(true);
    const missing = await t.admin(`mutation($a: AddressInput!) { customerAddressCreate(input: { address: $a }) { __typename } }`, { a: address }, auth);
    expect(missing.data.customerAddressCreate.__typename).toBe("ValidationError");

    const reset = await t.admin(`mutation($id: ID!) { customerPasswordResetSend(id: $id) { __typename } }`, { id: customerId }, auth);
    expect(reset.data.customerPasswordResetSend.__typename).toBe("CustomerPayload");

    const builtIn = await t.admin(`mutation($id: ID!) { customerGroupDelete(id: $id) { __typename } }`, { id: gid("CustomerGroup", t.seed.groups.general.id) }, auth);
    expect(builtIn.data.customerGroupDelete.__typename).toBe("InvalidStateError");
    const group = await t.admin(`mutation { customerGroupCreate(code: "vip", name: "VIP") { ... on CustomerGroupPayload { customerGroup { id } } } }`, {}, auth);
    const groupId = group.data.customerGroupCreate.customerGroup.id;
    await t.admin(`mutation($id: ID!, $g: ID!) { customerUpdate(id: $id, input: { groupId: $g }) { __typename } }`, { id: customerId, g: groupId }, auth);
    expect((await t.admin(`mutation($id: ID!) { customerGroupDelete(id: $id) { __typename } }`, { id: groupId }, auth)).data.customerGroupDelete.__typename).toBe("DeletePayload");
    const moved = await t.admin(`query($id: ID!) { node(id: $id) { ... on Customer { group { code } } } }`, { id: customerId }, auth);
    expect(moved.data.node.group.code).toBe("general");

    const deleted = await t.admin(`mutation($id: ID!) { customerDelete(id: $id) { __typename } }`, { id: customerId }, auth);
    expect(deleted.data.customerDelete.__typename).toBe("DeletePayload");
    expect((await t.admin(`query($id: ID!) { node(id: $id) { id } }`, { id: customerId }, auth)).data.node).toBeNull();
  });

  it("refuses to delete a group that is a promotion's only group", async () => {
    const DELETE = `mutation($id: ID!) { customerGroupDelete(id: $id) { __typename ... on Error { message } } }`;
    const wholesale = gid("CustomerGroup", t.seed.groups.wholesale.id);
    const refused = (await t.admin(DELETE, { id: wholesale }, auth)).data.customerGroupDelete;
    expect(refused.__typename).toBe("InvalidStateError");
    expect(refused.message).toMatch(/Wholesale 5%/);

    const group = await t.admin(`mutation { customerGroupCreate(code: "trade", name: "Trade") { ... on CustomerGroupPayload { customerGroup { id } } } }`, {}, auth);
    const groupId = group.data.customerGroupCreate.customerGroup.id;
    const promotion = await t.admin(
      `mutation($g: [ID!]) { promotionCreate(input: { name: "Trade and wholesale", isActive: false, customerGroupIds: $g, action: { percentageOff: { percent: 5 } } }) { ... on PromotionPayload { promotion { id } } } }`,
      { g: [groupId, wholesale] },
      auth,
    );
    const promotionId = promotion.data.promotionCreate.promotion.id;
    expect((await t.admin(DELETE, { id: groupId }, auth)).data.customerGroupDelete.__typename).toBe("DeletePayload");
    const left = await t.admin(`query($id: ID!) { node(id: $id) { ... on Promotion { customerGroups { code } } } }`, { id: promotionId }, auth);
    expect(left.data.node.customerGroups).toEqual([{ code: "wholesale" }]);
    // A later test counts inactive promotions.
    expect((await t.admin(`mutation($id: ID!) { promotionDelete(id: $id) { __typename } }`, { id: promotionId }, auth)).data.promotionDelete.__typename).toBe("DeletePayload");
  });
});

describe("catalog administration", () => {
  it("updates, duplicates and protects catalog data in bulk", async () => {
    const { tote, socks } = t.seed.products;
    const bulk = await t.admin(
      `mutation($ids: [ID!]!, $c: ID!) { productBulkUpdate(ids: $ids, input: { status: DRAFT, addCategoryIds: [$c] }) { __typename ... on ProductsPayload { products { status categories { id } } } } }`,
      { ids: [gid("Product", tote.id), gid("Product", socks.id)], c: gid("Category", t.seed.categories.books.id) },
      auth,
    );
    expect(bulk.data.productBulkUpdate.products.map((p: { status: string }) => p.status)).toEqual(["DRAFT", "DRAFT"]);
    expect(bulk.data.productBulkUpdate.products[0].categories.map((c: { id: string }) => c.id)).toContain(gid("Category", t.seed.categories.books.id));

    const copy = await t.admin(`mutation($id: ID!) { productDuplicate(id: $id) { ... on ProductPayload { product { status name variants { sku } channelListings { isPublished } } } } }`, { id: gid("Product", tote.id) }, auth);
    expect(copy.data.productDuplicate.product).toMatchObject({ status: "DRAFT", name: expect.stringMatching(/ \(copy\)$/) });
    expect(copy.data.productDuplicate.product.variants.map((v: { sku: string }) => v.sku).sort()).toEqual(["TOTE-BLACK-copy", "TOTE-GREEN-copy"]);
    expect(copy.data.productDuplicate.product.channelListings.every((l: { isPublished: boolean }) => !l.isPublished)).toBe(true);

    const attributes = (await t.admin(`{ attributeDefinitions { id code } }`, {}, auth)).data.attributeDefinitions as { id: string; code: string }[];
    const brand = await t.admin(`mutation($id: ID!) { attributeDefinitionDelete(id: $id) { __typename ... on Error { message } } }`, { id: attributes.find((a) => a.code === "brand")!.id }, auth);
    expect(brand.data.attributeDefinitionDelete).toMatchObject({ __typename: "InvalidStateError" });

    const redirect = await t.admin(`mutation { urlRedirectCreate(input: { fromPath: "/old-tote", toPath: "/tote-bag" }) { __typename ... on UrlRedirectPayload { urlRedirect { id statusCode } } } }`, {}, auth);
    expect(redirect.data.urlRedirectCreate.urlRedirect.statusCode).toBe(301);
    const listed = await t.admin(`{ urlRedirects(query: "old-tote") { totalCount } }`, {}, auth);
    expect(listed.data.urlRedirects.totalCount).toBe(1);
    expect((await t.admin(`mutation($id: ID!) { urlRedirectDelete(id: $id) { __typename } }`, { id: redirect.data.urlRedirectCreate.urlRedirect.id }, auth)).data.urlRedirectDelete.__typename).toBe("DeletePayload");

    const oxford = await t.admin(`{ productVariants(query: "oxf-blue") { totalCount } }`, {}, auth);
    expect(oxford.data.productVariants.totalCount).toBe(3);
  });

  it("gives the product editor overrides, every alt text and ordered categories", async () => {
    const id = gid("Product", t.seed.products.oxford.id);
    const PRODUCT = `query($id: ID!) { node(id: $id) { ... on Product {
      taxClass { code } productType { taxClass { code } productCount } translations { locale }
      media { alts { locale value } } variants { prices { customerGroupId } } attributes { attribute { code } raw }
    } } }`;
    const UPDATE = `mutation($id: ID!, $i: ProductUpdateInput!) { productUpdate(id: $id, input: $i) { __typename ... on ProductPayload { product { taxClass { code } } } ... on Error { message } } }`;

    // A product follows its type's tax class until overridden; null removes the override again.
    const before = (await t.admin(PRODUCT, { id }, auth)).data.node;
    expect(before.taxClass).toBeNull();
    expect(before.productType.taxClass.code).toBe("standard");
    expect(before.productType.productCount).toBeGreaterThan(0);
    const overridden = await t.admin(UPDATE, { id, i: { taxClassId: gid("TaxClass", t.seed.taxClasses.reduced.id) } }, auth);
    expect(overridden.data.productUpdate.product.taxClass.code).toBe("reduced");
    expect((await t.admin(UPDATE, { id, i: { taxClassId: null } }, auth)).data.productUpdate.product.taxClass).toBeNull();

    // Alt text in every locale, and group prices keyed by the global id the price input takes.
    expect(before.media[0].alts).toEqual([{ locale: "en-US", value: "White oxford shirt" }]);
    const groupIds = before.variants.flatMap((v: { prices: { customerGroupId: string | null }[] }) => v.prices.map((p) => p.customerGroupId)).filter(Boolean);
    expect(new Set(groupIds)).toEqual(new Set([gid("CustomerGroup", t.seed.groups.wholesale.id)]));

    // One locale's translation can be deleted, but never the last one.
    expect((await t.admin(UPDATE, { id, i: { removeTranslations: ["fr-FR"] } }, auth)).data.productUpdate.__typename).toBe("ProductPayload");
    const locales = (await t.admin(PRODUCT, { id }, auth)).data.node.translations.map((tr: { locale: string }) => tr.locale);
    expect(locales).not.toContain("fr-FR");
    expect((await t.admin(UPDATE, { id, i: { removeTranslations: locales } }, auth)).data.productUpdate.__typename).toBe("ValidationError");

    // Bulk attribute edits are checked per product type and applied in one transaction.
    const BULK = `mutation($ids: [ID!]!, $a: [AttributeValueInput!]!) { productBulkUpdate(ids: $ids, input: { attributes: $a }) { __typename ... on Error { message } } }`;
    const ids = [id, gid("Product", t.seed.products.guide.id)];
    expect((await t.admin(BULK, { ids, a: [{ code: "brand", value: { option: "contoso" } }] }, auth)).data.productBulkUpdate.__typename).toBe("ProductsPayload");
    const gender = await t.admin(BULK, { ids, a: [{ code: "gender", value: { option: "unisex" } }] }, auth);
    expect(gender.data.productBulkUpdate).toMatchObject({ __typename: "ValidationError", message: expect.stringMatching(/Book product type/) });
    const after = (await t.admin(PRODUCT, { id }, auth)).data.node.attributes as { attribute: { code: string }; raw: unknown }[];
    expect(after.find((a) => a.attribute.code === "brand")?.raw).toBe("contoso");
    expect(after.find((a) => a.attribute.code === "gender")?.raw).not.toBe("unisex");
    // Localized text is merged per language: adding en-GB keeps the other translations.
    const tee = gid("Product", t.seed.products.tee.id);
    const material = await t.admin(BULK, { ids: [tee], a: [{ code: "material", value: { localizedText: [{ locale: "en-GB", value: "Cotton jersey" }] } }] }, auth);
    expect(material.data.productBulkUpdate.__typename).toBe("ProductsPayload");
    const teeAttributes = (await t.admin(PRODUCT, { id: tee }, auth)).data.node.attributes as { attribute: { code: string }; raw: unknown }[];
    expect(teeAttributes.find((a) => a.attribute.code === "material")?.raw).toEqual({ "en-US": "Cotton jersey", "en-GB": "Cotton jersey", "de-DE": "Baumwolljersey", "fr-FR": "Jersey de coton" });

    // Category positions are indexes among siblings, renumbered on every move.
    const { men, women, menShirts, accessories, books } = t.seed.categories;
    const MOVE = `mutation($id: ID!, $p: ID, $at: Int) { categoryMove(id: $id, parentId: $p, position: $at) { __typename } }`;
    await t.admin(MOVE, { id: gid("Category", books.id), p: null, at: 0 }, auth);
    await t.admin(`mutation($id: ID!) { categoryUpdate(id: $id, input: { position: 1 }) { __typename } }`, { id: gid("Category", accessories.id) }, auth);
    await t.admin(MOVE, { id: gid("Category", menShirts.id), p: gid("Category", women.id), at: 0 }, auth);
    const flat = (await t.admin(`{ categories { name position parent { id } } }`, {}, auth)).data.categories as { name: string; position: number; parent: { id: string } | null }[];
    expect(flat.map((c) => c.name)).toEqual(["Books", "Accessories", "Men", "Men's Shoes", "Women", "Men's Shirts", "Women's Tops", "Women's Shoes"]);
    expect(flat.filter((c) => c.parent?.id === gid("Category", women.id)).map((c) => c.position)).toEqual([0, 1, 2]);
    // The level it left is renumbered too: Men's Shoes moves up from 1 to 0.
    expect(flat.filter((c) => c.parent?.id === gid("Category", men.id)).map((c) => c.position)).toEqual([0]);
    const shoes = (await t.admin(`{ categories(query: "shoes") { name } }`, {}, auth)).data.categories;
    expect(shoes.map((c: { name: string }) => c.name)).toEqual(["Men's Shoes", "Women's Shoes"]);
  });

  it("imports stock counts by SKU and location code in one call", async () => {
    const IMPORT = `mutation($l: [StockLevelImportInput!]!) { stockLevelsImport(levels: $l) { __typename ... on StockLevelsImportPayload { applied results { sku error } } } }`;
    const imported = await t.admin(
      IMPORT,
      {
        l: [
          { sku: "SOCK-BLACK", locationCode: "us-east", quantity: 7 },
          { sku: "sock-blue", locationCode: "US-EAST", quantity: 3 },
          { sku: "NOPE-1", locationCode: "us-east", quantity: 1 },
          { sku: "SOCK-BLACK", locationCode: "mars", quantity: 1 },
          { sku: "SOCK-BLACK", locationCode: "us-east", quantity: 9 },
        ],
      },
      auth,
    );
    expect(imported.data.stockLevelsImport.applied).toBe(3);
    expect(imported.data.stockLevelsImport.results.map((r: { error: string | null }) => r.error)).toEqual([null, null, "No variant with this SKU", 'Unknown location "mars"', null]);
    const socks = await t.admin(`{ productVariants(query: "SOCK") { edges { node { sku stockLevels { quantity location { code } } } } } }`, {}, auth);
    const onHand = (sku: string) =>
      socks.data.productVariants.edges.find((e: { node: { sku: string } }) => e.node.sku === sku).node.stockLevels.find((l: { location: { code: string } }) => l.location.code === "us-east").quantity;
    // A repeated SKU and location keeps its last row.
    expect([onHand("SOCK-BLACK"), onHand("SOCK-BLUE")]).toEqual([9, 3]);
  });
});

describe("settings administration", () => {
  it("refuses deletes that would break references and edits the rest", async () => {
    const inUse = await t.admin(`mutation($id: ID!) { taxClassDelete(id: $id) { __typename ... on Error { message } } }`, { id: gid("TaxClass", t.seed.taxClasses.standard.id) }, auth);
    expect(inUse.data.taxClassDelete.__typename).toBe("InvalidStateError");
    expect(inUse.data.taxClassDelete.message).toMatch(/product types/);

    const zones = (await t.admin(`{ shippingZones { id name } }`, {}, auth)).data.shippingZones as { id: string }[];
    expect((await t.admin(`mutation($id: ID!) { shippingZoneDelete(id: $id) { __typename } }`, { id: zones[0]!.id }, auth)).data.shippingZoneDelete.__typename).toBe("InvalidStateError");

    await t.admin(`mutation { exchangeRateSet(baseCurrency: "USD", quoteCurrency: "CAD", rate: 1.37) { __typename } }`, {}, auth);
    const rates = await t.admin(`{ exchangeRates { baseCurrency quoteCurrency rate } }`, {}, auth);
    expect(rates.data.exchangeRates).toContainEqual({ baseCurrency: "USD", quoteCurrency: "CAD", rate: 1.37 });
    expect((await t.admin(`mutation { exchangeRateDelete(baseCurrency: "USD", quoteCurrency: "CAD") { __typename } }`, {}, auth)).data.exchangeRateDelete.__typename).toBe("ExchangeRatePayload");

    const location = await t.admin(`mutation($id: ID!) { stockLocationUpdate(id: $id, input: { name: "US East (NJ)", city: "Newark" }) { ... on StockLocationPayload { stockLocation { name city code } } } }`, { id: gid("StockLocation", t.seed.locations.usEast.id) }, auth);
    expect(location.data.stockLocationUpdate.stockLocation).toMatchObject({ name: "US East (NJ)", city: "Newark" });
  });

  it("refuses to delete a tax class that is a rule's only class", async () => {
    const createClass = async (code: string, kind: string) =>
      (await t.admin(`mutation($c: String!, $k: TaxClassKind!) { taxClassCreate(input: { code: $c, name: $c, kind: $k }) { ... on TaxClassPayload { taxClass { id } } } }`, { c: code, k: kind }, auth)).data.taxClassCreate.taxClass.id as string;
    const [exempt, diplomatic, zeroRated] = [await createClass("exempt", "CUSTOMER"), await createClass("diplomatic", "CUSTOMER"), await createClass("zero-rated", "PRODUCT")];
    const [rate] = (await t.admin(`{ taxRates { id } }`, {}, auth)).data.taxRates as { id: string }[];
    // Nothing has these classes, so the rule applies to no one, before and after.
    const rule = await t.admin(
      `mutation($i: TaxRuleInput!) { taxRuleCreate(input: $i) { ... on TaxRulePayload { taxRule { id } } } }`,
      { i: { name: "Exempt goods", productTaxClassIds: [zeroRated], customerTaxClassIds: [exempt], taxRateIds: [rate!.id] } },
      auth,
    );
    const ruleId = rule.data.taxRuleCreate.taxRule.id;
    const DELETE = `mutation($id: ID!) { taxClassDelete(id: $id) { __typename ... on Error { message } } }`;
    for (const id of [exempt, zeroRated]) {
      const refused = (await t.admin(DELETE, { id }, auth)).data.taxClassDelete;
      expect(refused.__typename).toBe("InvalidStateError");
      expect(refused.message).toMatch(/Exempt goods/);
    }

    await t.admin(`mutation($id: ID!, $c: [ID!]) { taxRuleUpdate(id: $id, input: { customerTaxClassIds: $c }) { __typename } }`, { id: ruleId, c: [exempt, diplomatic] }, auth);
    expect((await t.admin(DELETE, { id: exempt }, auth)).data.taxClassDelete.__typename).toBe("DeletePayload");
    const rules = (await t.admin(`{ taxRules { id customerTaxClasses { code } } }`, {}, auth)).data.taxRules as { id: string; customerTaxClasses: { code: string }[] }[];
    expect(rules.find((r) => r.id === ruleId)!.customerTaxClasses).toEqual([{ code: "diplomatic" }]);
  });
});

describe("restricted roles", () => {
  it("answers the reference lists a role may read and nulls the rest", async () => {
    await createStaff("picker@example.test", "picker-password-123");
    const picker = bearer((await login("picker@example.test", "picker-password-123")).session.accessToken);
    const reference = await t.admin(`{ channels { id } customerGroups { id } taxClasses { id } stockLocations { id } productTypes { id } localization { locale } }`, {}, picker);
    expect(reference.data).toMatchObject({ channels: null, taxClasses: null, customerGroups: expect.any(Array), stockLocations: expect.any(Array), productTypes: expect.any(Array), localization: { locale: expect.any(String) } });
    expect(reference.errors?.map((e) => e.extensions?.code)).toEqual(["PERMISSION_DENIED", "PERMISSION_DENIED"]);
  });

  it("shows a role that can't read channels a product's listings, and keeps them when its save leaves them out", async () => {
    await t.admin(`mutation { roleCreate(code: "merchandiser", name: "Merchandiser", permissions: ["catalog:read", "catalog:write"]) { __typename } }`, {}, auth);
    await createStaff("merchandiser@example.test", "merchandiser-password-123", "merchandiser");
    const merchandiser = bearer((await login("merchandiser@example.test", "merchandiser-password-123")).session.accessToken);
    const id = gid("Product", t.seed.products.tee.id);
    const READ = `query($id: ID!) { channels { id } node(id: $id) { ... on Product { status channelListings { channel { id } isPublished visibleInListings } } } }`;
    const before = await t.admin(READ, { id }, merchandiser);
    expect(before.data.channels).toBeNull();
    expect(before.data.node.channelListings.length).toBeGreaterThan(0);
    // What the product editor saves when the channel list is denied.
    const saved = await t.admin(`mutation($id: ID!, $i: ProductUpdateInput!) { productUpdate(id: $id, input: $i) { __typename } }`, { id, i: { status: before.data.node.status } }, merchandiser);
    expect(saved.data.productUpdate.__typename).toBe("ProductPayload");
    expect((await t.admin(READ, { id }, merchandiser)).data.node.channelListings).toEqual(before.data.node.channelListings);
  });
});

describe("preferences", () => {
  it("saves per-user settings such as grid views", async () => {
    const view = { filters: { status: "OPEN" }, columns: ["number", "total"] };
    await t.admin(`mutation($v: JSON) { staffPreferenceSet(key: "grid:orders", value: $v) { __typename } }`, { v: view }, auth);
    const read = await t.admin(`{ viewer { preferences(keys: ["grid:orders"]) { key value } } }`, {}, auth);
    expect(read.data.viewer.preferences).toEqual([{ key: "grid:orders", value: view }]);
    const bad = await t.admin(`mutation { staffPreferenceSet(key: "Bad Key", value: 1) { __typename } }`, {}, auth);
    expect(bad.data.staffPreferenceSet.__typename).toBe("ValidationError");
  });
});

describe("media uploads", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  const upload = (bytes: Buffer, name: string, headers: Record<string, string>) => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)]), name);
    return t.app.fetch(new Request("http://ecom.test/admin/media", { method: "POST", headers, body: form }));
  };

  it("stores images in the media library and serves them immutably", async () => {
    expect((await upload(PNG, "dot.png", {})).status).toBe(401);
    const response = await upload(PNG, "dot.png", auth);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string; contentType: string };
    expect(body.contentType).toBe("image/png");
    expect(body.url).toMatch(/^https?:\/\/[^/]+\/media\/\d{4}\/\d{2}\/[a-z0-9]{10}-dot\.png$/);
    const served = await t.app.fetch(new Request(body.url));
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    const svg = await upload(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), "x.svg", auth);
    expect(svg.status).toBe(415);
  });
});

describe("webhook delivery log", () => {
  type Delivery = { eventType: string; status: string; subscription: { name: string }; payload: any };
  const log = async (): Promise<Delivery[]> =>
    (await t.admin(`{ webhookDeliveries(first: 50) { edges { node { eventType status subscription { name } payload } } } }`, {}, auth)).data.webhookDeliveries.edges.map((e: { node: Delivery }) => e.node);

  it("lists deliveries across subscriptions, and never sends reset links", async () => {
    await t.admin(`mutation { webhookSubscriptionCreate(name: "ESP", url: "https://esp.example.com/hooks", events: ["customer.*"]) { __typename } }`, {}, auth);
    await t.admin(`mutation($id: ID!) { customerPasswordResetSend(id: $id) { __typename } }`, { id: gid("Customer", t.seed.customer.id) }, auth);
    await emit(t.platform.db, { type: "customer.updated", aggregateType: "Customer", aggregateId: t.seed.customer.id });
    while ((await processOutbox(t.platform)) > 0) {
      // drain earlier events too
    }
    const deliveries = await log();
    expect(deliveries.find((d) => d.eventType === "customer.updated")?.subscription.name).toBe("ESP");
    // Reset links go to plugins only (the email plugin sends them).
    expect(deliveries.some((d) => d.eventType === "customer.password_reset_requested")).toBe(false);

    // A reset delivery queued before resets became plugin-only: listed without its token, and never sent.
    const [event] = await t.platform.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, "customer.password_reset_requested"), eq(outboxEvents.aggregateId, t.seed.customer.id)))
      .limit(1);
    const [esp] = await t.platform.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.name, "ESP"));
    await t.platform.db.insert(webhookDeliveries).values({ subscriptionId: esp!.id, eventId: event!.id, eventType: event!.type });
    const queued = (await log()).find((d) => d.eventType === "customer.password_reset_requested")!;
    expect(queued.payload.data.token).toBe("[redacted]");
    expect(queued.payload.data.email).toBe(TEST_CREDENTIALS.customerEmail);
    const sent: string[] = [];
    await deliverDueWebhooks(t.platform.db, {
      fetch: async (_url, init) => {
        sent.push(init.headers["x-spindle-event"]!);
        return { status: 204 };
      },
      timeoutMs: 1000,
      maxAttempts: 3,
      batchSize: 100,
    });
    expect(sent).toContain("customer.updated");
    expect(sent).not.toContain("customer.password_reset_requested");
    expect((await log()).find((d) => d.eventType === "customer.password_reset_requested")?.status).toBe("DEAD");
  });
});

describe("admin API gaps found while building the screens", () => {
  it("clears optional fields with null and exposes what edit screens need", async () => {
    // Promotion schedule and limits can be removed again.
    const promo = await t.admin(
      `mutation { promotionCreate(input: { name: "Clearable", startsAt: "2026-01-01T00:00:00Z", usageLimit: 5, requiresCoupon: true, couponCodes: ["CLEAR-ME", "KEEP-ME"], action: { percentageOff: { percent: 5 } } }) { ... on PromotionPayload { promotion { id coupons { id code } } } } }`,
      {},
      auth,
    );
    const { id, coupons } = promo.data.promotionCreate.promotion;
    const cleared = await t.admin(`mutation($id: ID!) { promotionUpdate(id: $id, input: { startsAt: null, usageLimit: null }) { ... on PromotionPayload { promotion { startsAt usageLimit name } } } }`, { id }, auth);
    expect(cleared.data.promotionUpdate.promotion).toEqual({ startsAt: null, usageLimit: null, name: "Clearable" });
    const removed = await t.admin(`mutation($ids: [ID!]!) { couponsDelete(ids: $ids) { ... on CouponsDeletePayload { deletedIds } } }`, { ids: [coupons.find((c: { code: string }) => c.code === "CLEAR-ME").id] }, auth);
    expect(removed.data.couponsDelete.deletedIds).toHaveLength(1);
    const found = await t.admin(`{ byName: promotions(query: "clearab") { totalCount } byCode: promotions(query: "keep-me") { totalCount } inactive: promotions(isActive: false) { totalCount } }`, {}, auth);
    expect(found.data).toEqual({ byName: { totalCount: 1 }, byCode: { totalCount: 1 }, inactive: { totalCount: 0 } });

    // Customer date of birth can be removed.
    const customerId = gid("Customer", t.seed.customer.id);
    await t.admin(`mutation($id: ID!) { customerUpdate(id: $id, input: { dateOfBirth: "1990-05-01" }) { __typename } }`, { id: customerId }, auth);
    const dob = await t.admin(`mutation($id: ID!) { customerUpdate(id: $id, input: { dateOfBirth: null }) { ... on CustomerPayload { customer { dateOfBirth firstName } } } }`, { id: customerId }, auth);
    expect(dob.data.customerUpdate.customer).toEqual({ dateOfBirth: null, firstName: "Alex" });

    // Tax rate region can be removed; shipping and payment methods report their scope.
    const rate = await t.admin(`mutation { taxRateCreate(input: { code: "TEST-NY", name: "Test", countryCode: "US", regionCode: "NY", rate: 4 }) { ... on TaxRatePayload { taxRate { id } } } }`, {}, auth);
    const region = await t.admin(`mutation($id: ID!) { taxRateUpdate(id: $id, input: { regionCode: null }) { ... on TaxRatePayload { taxRate { regionCode rate } } } }`, { id: rate.data.taxRateCreate.taxRate.id }, auth);
    expect(region.data.taxRateUpdate.taxRate).toEqual({ regionCode: null, rate: 4 });
    const methods = await t.admin(`{ shippingMethods { id code allChannels taxClass { code } zone { id } } paymentMethods { code allChannels channels { code } } taxClasses { id code } }`, {}, auth);
    const standard = methods.data.shippingMethods.find((m: { code: string }) => m.code === "us_standard");
    expect(standard).toMatchObject({ allChannels: false, taxClass: null });
    const reducedId = methods.data.taxClasses.find((c: { code: string }) => c.code === "reduced").id;
    const moved = await t.admin(`mutation($id: ID!, $tax: ID!) { shippingMethodUpdate(id: $id, input: { taxClassId: $tax }) { ... on ShippingMethodPayload { shippingMethod { taxClass { code } } } } }`, { id: standard.id, tax: reducedId }, auth);
    expect(moved.data.shippingMethodUpdate.shippingMethod.taxClass.code).toBe("reduced");
    expect(methods.data.paymentMethods.find((m: { code: string }) => m.code === "card")).toMatchObject({ allChannels: true });

    // Audit search matches part of an operation name.
    const audit = await t.admin(`{ auditLog(first: 5, filter: { search: "promotionupd" }) { totalCount edges { node { operation } } } }`, {}, auth);
    expect(audit.data.auditLog.edges[0].node.operation).toBe("promotionUpdate");
  });
});
