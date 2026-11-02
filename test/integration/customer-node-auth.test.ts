import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGlobalId } from "../../src/lib/ids.ts";
import { createApiKey, issueSession } from "../../src/modules/auth/service.ts";
import { registerCustomer } from "../../src/modules/customers/service.ts";
import { orders } from "../../src/modules/orders/tables.ts";
import { createRole, createStaffUser } from "../../src/modules/staff/service.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let customerId: string;
let addressId: string;
let orderId: string;
let owner: Record<string, string>;
let stranger: Record<string, string>;
const keys: Record<string, Record<string, string>> = {};

beforeAll(async () => {
  t = await createTestApp({ env: { NODE_ENV: "production" } });
  customerId = toGlobalId("Customer", t.seed.customer.id);
  const address = (await t.platform.db.query.customerAddresses.findFirst())!;
  addressId = toGlobalId("CustomerAddress", address.id);
  const [order] = await t.platform.db.insert(orders).values({
    number: "AUTH-TEST-1", channelId: t.seed.channels.us.id, customerId: t.seed.customer.id,
    email: t.seed.customer.email, currency: "USD", locale: "en-US", billingAddress: address,
    paymentMethodCode: "offline", pricesIncludeTax: false, subtotal: 1000, discountTotal: 0,
    shippingTotal: 0, taxTotal: 0, grandTotal: 1000, totals: { taxLines: [], discounts: [], shippingDiscount: 0 },
  }).returning();
  orderId = toGlobalId("Order", order!.id);
  owner = bearer((await issueSession(t.platform.db, t.platform.config, "customer", t.seed.customer.id)).session.accessToken);
  const other = await registerCustomer(t.platform.db, { email: "other@example.test", password: "independent-password-123", firstName: "Other", lastName: "Customer" });
  stranger = bearer((await issueSession(t.platform.db, t.platform.config, "customer", other.id)).session.accessToken);
  for (const [name, permissions] of Object.entries({ catalog: ["catalog:read"], customers: ["customers:read"], writer: ["customers:write"], orders: ["orders:read"], full: ["*"] })) {
    keys[name] = bearer((await createApiKey(t.platform.db, { name, permissions })).plaintext);
  }
  const role = await createRole(t.platform.db, { code: "catalog-only", name: "Catalog only", permissions: ["catalog:read"] });
  const staff = await createStaffUser(t.platform.db, { email: "catalog-staff@example.test", name: "Catalog staff", password: "catalog-password-123", roleIds: [role.id] });
  keys.staff = bearer((await issueSession(t.platform.db, t.platform.config, "staff", staff.id)).session.accessToken);
});
afterAll(() => t.close());

const profile = `email firstName note metadata addresses { address { line1 postalCode } }`;

describe("customer object authorization", () => {
  it.each(["anonymous", "catalog", "staff"])("blocks %s Relay customer and address lookups", async (principal) => {
    const response = await t.admin(`query($c: ID!, $a: ID!) {
      customer: node(id: $c) { ... on Customer { ${profile} } }
      address: node(id: $a) { ... on CustomerAddress { address { line1 } } }
      nodes(ids: [$c, $a]) { id }
    }`, { c: customerId, a: addressId }, keys[principal] ?? {});
    expect(response.data).toEqual({ customer: null, address: null, nodes: [null, null] });
  });

  it.each(["customers", "writer", "full"])("preserves customer reads for %s grants", async (principal) => {
    const response = await t.admin(`query($id: ID!) { node(id: $id) { ... on Customer { ${profile} } } }`, { id: customerId }, keys[principal]);
    expect(response.errors).toBeUndefined();
    expect(response.data.node.email).toBe(TEST_CREDENTIALS.customerEmail);
    expect(response.data.node.addresses[0].address.line1).toBe("1 Market St");
  });

  it("enforces permissions on batched Customer lookups", async () => {
    const query = `query($id: ID!) { nodes(ids: [$id]) { ... on Customer { email addresses { address { line1 } } } } }`;
    expect((await t.admin(query, { id: customerId })).data.nodes).toEqual([null]);
    const allowed = await t.admin(query, { id: customerId }, keys.customers);
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data.nodes[0].email).toBe(TEST_CREDENTIALS.customerEmail);
  });

  it("requires order permission independently of customer permission", async () => {
    const query = `query($id: ID!) { node(id: $id) { ... on Customer { orders(first: 1) { edges { node { number } } } } } }`;
    const denied = await t.admin(query, { id: customerId }, keys.customers);
    expect(denied.errors?.[0]?.extensions?.code).toBe("PERMISSION_DENIED");
    const allowed = await t.admin(query, { id: customerId }, keys.full);
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data.node.orders.edges[0].node.number).toBe("AUTH-TEST-1");
  });

  it("does not expose customer data through orders-only nested traversal", async () => {
    const response = await t.admin(`{ order(number: "AUTH-TEST-1") { number customer { ${profile} } } }`, {}, keys.orders);
    expect(response.errors).toBeUndefined();
    expect(response.data.order).toEqual({ number: "AUTH-TEST-1", customer: null });
  });

  it.each(["anonymous", "catalog", "staff"])("blocks %s direct Order nodes carrying the same personal data", async (principal) => {
    const response = await t.admin(`query($id: ID!) { node(id: $id) { ... on Order { email billingAddress { line1 } customer { email } } } }`, { id: orderId }, keys[principal] ?? {});
    expect(response.data.node).toBeNull();
  });

  it("preserves storefront ownership and login payloads", async () => {
    const query = `query($c: ID!, $a: ID!) { node(id: $c) { ... on Customer { email addresses { address { line1 } } } } nodes(ids: [$a]) { id } }`;
    for (const headers of [{}, stranger]) {
      expect((await t.storefront(query, { c: customerId, a: addressId }, headers)).data).toEqual({ node: null, nodes: [null] });
    }
    const allowed = await t.storefront(query, { c: customerId, a: addressId }, owner);
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data.node.email).toBe(TEST_CREDENTIALS.customerEmail);
    const login = await t.storefront(`mutation($email: EmailAddress!, $password: String!) { customerLogin(email: $email, password: $password) { ... on CustomerAuthPayload { customer { email addresses { address { line1 } } } } } }`, { email: TEST_CREDENTIALS.customerEmail, password: TEST_CREDENTIALS.customerPassword });
    expect(login.errors).toBeUndefined();
    expect(login.data.customerLogin.customer.email).toBe(TEST_CREDENTIALS.customerEmail);
  });
});
