import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGlobalId } from "../../src/lib/ids.ts";
import { deliverDueWebhooks, verifySignature } from "../../src/modules/integrations/webhooks.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { createRole, createStaffUser } from "../../src/modules/staff/service.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;
const gid = (type: string, id: string) => toGlobalId(type, id);

beforeAll(async () => {
  t = await createTestApp();
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { __typename ... on StaffAuthPayload { session { accessToken } staffUser { name } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

/** Place a card order through the storefront API. */
const placeStorefrontOrder = async (sku: string, quantity: number, key: string) => {
  const address = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };
  const cart = await t.storefront(`mutation($sku: String!, $q: Int!) { cartCreate(input: { email: "ana@example.test", lines: [{ sku: $sku, quantity: $q }] }) { ... on CartPayload { cart { id } } } }`, { sku, q: quantity });
  const id = cart.data.cartCreate.cart.id;
  await t.storefront(`mutation($id: ID!, $a: AddressInput!) {
    a: cartShippingAddressSet(cartId: $id, address: { address: $a }) { __typename }
    b: cartBillingAddressSet(cartId: $id, address: { sameAsShipping: true }) { __typename }
    c: cartShippingMethodSet(cartId: $id, shippingMethodCode: "us_standard") { __typename }
    d: cartPaymentMethodSet(cartId: $id, paymentMethodCode: "card") { __typename }
  }`, { id, a: address });
  const order = await t.storefront(`mutation($id: ID!, $k: String!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: $k) { __typename ... on CheckoutPayload { order { id number } } } }`, { id, k: key });
  return order.data.checkoutPlaceOrder.order as { id: string; number: string };
};

describe("admin access control", () => {
  it("requires credentials and reports the caller", async () => {
    const anonymous = await t.admin(`{ orders(first: 1) { totalCount } }`);
    expect(anonymous.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    const viewer = await t.admin(`{ viewer { staffUser { email } permissions } }`, {}, auth);
    expect(viewer.data.viewer).toEqual({ staffUser: { email: TEST_CREDENTIALS.adminEmail }, permissions: ["*"] });
  });

  it("issues least-privilege API keys", async () => {
    const created = await t.admin(`mutation { apiKeyCreate(name: "Warehouse", permissions: ["orders:read", "inventory:write"]) { ... on ApiKeyCreatePayload { secret apiKey { prefix permissions } } } }`, {}, auth);
    const { secret, apiKey } = created.data.apiKeyCreate;
    expect(secret).toMatch(/^ek_[A-Za-z0-9]{8}_/);
    expect(apiKey.permissions).toEqual(["orders:read", "inventory:write"]);
    const key = bearer(secret);
    expect((await t.admin(`{ orders(first: 1) { totalCount } }`, {}, key)).errors).toBeUndefined();
    const denied = await t.admin(`mutation { categoryCreate(input: { translations: [{ locale: "en-US", name: "Nope" }] }) { __typename ... on PermissionDeniedError { permission } } }`, {}, key);
    expect(denied.data.categoryCreate).toEqual({ __typename: "PermissionDeniedError", permission: "catalog:write" });
  });

  it("does not let callers delegate permissions they do not have", async () => {
    const role = await createRole(t.platform.db, { code: "integration-manager", name: "Integration manager", permissions: ["integrations:write"] });
    await createStaffUser(t.platform.db, { email: "integration-manager@example.test", name: "Integration manager", password: "integration-test-password", roleIds: [role.id] });
    const login = await t.admin(`mutation { staffLogin(email: "integration-manager@example.test", password: "integration-test-password") { ... on StaffAuthPayload { session { accessToken } } } }`);
    const manager = bearer(login.data.staffLogin.session.accessToken);

    const escalated = await t.admin(`mutation { apiKeyCreate(name: "Unrestricted", permissions: ["*"]) { __typename ... on PermissionDeniedError { permission } } }`, {}, manager);
    expect(escalated.data.apiKeyCreate).toEqual({ __typename: "PermissionDeniedError", permission: "*" });

    const delegated = await t.admin(`mutation { apiKeyCreate(name: "Child", permissions: ["integrations:write"]) { ... on ApiKeyCreatePayload { secret } } }`, {}, manager);
    const child = bearer(delegated.data.apiKeyCreate.secret);
    const nested = await t.admin(`mutation { apiKeyCreate(name: "Grandchild", permissions: ["integrations:read"]) { __typename ... on InvalidStateError { message } } }`, {}, child);
    expect(nested.data.apiKeyCreate).toEqual({ __typename: "InvalidStateError", message: "Only staff users have an account; API keys do not" });
  });

  it("keeps staff management within the caller's own permissions", async () => {
    const managerRole = await createRole(t.platform.db, { code: "staff-manager", name: "Staff manager", permissions: ["staff:write", "orders:write"] });
    const clerkRole = await createRole(t.platform.db, { code: "order-clerk", name: "Order clerk", permissions: ["orders:read"] });
    const managerUser = await createStaffUser(t.platform.db, { email: "staff-manager@example.test", name: "Staff manager", password: "staff-manager-password", roleIds: [managerRole.id] });
    const clerk = await createStaffUser(t.platform.db, { email: "order-clerk@example.test", name: "Order clerk", password: "order-clerk-password", roleIds: [clerkRole.id] });
    const login = await t.admin(`mutation { staffLogin(email: "staff-manager@example.test", password: "staff-manager-password") { ... on StaffAuthPayload { session { accessToken } } } }`);
    const manager = bearer(login.data.staffLogin.session.accessToken);
    const adminRole = (await t.admin(`{ roles { id code } }`, {}, auth)).data.roles.find((r: { code: string }) => r.code === "admin").id;
    const admin = (await t.admin(`{ staffUsers { id email } }`, {}, auth)).data.staffUsers.find((u: { email: string }) => u.email === TEST_CREDENTIALS.adminEmail).id;
    const run = async (mutation: string) => (await t.admin(`mutation { result: ${mutation} { __typename ... on PermissionDeniedError { permission } } }`, {}, manager)).data.result;
    const denied = (permission: string) => ({ __typename: "PermissionDeniedError", permission });

    // Nothing the manager lacks can be granted: in a role, or through the roles they assign.
    expect(await run(`roleCreate(code: "everything", name: "Everything", permissions: ["*"])`)).toEqual(denied("*"));
    expect(await run(`roleUpdate(id: "${gid("Role", managerRole.id)}", permissions: ["staff:write", "orders:write", "settings:write"])`)).toEqual(denied("settings:write"));
    expect(await run(`staffUserCreate(input: { email: "mole@example.test", name: "Mole", password: "mole-password-123", roleIds: ["${adminRole}"] })`)).toEqual(denied("*"));
    expect(await run(`staffUserUpdate(id: "${gid("StaffUser", managerUser.id)}", input: { roleIds: ["${adminRole}"] })`)).toEqual(denied("*"));
    // Administrators, and their role, are out of reach.
    for (const mutation of [
      `staffUserSetPassword(id: "${admin}", password: "taken-over-password")`,
      `staffUserResetTwoFactor(id: "${admin}")`,
      `staffUserUnlock(id: "${admin}")`,
      `staffUserUpdate(id: "${admin}", input: { isActive: false })`,
      `roleUpdate(id: "${adminRole}", name: "Former administrators")`,
    ]) {
      expect(await run(mutation), mutation).toEqual(denied("*"));
    }
    const adminLogin = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { __typename } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
    expect(adminLogin.data.staffLogin.__typename).toBe("StaffAuthPayload");

    // Within the manager's own permissions (write implies read), it all works.
    expect((await run(`roleCreate(code: "order-viewer", name: "Order viewer", permissions: ["orders:read"])`)).__typename).toBe("RolePayload");
    expect((await run(`staffUserCreate(input: { email: "order-clerk-2@example.test", name: "Second clerk", password: "order-clerk-password", roleIds: ["${gid("Role", clerkRole.id)}"] })`)).__typename).toBe("StaffUserPayload");
    expect((await run(`staffUserSetPassword(id: "${gid("StaffUser", clerk.id)}", password: "new-clerk-password")`)).__typename).toBe("StaffUserPayload");
    expect((await run(`staffUserResetTwoFactor(id: "${gid("StaffUser", clerk.id)}")`)).__typename).toBe("StaffUserPayload");
  });
});

describe("admin catalog", () => {
  let productId: string;

  it("creates a configurable product with typed attributes, prices and stock in one mutation", async () => {
    const { usEast } = t.seed.locations;
    const result = await t.admin(`mutation($input: ProductCreateInput!) {
      productCreate(input: $input) {
        __typename
        ... on ProductPayload { product { id status name variants { sku selectedOptions { attribute value } prices { amount { amount currencyCode } } stockLevels { quantity } } } }
        ... on ValidationError { fieldErrors { path message } }
      }
    }`, {
      input: {
        productTypeId: gid("ProductType", t.seed.products.oxford.productTypeId),
        status: "ACTIVE",
        translations: [{ locale: "en-US", name: "Field Jacket", description: "<p>Waxed cotton field jacket.</p>" }],
        attributes: [
          { code: "brand", value: { option: "northwind" } },
          { code: "gender", value: { option: "men" } },
          { code: "material", value: { localizedText: [{ locale: "en-US", value: "Waxed cotton" }] } },
        ],
        categoryIds: [gid("Category", t.seed.categories.men.id)],
        channelListings: [{ channelId: gid("Channel", t.seed.channels.us.id) }],
        variants: ["m", "l"].map((size) => ({
          sku: `JKT-GREEN-${size.toUpperCase()}`,
          options: [{ attribute: "color", value: "green" }, { attribute: "size", value: size }],
          weightGrams: 1200,
          prices: [{ channelId: gid("Channel", t.seed.channels.us.id), currencyCode: "USD", amount: "189.00" }],
          stock: [{ locationId: gid("StockLocation", usEast.id), quantity: 7 }],
        })),
      },
    }, auth);
    expect(result.data.productCreate.__typename).toBe("ProductPayload");
    const product = result.data.productCreate.product;
    productId = product.id;
    expect(product.status).toBe("ACTIVE");
    expect(product.variants[0]).toEqual({
      sku: "JKT-GREEN-M",
      selectedOptions: [{ attribute: "color", value: "green" }, { attribute: "size", value: "m" }],
      prices: [{ amount: { amount: "189.00", currencyCode: "USD" } }],
      stockLevels: [{ quantity: 7 }],
    });
    // Immediately searchable on the storefront: projections update in the same transaction.
    const found = await t.storefront(`{ products(query: "jacket") { edges { node { name isAvailable } } } }`);
    expect(found.data.products.edges).toEqual([{ node: { name: "Field Jacket", isAvailable: true } }]);
  });

  it("validates attribute values against their definitions", async () => {
    const result = await t.admin(`mutation($id: ID!) {
      productUpdate(id: $id, input: { attributes: [{ code: "brand", value: { option: "unknown-brand" } }] }) { __typename ... on ValidationError { fieldErrors { path message } } }
    }`, { id: productId }, auth);
    expect(result.data.productUpdate.__typename).toBe("ValidationError");
    expect(result.data.productUpdate.fieldErrors[0]).toEqual({ path: ["input", "attributes", "brand"], message: "Expected one of acme, northwind, contoso" });
  });

  it("keeps old URLs working after a slug change", async () => {
    await t.admin(`mutation($id: ID!) { productUpdate(id: $id, input: { translations: [{ locale: "en-US", name: "Waxed Field Jacket", slug: "waxed-field-jacket" }] }) { __typename } }`, { id: productId }, auth);
    const route = await t.storefront(`{ route(path: "/field-jacket") { __typename ... on Redirect { location statusCode } } }`);
    expect(route.data.route).toEqual({ __typename: "Redirect", location: "/waxed-field-jacket", statusCode: 301 });
    // Omitted lists (categories, listings, media) are left untouched by updates.
    const still = await t.storefront(`{ product(slug: "waxed-field-jacket") { name categories { name } } }`);
    expect(still.data.product).toEqual({ name: "Waxed Field Jacket", categories: [{ name: "Men" }] });
  });

  it("moves category subtrees", async () => {
    const { men, menShoes, accessories } = t.seed.categories;
    const moved = await t.admin(`mutation($id: ID!, $parent: ID) { categoryMove(id: $id, parentId: $parent) { ... on CategoryPayload { category { path depth parent { name } } } } }`, {
      id: gid("Category", menShoes.id),
      parent: gid("Category", accessories.id),
    }, auth);
    expect(moved.data.categoryMove.category).toEqual({ path: "accessories/men-s-shoes", depth: 1, parent: { name: "Accessories" } });
    const cycle = await t.admin(`mutation($id: ID!, $parent: ID) { categoryMove(id: $id, parentId: $parent) { __typename ... on ValidationError { message } } }`, {
      id: gid("Category", accessories.id),
      parent: gid("Category", menShoes.id),
    }, auth);
    expect(cycle.data.categoryMove).toEqual({ __typename: "ValidationError", message: "Cannot move a category into its own subtree" });
    await t.admin(`mutation($id: ID!, $parent: ID) { categoryMove(id: $id, parentId: $parent) { __typename } }`, { id: gid("Category", menShoes.id), parent: gid("Category", men.id) }, auth);
  });

  it("sorts products by name and by lowest price", async () => {
    type Row = { node: { name: string; priceRange: { minVariantPrice: { amount: string } } | null } };
    const list = async (sort: string) => (await t.admin(`{ products(first: 50, sort: ${sort}) { totalCount edges { node { name priceRange { minVariantPrice { amount } } } } } }`, {}, auth)).data.products;
    const ordered = <T>(values: T[], before: (a: T, b: T) => boolean) => values.every((v, i) => i === 0 || !before(v, values[i - 1]!));
    const names = (sort: string) => list(sort).then((r) => r.edges.map((e: Row) => e.node.name.toLowerCase()) as string[]);
    expect(ordered(await names("{ field: NAME }"), (a, b) => a < b)).toBe(true);
    expect(ordered(await names("{ field: NAME, direction: DESC }"), (a, b) => a > b)).toBe(true);
    const prices: (number | null)[] = (await list("{ field: PRICE, direction: ASC }")).edges.map((e: Row) => (e.node.priceRange ? Number(e.node.priceRange.minVariantPrice.amount) : null));
    const priced = prices.filter((p): p is number => p !== null);
    expect(priced.length).toBeGreaterThan(3);
    expect(ordered(priced, (a, b) => a < b)).toBe(true);
    // Products without a price come last.
    expect(prices.slice(0, priced.length).every((p) => p !== null)).toBe(true);
    // The default stays newest first, paged by id.
    expect((await list("{ field: NEWEST }")).totalCount).toBe((await list("{ field: NAME }")).totalCount);
  });
});

describe("admin order management", () => {
  it("captures, ships and refunds, keeping an audit timeline", async () => {
    const order = await placeStorefrontOrder("TOTE-GREEN", 3, "admin-flow-0001");
    const list = await t.admin(`{ orders(first: 5, filter: { paymentStatus: AUTHORIZED }) { totalCount edges { node { number } } } }`, {}, auth);
    expect(list.data.orders.edges.map((e: any) => e.node.number)).toContain(order.number);

    const captured = await t.admin(`mutation($id: ID!) { orderCapturePayment(orderId: $id) { ... on OrderPayload { order { paymentStatus invoices { number } } } } }`, { id: order.id }, auth);
    expect(captured.data.orderCapturePayment.order.paymentStatus).toBe("PAID");

    const shipped = await t.admin(`mutation($id: ID!) {
      orderFulfill(orderId: $id, input: { tracking: [{ carrier: "UPS", number: "1Z999AA10123456784" }] }) {
        ... on OrderPayload { order { status fulfillmentStatus fulfillments { number tracking { carrier number } lines { quantity } } lines { id quantityFulfilled } } }
      }
    }`, { id: order.id }, auth);
    const shippedOrder = shipped.data.orderFulfill.order;
    expect(shippedOrder).toMatchObject({ status: "COMPLETED", fulfillmentStatus: "FULFILLED", fulfillments: [{ tracking: [{ carrier: "UPS", number: "1Z999AA10123456784" }], lines: [{ quantity: 3 }] }] });

    const refund = await t.admin(`mutation($id: ID!, $line: ID!) {
      orderRefund(orderId: $id, input: { lines: [{ orderLineId: $line, quantity: 1 }], shippingAmount: "5.99", reason: "Arrived damaged" }) {
        __typename ... on OrderPayload { order { paymentStatus totals { refunded { amount } } refunds { number reason lines { quantity restocked } } } }
      }
    }`, { id: order.id, line: shippedOrder.lines[0].id }, auth);
    const refunded = refund.data.orderRefund.order;
    expect(refunded.paymentStatus).toBe("PARTIALLY_REFUNDED");
    // One tote of three: (3 × 35.00 × 1.08875) / 3 = 38.11 (rounded), plus shipping 5.99.
    expect(refunded.totals.refunded.amount).toBe("44.10");
    expect(refunded.refunds[0]).toMatchObject({ reason: "Arrived damaged", lines: [{ quantity: 1, restocked: true }] });

    const tooMuch = await t.admin(`mutation($id: ID!) { orderRefund(orderId: $id, input: { shippingAmount: "1.00" }) { __typename ... on Error { message } } }`, { id: order.id }, auth);
    expect(tooMuch.data.orderRefund.__typename).toBe("ValidationError");

    const timeline = await t.admin(`query($id: ID!) { node(id: $id) { ... on Order { timeline { type actorType } } } }`, { id: order.id }, auth);
    expect(timeline.data.node.timeline.map((e: any) => e.type)).toEqual(["placed", "payment_authorized", "payment_captured", "fulfilled", "completed", "refunded"]);
  });

  it("will not cancel a shipped order", async () => {
    const order = await placeStorefrontOrder("SOCK-BLACK", 1, "admin-flow-0002");
    await t.admin(`mutation($id: ID!) { orderFulfill(orderId: $id) { __typename } }`, { id: order.id }, auth);
    const cancel = await t.admin(`mutation($id: ID!) { orderCancel(orderId: $id) { __typename ... on InvalidStateError { message } } }`, { id: order.id }, auth);
    expect(cancel.data.orderCancel).toEqual({ __typename: "InvalidStateError", message: "Shipped orders cannot be canceled; refund them instead" });
  });
});

describe("admin promotions", () => {
  it("creates a rule from a typed @oneOf condition tree and generates coupons", async () => {
    const created = await t.admin(`mutation($input: PromotionInput!) { promotionCreate(input: $input) { __typename ... on PromotionPayload { promotion { id name conditions action requiresCoupon } } ... on ValidationError { fieldErrors { path message } } } }`, {
      input: {
        name: "Footwear weekend",
        requiresCoupon: true,
        conditions: {
          all: [
            { subtotal: { operator: "GTE", amounts: [{ currencyCode: "USD", amount: "100.00" }] } },
            { lineMatches: { predicate: { categoryIn: [gid("Category", t.seed.categories.womenShoes.id)] } } },
          ],
        },
        action: { fixedOffCart: { amounts: [{ currencyCode: "USD", amount: "15.00" }] } },
      },
    }, auth);
    expect(created.data.promotionCreate.__typename).toBe("PromotionPayload");
    const promotion = created.data.promotionCreate.promotion;
    expect(promotion.conditions).toEqual({
      type: "all",
      conditions: [
        { type: "subtotal", operator: "gte", amounts: { USD: 10000 } },
        { type: "line_matches", predicate: { type: "category_in", categoryIds: [t.seed.categories.womenShoes.id] } },
      ],
    });
    const coupons = await t.admin(`mutation($id: ID!) { couponsGenerate(promotionId: $id, quantity: 3, prefix: "FW-") { ... on CouponsGeneratePayload { coupons { code } } } }`, { id: promotion.id }, auth);
    expect(coupons.data.couponsGenerate.coupons).toHaveLength(3);
    expect(coupons.data.couponsGenerate.coupons.every((c: any) => c.code.startsWith("FW-"))).toBe(true);

    const bothFields = await t.admin(`mutation { promotionCreate(input: { name: "x", action: { percentageOff: { percent: 5 }, shippingOff: { percent: 100 } } }) { __typename } }`, {}, auth);
    expect(bothFields.errors?.[0]?.message).toMatch(/exactly one/i);
  });
});

describe("admin webhooks", () => {
  it("delivers signed events from the outbox", async () => {
    // Subscriptions receive events processed after they exist; drain earlier tests' events first.
    while ((await processOutbox(t.platform)) > 0);
    const created = await t.admin(`mutation { webhookSubscriptionCreate(name: "ERP", url: "https://erp.example.test/hooks", events: ["order.*"]) { ... on WebhookSubscriptionCreatePayload { secret webhookSubscription { id } } } }`, {}, auth);
    const { secret } = created.data.webhookSubscriptionCreate;
    const order = await placeStorefrontOrder("TOTE-BLACK", 1, "webhook-flow-0001");
    await processOutbox(t.platform);
    const received: { headers: Record<string, string>; body: string }[] = [];
    const result = await deliverDueWebhooks(t.platform.db, {
      fetch: async (_url, init) => {
        received.push({ headers: init.headers, body: init.body });
        return { status: 204 };
      },
      timeoutMs: 1000,
      maxAttempts: 3,
      batchSize: 50,
    });
    expect(result.failed).toBe(0);
    const placed = received.find((r) => r.headers["x-spindle-event"] === "order.placed");
    expect(placed).toBeDefined();
    expect(verifySignature(secret, placed!.body, placed!.headers["x-spindle-signature"]!)).toBe(true);
    expect(JSON.parse(placed!.body).data.aggregateId).toBe(order.id.split("/").pop());
    const deliveries = await t.admin(`{ webhookSubscriptions { deliveries { eventType status } } }`, {}, auth);
    expect(deliveries.data.webhookSubscriptions[0].deliveries.every((d: any) => d.status === "SUCCEEDED")).toBe(true);
  });
});
