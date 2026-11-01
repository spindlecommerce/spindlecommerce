/**
 * End-to-end walkthrough against a running server (pnpm db:seed && pnpm start): a customer checks
 * out and follows the order live while staff capture, ship and partly refund it.
 *
 * Usage: node scripts/e2e-flow.ts [baseUrl]
 */
const base = process.argv[2] ?? "http://localhost:4000";
const admin = { email: process.env.SEED_ADMIN_EMAIL ?? "admin@example.com", password: process.env.SEED_ADMIN_PASSWORD ?? "dev-admin-password-123" };
const customer = { email: process.env.SEED_CUSTOMER_EMAIL ?? "alex@example.com", password: process.env.SEED_CUSTOMER_PASSWORD ?? "dev-customer-password-123" };

type Result = { data?: any; errors?: { message: string }[] };

const gql = async (path: string, query: string, variables: Record<string, unknown> = {}, token?: string): Promise<any> => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Result;
  if (body.errors?.length) throw new Error(`${path}: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
};
const storefront = (query: string, variables?: Record<string, unknown>, token?: string) => gql("/graphql", query, variables, token);
const adminApi = (query: string, variables?: Record<string, unknown>, token?: string) => gql("/admin/graphql", query, variables, token);

/** Unwrap a mutation's result union, throwing on any typed error. */
const ok = (result: any, typename: string) => {
  if (result.__typename !== typename) throw new Error(`Expected ${typename}, got ${JSON.stringify(result)}`);
  return result;
};

const step = (title: string, detail: unknown) => console.log(`\n▶ ${title}\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`);

/** GraphQL over SSE (distinct connection mode): collect `next` payloads until stopped. */
const subscribe = (query: string, variables: Record<string, unknown>, token: string) => {
  const events: any[] = [];
  const controller = new AbortController();
  const done = (async () => {
    const response = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += value;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (data && data !== "{}" && chunk.includes("event: next")) events.push(JSON.parse(data).data);
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error;
    }
  })();
  return { events, stop: async () => { controller.abort(); await done.catch(() => {}); } };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for subscription events");
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ---------------------------------------------------------------- storefront: browse

const search = await storefront(`{
  products(query: "trail", first: 5) {
    totalCount
    edges { node { name priceRange { minVariantPrice { formatted } } isAvailable } }
    facets { attribute { code } values { label count } }
  }
}`);
step("Storefront search \"trail\"", search.products);

const german = await storefront(`query @inContext(channel: "eu", locale: "de-DE") {
  product(slug: "oxford-hemd") { name priceRange { minVariantPrice { formatted } } options { attribute { label } values { label } } }
}`);
step("Same catalog in the EU channel (@inContext de-DE, EUR, tax-inclusive)", german.product);

// ---------------------------------------------------------------- storefront: sign in, cart, checkout

const login = ok(
  (await storefront(`mutation($e: EmailAddress!, $p: String!) { customerLogin(email: $e, password: $p) { __typename ... on CustomerAuthPayload { customer { firstName } session { accessToken } } } }`, { e: customer.email, p: customer.password })).customerLogin,
  "CustomerAuthPayload",
);
const token = login.session.accessToken as string;
step("Customer signed in", { customer: login.customer.firstName });

const me = await storefront(`{ me { defaultShippingAddress { id } } }`, {}, token);
const addressId = me.me.defaultShippingAddress.id;
const created = ok(
  (await storefront(`mutation { cartCreate(input: { lines: [{ sku: "TRL-BLACK-42", quantity: 1 }, { sku: "SOCK-BLUE", quantity: 3 }] }) { __typename ... on CartPayload { cart { id } } } }`, {}, token)).cartCreate,
  "CartPayload",
);
const cartId = created.cart.id;
const prepared = await storefront(`mutation($c: ID!, $a: ID!) {
  s: cartShippingAddressSet(cartId: $c, address: { customerAddressId: $a }) { __typename }
  b: cartBillingAddressSet(cartId: $c, address: { sameAsShipping: true }) { __typename }
  m: cartShippingMethodSet(cartId: $c, shippingMethodCode: "us_free") { __typename }
  coupon: cartCouponApply(cartId: $c, code: "FREESHIP") { __typename ... on Error { message } }
  p: cartPaymentMethodSet(cartId: $c, paymentMethodCode: "card") {
    __typename
    ... on CartPayload { cart {
      checkoutReady
      coupons { code applied reason }
      lines { name quantity unitPrice { formatted } discount { formatted } total { formatted } }
      discounts { name amount { formatted } }
      cost { subtotal { formatted } discountTotal { formatted } shipping { formatted } tax { formatted } total { formatted } taxLines { name rate } }
    } }
  }
}`, { c: cartId, a: addressId }, token);
step("Cart priced by the totals pipeline", prepared.p.cart);

const placed = ok(
  (await storefront(`mutation($c: ID!) { checkoutPlaceOrder(cartId: $c, idempotencyKey: "e2e-${Date.now()}", payment: { token: "tok_visa" }) { __typename ... on CheckoutPayload { order { id number status paymentStatus totals { total { formatted } } } } ... on Error { code message } } }`, { c: cartId }, token)).checkoutPlaceOrder,
  "CheckoutPayload",
);
const order = placed.order;
step("Order placed (card authorized, stock reserved)", order);

const subscription = subscribe(`subscription($id: ID!) { orderUpdated(orderId: $id) { eventType status paymentStatus fulfillmentStatus } }`, { id: order.id }, token);
await new Promise((r) => setTimeout(r, 300));

// ---------------------------------------------------------------- admin: capture, ship, refund

const staff = ok(
  (await adminApi(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { __typename ... on StaffAuthPayload { session { accessToken } } } }`, { e: admin.email, p: admin.password })).staffLogin,
  "StaffAuthPayload",
);
const staffToken = staff.session.accessToken as string;

