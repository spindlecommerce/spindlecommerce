import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const MONEY = "amount currencyCode formatted";

describe("storefront catalog", () => {
  it("searches with prefix matching, facets and a price range", async () => {
    const { data, errors } = await t.storefront(`{
      products(query: "shir", first: 10) {
        totalCount
        edges { node { name slug priceRange { minVariantPrice { ${MONEY} } } } }
        facets { attribute { code label } values { value label count selected } }
        priceRange { minimum { amount } maximum { amount } }
      }
    }`);
    expect(errors).toBeUndefined();
    expect(data.products.edges.map((e: any) => e.node.name).sort()).toEqual(["Oxford Shirt"]);
    expect(data.products.edges[0].node.priceRange.minVariantPrice).toEqual({ amount: "59.00", currencyCode: "USD", formatted: "$59.00" });
    const color = data.products.facets.find((f: any) => f.attribute.code === "color");
    expect(color.values.map((v: any) => v.value).sort()).toEqual(["blue", "white"]);
  });

  it("filters by attribute with disjunctive facet counts", async () => {
    const { data } = await t.storefront(`query($filter: ProductFilter) {
      products(filter: $filter, first: 20, sort: { field: NAME }) {
        totalCount
        edges { node { name } }
        facets { attribute { code } values { value count selected } }
      }
    }`, { filter: { attributes: [{ code: "color", values: ["green"] }] } });
    expect(data.products.edges.map((e: any) => e.node.name)).toEqual(["Market Tote", "Trail Runner GTX"]);
    const color = data.products.facets.find((f: any) => f.attribute.code === "color");
    // Selecting green keeps the other colors' counts (what you'd get by also selecting them).
    expect(color.values.find((v: any) => v.value === "green")).toEqual({ value: "green", count: 2, selected: true });
    expect(color.values.find((v: any) => v.value === "black").count).toBeGreaterThan(0);
  });

  it("switches channel, locale and currency with @inContext", async () => {
    const { data } = await t.storefront(`query @inContext(channel: "eu", locale: "de-DE") {
      localization { channel { code } locale currencyCode }
      product(slug: "oxford-hemd") { name slug priceRange { minVariantPrice { ${MONEY} } } attributes { attribute { label } value } }
    }`);
    expect(data.localization).toEqual({ channel: { code: "eu" }, locale: "de-DE", currencyCode: "EUR" });
    expect(data.product.name).toBe("Oxford-Hemd");
    // Intl separates amount and symbol with a no-break space.
    expect(data.product.priceRange.minVariantPrice.formatted).toBe("59,00 €");
    expect(data.product.attributes).toContainEqual({ attribute: { label: "Material" }, value: "Bio-Baumwolle" });

    const gbp = await t.storefront(`query @inContext(channel: "eu", locale: "en-GB", currency: "GBP") { product(sku: "TEE-RED-S") { name priceRange { minVariantPrice { ${MONEY} } } } }`);
    expect(gbp.data.product.priceRange.minVariantPrice).toEqual({ amount: "20.64", currencyCode: "GBP", formatted: "£20.64" });
  });

  it("exposes variant axes and resolves a variant by its options", async () => {
    const { data } = await t.storefront(`{
      product(slug: "oxford-shirt") {
        options { attribute { code } values { code label } }
        variant(selectedOptions: [{ attribute: "color", value: "blue" }, { attribute: "size", value: "m" }]) {
          sku name isAvailable quantityAvailable selectedOptions { attribute value label }
        }
        categories { name path }
      }
    }`);
    expect(data.product.options.map((o: any) => [o.attribute.code, o.values.map((v: any) => v.code)])).toEqual([
      ["color", ["white", "blue"]],
      ["size", ["s", "m", "l"]],
    ]);
    expect(data.product.variant).toMatchObject({ sku: "OXF-BLUE-M", name: "Oxford Shirt – Blue / M", isAvailable: true, quantityAvailable: 25 });
    expect(data.product.categories).toEqual([{ name: "Men's Shirts", path: "men/men-s-shirts" }]);
  });

  it("walks the category tree and routes URL paths", async () => {
    const { data } = await t.storefront(`{
      categoryTree { name children { name } }
      route(path: "/men/men-s-shoes") { __typename ... on Category { name products(first: 5) { totalCount edges { node { name } } } } }
      page: route(path: "/about") { __typename ... on Page { title } }
      missing: route(path: "/nope") { __typename }
    }`);
    expect(data.categoryTree.map((c: any) => c.name)).toEqual(["Men", "Women", "Accessories", "Books"]);
    expect(data.categoryTree[0].children.map((c: any) => c.name)).toEqual(["Men's Shirts", "Men's Shoes"]);
    expect(data.route).toEqual({ __typename: "Category", name: "Men's Shoes", products: { totalCount: 1, edges: [{ node: { name: "Trail Runner GTX" } }] } });
    expect(data.page).toEqual({ __typename: "Page", title: "About us" });
    expect(data.missing).toBeNull();
  });

  it("routes canonical product and category URLs strictly", async () => {
    const { data } = await t.storefront(`{
      product: route(path: "/products/oxford-shirt") { __typename ... on Product { name } }
      notAProduct: route(path: "/products/men") { __typename }
      category: route(path: "/categories/men/men-s-shirts") { __typename ... on Category { name } }
      shortened: route(path: "/categories/men-s-shirts") { __typename ... on Redirect { location statusCode } }
      home: route(path: "/") { __typename ... on Page { title } }
      newest: products(first: 2, sort: { field: NEWEST }) { edges { node { name } } }
      oldest: products(first: 1, sort: { field: NEWEST, direction: ASC }) { edges { node { name } } }
    }`);
    expect(data.product).toEqual({ __typename: "Product", name: "Oxford Shirt" });
    expect(data.notAProduct).toBeNull();
    expect(data.category).toEqual({ __typename: "Category", name: "Men's Shirts" });
    expect(data.shortened).toEqual({ __typename: "Redirect", location: "/categories/men/men-s-shirts", statusCode: 301 });
    expect(data.home).toEqual({ __typename: "Page", title: "Home" });
    // Newest first unless asked otherwise (the gift card is the last product seeded).
    expect(data.newest.edges[0].node.name).toBe("Digital Gift Card");
    expect(data.oldest.edges[0].node.name).toBe("Oxford Shirt");
  });

  it("hides drafts and admin-only fields from the storefront", async () => {
    const draft = await t.storefront(`{ product(sku: "BLS-WHITE-M") { name } }`);
    expect(draft.data.product).toBeNull();
    const adminField = await t.storefront(`{ product(slug: "oxford-shirt") { status } }`);
    expect(adminField.errors?.[0]?.message).toMatch(/Cannot query field "status"/);
    const adminQuery = await t.storefront(`{ orders(first: 1) { totalCount } }`);
    expect(adminQuery.errors?.[0]?.message).toMatch(/Cannot query field "orders"/);
  });

  it("rejects queries over the depth limit", async () => {
    const deep = `{ categoryTree { children { children { children { children { children { children { children { children { children { children { children { name } } } } } } } } } } } } }`;
    const { errors } = await t.storefront(deep);
    expect(errors?.[0]?.message).toMatch(/depth/i);
  });

  it("serves repeated anonymous reads from the response cache and invalidates on change", async () => {
    const query = `{ product(slug: "market-tote") { id name } }`;
    await t.storefront(query);
    const second = await t.storefront(query);
    expect(second.extensions?.responseCache?.hit).toBe(true);

    const staff = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
    const token = staff.data.staffLogin.session.accessToken;
    await t.admin(`mutation($id: ID!) { productUpdate(id: $id, input: { translations: [{ locale: "en-US", name: "Market Tote Bag", slug: "market-tote" }] }) { __typename } }`, { id: second.data.product.id }, bearer(token));
    await processOutbox(t.platform);
    await new Promise((r) => setTimeout(r, 20));
    const third = await t.storefront(query);
    expect(third.extensions?.responseCache?.hit).toBe(false);
    expect(third.data.product.name).toBe("Market Tote Bag");
  });
});

describe("storefront checkout", () => {
  const address = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
  let cartId: string;

  it("returns typed errors for impossible requests", async () => {
    const created = await t.storefront(`mutation { cartCreate(input: { lines: [{ sku: "TRL-BLACK-41", quantity: 99 }] }) { __typename ... on InsufficientStockError { code sku requested available } } }`);
    expect(created.data.cartCreate).toEqual({ __typename: "InsufficientStockError", code: "INSUFFICIENT_STOCK", sku: "TRL-BLACK-41", requested: 99, available: 6 });
    const invalid = await t.storefront(`mutation { cartCreate(input: { lines: [{ quantity: 1 }] }) { __typename ... on ValidationError { fieldErrors { path message } } } }`);
    expect(invalid.data.cartCreate.__typename).toBe("ValidationError");
    expect(invalid.data.cartCreate.fieldErrors[0].path).toEqual(["lines", "0"]);
  });

  it("builds a cart step by step", async () => {
    const created = await t.storefront(`mutation { cartCreate(input: { lines: [{ sku: "TEE-BLACK-M", quantity: 5 }] }) { ... on CartPayload { cart { id totalQuantity missing } } } }`);
    cartId = created.data.cartCreate.cart.id;
    expect(cartId).toMatch(/^gid:\/\/ecom\/Cart\//);
    expect(created.data.cartCreate.cart.missing).toEqual(["EMAIL", "SHIPPING_ADDRESS", "SHIPPING_METHOD", "PAYMENT_METHOD"]);

    const coupon = await t.storefront(`mutation($id: ID!) { cartCouponApply(cartId: $id, code: "NOPE") { __typename ... on CouponNotApplicableError { couponCode reason } } }`, { id: cartId });
    expect(coupon.data.cartCouponApply).toEqual({ __typename: "CouponNotApplicableError", couponCode: "NOPE", reason: "unknown coupon" });

    const shipping = await t.storefront(`mutation($id: ID!, $a: AddressInput!) {
      cartShippingAddressSet(cartId: $id, address: { address: $a }) { ... on CartPayload { cart { availableShippingMethods { code price { amount } } } } }
    }`, { id: cartId, a: address });
    expect(shipping.data.cartShippingAddressSet.cart.availableShippingMethods).toEqual([
      { code: "us_free", price: { amount: "0.00" } },
      { code: "us_standard", price: { amount: "5.99" } },
      { code: "us_express", price: { amount: "14.99" } },
    ]);

    const rest = await t.storefront(`mutation($id: ID!) {
      a: cartShippingMethodSet(cartId: $id, shippingMethodCode: "us_express") { __typename }
      b: cartBillingAddressSet(cartId: $id, address: { sameAsShipping: true }) { __typename }
      c: cartPaymentMethodSet(cartId: $id, paymentMethodCode: "card") { __typename }
      d: cartEmailUpdate(cartId: $id, email: "Sam@Example.test") {
        ... on CartPayload { cart { email checkoutReady missing
          lines { name quantity unitPrice { amount } compareAtUnitPrice { amount } total { amount } }
          cost { subtotal { amount } shipping { amount } tax { amount } total { amount } taxLines { name rate amount { amount } } }
        } }
      }
    }`, { id: cartId });
    expect(rest.errors).toBeUndefined();
    const cart = rest.data.d.cart;
    expect(cart.email).toBe("sam@example.test");
    expect(cart.checkoutReady).toBe(true);
    expect(cart.lines).toEqual([{ name: "Everyday Tee", quantity: 5, unitPrice: { amount: "22.00" }, compareAtUnitPrice: { amount: "25.00" }, total: { amount: "117.98" } }]);
    expect(cart.cost).toEqual({
      subtotal: { amount: "110.00" },
      shipping: { amount: "14.99" },
      tax: { amount: "7.98" },
      total: { amount: "132.97" },
      taxLines: [{ name: "California sales tax", rate: 7.25, amount: { amount: "7.98" } }],
    });
  });

  it("places the order once per idempotency key", async () => {
    const place = `mutation($id: ID!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: "checkout-0001", payment: { token: "tok_visa" }) {
      __typename ... on CheckoutPayload { order { id number status paymentStatus totals { total { amount } } lines { sku quantity } } }
    } }`;
    const first = await t.storefront(place, { id: cartId });
    const second = await t.storefront(place, { id: cartId });
    expect(first.data.checkoutPlaceOrder.__typename).toBe("CheckoutPayload");
    expect(first.data.checkoutPlaceOrder.order).toMatchObject({ status: "OPEN", paymentStatus: "AUTHORIZED", totals: { total: { amount: "132.97" } }, lines: [{ sku: "TEE-BLACK-M", quantity: 5 }] });
    expect(second.data.checkoutPlaceOrder.order.id).toBe(first.data.checkoutPlaceOrder.order.id);
    const reuse = await t.storefront(`mutation($id: ID!) { cartLinesAdd(cartId: $id, lines: [{ sku: "SOCK-BLACK", quantity: 1 }]) { __typename } }`, { id: cartId });
    expect(reuse.data.cartLinesAdd.__typename).toBe("InvalidStateError");
  });

  it("reports what an incomplete cart is missing at checkout", async () => {
    const created = await t.storefront(`mutation { cartCreate(input: { email: "x@example.test", lines: [{ sku: "GIFT-50", quantity: 1 }] }) { ... on CartPayload { cart { id requiresShipping } } } }`);
    expect(created.data.cartCreate.cart.requiresShipping).toBe(false);
    const result = await t.storefront(`mutation($id: ID!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: "gift-attempt-1") { __typename ... on CartNotReadyError { missing } } }`, { id: created.data.cartCreate.cart.id });
    expect(result.data.checkoutPlaceOrder).toEqual({ __typename: "CartNotReadyError", missing: ["BILLING_ADDRESS", "PAYMENT_METHOD"] });
  });
});

describe("storefront customers", () => {
  let session: { accessToken: string; refreshToken: string };

  it("registers, keeps the guest cart, and reads its own data", async () => {
    const cart = await t.storefront(`mutation { cartCreate(input: { lines: [{ sku: "SOCK-BLUE", quantity: 3 }] }) { ... on CartPayload { cart { id } } } }`);
    const result = await t.storefront(`mutation($cartId: ID) {
      customerRegister(input: { email: "jo@example.test", password: "correct horse battery", firstName: "Jo", lastName: "Doe" }, cartId: $cartId) {
        __typename
        ... on CustomerAuthPayload { customer { email } session { accessToken refreshToken } cart { totalQuantity cost { discountTotal { amount } } } }
      }
    }`, { cartId: cart.data.cartCreate.cart.id });
    expect(result.data.customerRegister.__typename).toBe("CustomerAuthPayload");
    // Three socks: buy two, get one free.
    expect(result.data.customerRegister.cart).toEqual({ totalQuantity: 3, cost: { discountTotal: { amount: "18.00" } } });
    session = result.data.customerRegister.session;

    const me = await t.storefront(`{ me { firstName activeCart { totalQuantity } orders(first: 5) { totalCount } } }`, {}, bearer(session.accessToken));
    expect(me.data.me).toEqual({ firstName: "Jo", activeCart: { totalQuantity: 3 }, orders: { totalCount: 0 } });

    const duplicate = await t.storefront(`mutation { customerRegister(input: { email: "jo@example.test", password: "another long password", firstName: "Jo", lastName: "Doe" }) { __typename ... on ValidationError { fieldErrors { path } } } }`);
    expect(duplicate.data.customerRegister).toEqual({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "email"] }] });
  });

  it("checks out with a saved address", async () => {
    const auth = bearer(session.accessToken);
    const saved = await t.storefront(`mutation { customerAddressCreate(input: { address: { firstName: "Jo", lastName: "Doe", line1: "1 Main St", city: "Albany", regionCode: "NY", postalCode: "12207", countryCode: "US" } }) { ... on CustomerAddressPayload { address { id isDefaultShipping } } } }`, {}, auth);
    const addressId = saved.data.customerAddressCreate.address.id;
    expect(saved.data.customerAddressCreate.address.isDefaultShipping).toBe(true);
    const me = await t.storefront(`{ me { activeCart { id } } }`, {}, auth);
    const cartId = me.data.me.activeCart.id;
    const flow = await t.storefront(`mutation($c: ID!, $a: ID!) {
      s: cartShippingAddressSet(cartId: $c, address: { customerAddressId: $a }) { __typename }
      m: cartShippingMethodSet(cartId: $c, shippingMethodCode: "us_standard") { __typename }
      b: cartBillingAddressSet(cartId: $c, address: { customerAddressId: $a }) { __typename }
      p: cartPaymentMethodSet(cartId: $c, paymentMethodCode: "card_instant") { ... on CartPayload { cart { email cost { tax { amount } } } } }
    }`, { c: cartId, a: addressId }, auth);
    expect(flow.data.p.cart.email).toBe("jo@example.test");
    // New York tax on (54.00 − 18.00) = 36.00 × 8.875% = 3.195 → 3.20
    expect(flow.data.p.cart.cost.tax.amount).toBe("3.20");
    const order = await t.storefront(`mutation($c: ID!) { checkoutPlaceOrder(cartId: $c, idempotencyKey: "jo-order-1") { ... on CheckoutPayload { order { number paymentStatus invoices { number } } } } }`, { c: cartId }, auth);
    expect(order.data.checkoutPlaceOrder.order.paymentStatus).toBe("PAID");
    expect(order.data.checkoutPlaceOrder.order.invoices).toHaveLength(1);
    const history = await t.storefront(`{ me { orders(first: 5) { totalCount edges { node { number } } } } }`, {}, auth);
    expect(history.data.me.orders.edges[0].node.number).toBe(order.data.checkoutPlaceOrder.order.number);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const refresh = `mutation($t: String!) { tokenRefresh(refreshToken: $t) { __typename ... on SessionPayload { session { refreshToken } } ... on Error { code } } }`;
    const first = await t.storefront(refresh, { t: session.refreshToken });
    const next = first.data.tokenRefresh.session.refreshToken;
    expect(next).not.toBe(session.refreshToken);
    const replay = await t.storefront(refresh, { t: session.refreshToken });
    expect(replay.data.tokenRefresh).toEqual({ __typename: "AuthenticationError", code: "UNAUTHENTICATED" });
    // Reuse revoked the whole family, including the token issued by the first refresh.
    const afterReuse = await t.storefront(refresh, { t: next });
    expect(afterReuse.data.tokenRefresh.__typename).toBe("AuthenticationError");
  });

  it("rejects invalid credentials with 401 and keeps carts private", async () => {
    const bad = await t.storefront(`{ me { email } }`, {}, bearer("not-a-token"));
    expect(bad.status).toBe(401);
    expect(bad.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    const login = await t.storefront(`mutation($e: EmailAddress!, $p: String!) { customerLogin(email: $e, password: $p) { ... on CustomerAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.customerEmail, p: TEST_CREDENTIALS.customerPassword });
    const alex = bearer(login.data.customerLogin.session.accessToken);
    const alexCart = await t.storefront(`mutation { cartCreate(input: { lines: [{ sku: "TOTE-BLACK", quantity: 1 }] }) { __typename ... on CartPayload { cart { id } } ... on Error { message } } }`, {}, alex);
    expect(alexCart.data.cartCreate.__typename, JSON.stringify(alexCart)).toBe("CartPayload");
    const id = alexCart.data.cartCreate.cart.id;
    expect((await t.storefront(`query($id: ID!) { cart(id: $id) { id } }`, { id }, alex)).data.cart.id).toBe(id);
    expect((await t.storefront(`query($id: ID!) { cart(id: $id) { id } }`, { id })).data.cart).toBeNull();
    expect((await t.storefront(`query($id: ID!) { node(id: $id) { id } }`, { id })).data.node).toBeNull();
  });
});