const captured = ok((await adminApi(`mutation($id: ID!) { orderCapturePayment(orderId: $id) { __typename ... on OrderPayload { order { paymentStatus invoices { number amount { formatted } } } } } }`, { id: order.id }, staffToken)).orderCapturePayment, "OrderPayload");
step("Staff captured the payment", captured.order);

const shipped = ok(
  (await adminApi(`mutation($id: ID!) { orderFulfill(orderId: $id, input: { tracking: [{ carrier: "UPS", number: "1Z999AA10123456784" }] }) { __typename ... on OrderPayload { order { status fulfillmentStatus fulfillments { number } lines { id sku } } } } }`, { id: order.id }, staffToken)).orderFulfill,
  "OrderPayload",
);
step("Staff shipped the order", { status: shipped.order.status, fulfillmentStatus: shipped.order.fulfillmentStatus, fulfillments: shipped.order.fulfillments });

const sockLine = shipped.order.lines.find((l: any) => l.sku === "SOCK-BLUE");
const refunded = ok(
  (await adminApi(`mutation($id: ID!, $line: ID!) { orderRefund(orderId: $id, input: { lines: [{ orderLineId: $line, quantity: 1 }], reason: "Wrong size" }) { __typename ... on OrderPayload { order { paymentStatus totals { paid { formatted } refunded { formatted } } } } } }`, { id: order.id, line: sockLine.id }, staffToken)).orderRefund,
  "OrderPayload",
);
step("Staff refunded one pair of socks", refunded.order);

await waitFor(() => subscription.events.some((e) => e.orderUpdated.eventType === "order.refunded"));
await subscription.stop();
step("Customer's live orderUpdated subscription (SSE) received", subscription.events.map((e) => `${e.orderUpdated.eventType} → ${e.orderUpdated.status}/${e.orderUpdated.paymentStatus}/${e.orderUpdated.fulfillmentStatus}`).join("\n"));

const timeline = await adminApi(`query($id: ID!) { node(id: $id) { ... on Order { number timeline { type message } } } }`, { id: order.id }, staffToken);
step("Order timeline (admin)", timeline.node.timeline.map((e: any) => `${e.type}: ${e.message}`).join("\n"));
console.log("\n✔ End-to-end flow completed");
