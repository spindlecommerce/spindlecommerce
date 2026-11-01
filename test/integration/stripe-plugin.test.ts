import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../../plugins/stripe/api.ts";
import { checkStripe, stripe, stripeProvider } from "../../plugins/stripe/index.ts";
import type { StripeSettings } from "../../plugins/stripe/settings.ts";
import { InvalidStateError, PaymentDeclinedError, ValidationError } from "../../src/lib/errors.ts";
import { newId, parseGlobalId } from "../../src/lib/ids.ts";
import { outboxEvents } from "../../src/modules/integrations/tables.ts";
import { capturePayment, refundOrder } from "../../src/modules/orders/service.ts";
import { orderEvents, orders, refunds } from "../../src/modules/orders/tables.ts";
import type { PaymentProvider } from "../../src/modules/payments/providers.ts";
import { createPaymentMethod } from "../../src/modules/payments/service.ts";
import { paymentTransactions } from "../../src/modules/payments/tables.ts";
import type { AuthorizeInput, PaymentSessionInput, PluginContext, SettingsValues } from "../../src/plugins/sdk.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { createFakeStripe, signStripePayload, type FakeStripe } from "../helpers/fake-stripe.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

const WEBHOOK_SECRET = "whsec_test_secret";
const ORDER = "01900000-0000-7000-8000-0000000000aa";

const contextFor = (fake: FakeStripe, settings: Partial<SettingsValues<StripeSettings>> = {}) =>
  ({
    plugin: { name: "stripe", version: "1.0.0" },
    settings: { secretKey: fake.secretKey, publishableKey: "pk_test_fake", webhookSecret: WEBHOOK_SECRET, statementDescriptorSuffix: undefined, ...settings },
    fetch: fake.fetch,
    logger: pino({ level: "silent" }),
  }) as unknown as PluginContext<StripeSettings>;

const sessionInput = (patch: Partial<PaymentSessionInput> = {}): PaymentSessionInput => ({
  cartId: newId(),
  methodCode: "stripe_card",
  amount: 5000,
  currency: "USD",
  locale: "en-US",
  email: "sam@example.test",
  customerId: null,
  billingAddress: null,
  shippingAddress: null,
  lines: [],
  captureImmediately: false,
  previous: null,
  ...patch,
});

/** A session for a new cart, and the authorize input of its order. */
const begin = async (ctx: PluginContext<StripeSettings>, patch: Partial<PaymentSessionInput> = {}) => {
  const input = sessionInput(patch);
  const session = await stripeProvider.createSession!(input, ctx);
  const id = session.data.paymentIntentId as string;
  const authorize = (more: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
    orderId: ORDER,
    orderNumber: "US-000042",
    cartId: input.cartId,
    amount: input.amount,
    currency: input.currency,
    paymentData: {},
    captureImmediately: input.captureImmediately,
    session: session.data,
    ...more,
  });
  return { id, input, session, authorize };
};

describe("Stripe provider: sessions", () => {
  it("creates a PaymentIntent for the cart, then updates the same one as the total changes", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake, { statementDescriptorSuffix: "SHOP" });
    const input = sessionInput();
    const first = await stripeProvider.createSession!(input, ctx);
    const id = first.data.paymentIntentId as string;
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/payment_intents",
      params: { amount: "5000", currency: "usd", capture_method: "manual", automatic_payment_methods: { enabled: "true" }, metadata: { cart_id: input.cartId, method_code: "stripe_card" }, statement_descriptor_suffix: "SHOP" },
    });
    expect(fake.requests[0]!.headers).toMatchObject({ authorization: `Bearer ${fake.secretKey}`, "stripe-version": "2024-06-20", "idempotency-key": expect.stringMatching(/^ecom-cart-/) });
    expect(first.clientData).toEqual({ clientSecret: fake.intent(id).client_secret, publishableKey: "pk_test_fake" });

    // The same request again (a double click, an effect run twice) gets the same PaymentIntent.
    expect((await stripeProvider.createSession!(input, ctx)).data.paymentIntentId).toBe(id);
    expect(fake.intents.size).toBe(1);

    const updated = await stripeProvider.createSession!({ ...input, amount: 6550, captureImmediately: true, previous: first.data }, ctx);
    expect(updated.data.paymentIntentId).toBe(id);
    expect(updated.clientData.clientSecret).toBe(first.clientData.clientSecret);
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: `/v1/payment_intents/${id}`, params: { amount: "6550", capture_method: "automatic" } });
    expect(fake.intent(id)).toMatchObject({ amount: 6550, capture_method: "automatic" });
  });

  it("keeps a PaymentIntent paid for the same total, and gives back one paid for another", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const authorized = await begin(ctx);
    fake.pay(authorized.id);
    expect((await stripeProvider.createSession!({ ...authorized.input, previous: authorized.session.data }, ctx)).data.paymentIntentId).toBe(authorized.id);
    const replaced = await stripeProvider.createSession!({ ...authorized.input, amount: 4000, previous: authorized.session.data }, ctx);
    expect(replaced.data.paymentIntentId).not.toBe(authorized.id);
    expect(fake.intent(authorized.id).status).toBe("canceled");
    expect(fake.intent(replaced.data.paymentIntentId as string)).toMatchObject({ amount: 4000, status: "requires_payment_method" });

    const captured = await begin(ctx, { captureImmediately: true });
    fake.pay(captured.id);
    await stripeProvider.createSession!({ ...captured.input, amount: 7000, previous: captured.session.data }, ctx);
    expect([...fake.refunds.values()]).toEqual([expect.objectContaining({ payment_intent: captured.id, amount: 5000 })]);
  });

  it("starts afresh when the PaymentIntent is gone, and needs none for a zero total", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const fresh = await stripeProvider.createSession!(sessionInput({ previous: { paymentIntentId: "pi_gone" } }), ctx);
    expect(fake.intent(fresh.data.paymentIntentId as string).status).toBe("requires_payment_method");
    fake.reset();
    expect(await stripeProvider.createSession!(sessionInput({ amount: 0 }), ctx)).toEqual({ data: { paymentIntentId: null }, clientData: { clientSecret: null, publishableKey: "pk_test_fake" } });
    expect(fake.requests).toEqual([]);
  });

  it("refuses an amount Stripe cannot take", async () => {
    const fake = createFakeStripe();
    fake.failNext("POST", /^\/v1\/payment_intents$/, 400, { type: "invalid_request_error", code: "amount_too_small", message: "Amount must be at least $0.50 usd" });
    const failure = stripeProvider.createSession!(sessionInput({ amount: 20 }), contextFor(fake));
    await expect(failure).rejects.toBeInstanceOf(InvalidStateError);
    await expect(failure).rejects.toThrow(/at least \$0\.50/);
  });
});

describe("Stripe provider: authorize", () => {
  it("maps the PaymentIntent's status and labels it with the order", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const authorized = await begin(ctx);
    fake.pay(authorized.id);
    expect(await stripeProvider.authorize(authorized.authorize(), ctx)).toMatchObject({ status: "authorized", pspReference: authorized.id });
    expect(fake.intent(authorized.id).metadata).toMatchObject({ cart_id: authorized.input.cartId, order_id: ORDER, order_number: "US-000042" });

    const captured = await begin(ctx, { captureImmediately: true });
    fake.pay(captured.id);
    expect(await stripeProvider.authorize(captured.authorize(), ctx)).toMatchObject({ status: "captured", pspReference: captured.id });

    const processing = await begin(ctx);
    fake.pay(processing.id, "processing");
    expect(await stripeProvider.authorize(processing.authorize(), ctx)).toMatchObject({ status: "pending", pspReference: processing.id });

    // The method captures at checkout, but the intent only authorized: captured now.
    const late = await begin(ctx);
    fake.pay(late.id);
    expect(await stripeProvider.authorize(late.authorize({ captureImmediately: true }), ctx)).toMatchObject({ status: "captured" });
    expect(fake.intent(late.id)).toMatchObject({ status: "succeeded", amount_received: 5000 });
  });

  it("declines a payment that is not complete", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const declined = await begin(ctx);
    fake.pay(declined.id, "declined");
    await expect(stripeProvider.authorize(declined.authorize(), ctx)).rejects.toMatchObject({ constructor: PaymentDeclinedError, declineCode: "insufficient_funds", message: "Your card has insufficient funds." });
    const unpaid = await begin(ctx);
    await expect(stripeProvider.authorize(unpaid.authorize(), ctx)).rejects.toMatchObject({ declineCode: "payment_incomplete" });
    await expect(stripeProvider.authorize(unpaid.authorize({ session: null }), ctx)).rejects.toMatchObject({ declineCode: "payment_incomplete" });
    await expect(stripeProvider.authorize(unpaid.authorize({ session: { paymentIntentId: "pi_gone" } }), ctx)).rejects.toMatchObject({ declineCode: "payment_incomplete" });
    // No metadata for orders that were not placed.
    expect(fake.intent(declined.id).metadata.order_id).toBeUndefined();
  });

  it("refuses a PaymentIntent that does not match the order", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const paid = await begin(ctx);
    fake.pay(paid.id);
    await expect(stripeProvider.authorize(paid.authorize({ amount: 4999 }), ctx)).rejects.toMatchObject({ declineCode: "amount_mismatch" });
    await expect(stripeProvider.authorize(paid.authorize({ currency: "EUR" }), ctx)).rejects.toMatchObject({ declineCode: "amount_mismatch" });
    await expect(stripeProvider.authorize(paid.authorize({ cartId: newId() }), ctx)).rejects.toMatchObject({ declineCode: "payment_mismatch" });
    const refunded = await begin(ctx, { captureImmediately: true });
    fake.pay(refunded.id);
    fake.refundInDashboard(refunded.id);
    await expect(stripeProvider.authorize(refunded.authorize(), ctx)).rejects.toMatchObject({ declineCode: "payment_refunded" });
  });

  it("checks the payment a webhook reported when the platform places the order itself", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const stale = await begin(ctx);
    const paid = await stripeProvider.createSession!({ ...stale.input, amount: 5000, methodCode: "other" }, ctx);
    fake.pay(paid.data.paymentIntentId as string);
    const result = await stripeProvider.authorize(stale.authorize({ paymentData: { pspReference: paid.data.paymentIntentId } }), ctx);
    expect(result).toMatchObject({ status: "authorized", pspReference: paid.data.paymentIntentId });
  });
});

describe("Stripe provider: capture, refund and void", () => {
  it("captures, refunds and cancels through the PaymentIntents API", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const paid = await begin(ctx);
    fake.pay(paid.id);
    expect(await stripeProvider.capture({ orderId: ORDER, amount: 3000, currency: "USD", pspReference: paid.id }, ctx)).toMatchObject({ pspReference: paid.id });
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: `/v1/payment_intents/${paid.id}/capture`, params: { amount_to_capture: "3000" } });
    expect(fake.intent(paid.id)).toMatchObject({ status: "succeeded", amount_received: 3000 });
    // A retried capture gets Stripe's first answer.
    expect(await stripeProvider.capture({ orderId: ORDER, amount: 3000, currency: "USD", pspReference: paid.id }, ctx)).toMatchObject({ pspReference: paid.id });

    const refund = await stripeProvider.refund({ orderId: ORDER, amount: 1000, currency: "USD", pspReference: paid.id }, ctx);
    expect(refund.pspReference).toMatch(/^re_/);
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/refunds", params: { payment_intent: paid.id, amount: "1000", metadata: { order_id: ORDER } } });
    // Orders keep the latest reference, a refund's after a refund: its PaymentIntent is looked up.
    const second = await stripeProvider.refund({ orderId: ORDER, amount: 500, currency: "USD", pspReference: refund.pspReference }, ctx);
    expect(fake.refunds.get(second.pspReference!)).toMatchObject({ payment_intent: paid.id, amount: 500 });

    const authorized = await begin(ctx);
    fake.pay(authorized.id);
    expect(await stripeProvider.void({ orderId: ORDER, pspReference: authorized.id }, ctx)).toMatchObject({ pspReference: authorized.id, raw: { status: "canceled" } });
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: `/v1/payment_intents/${authorized.id}/cancel` });
    await expect(stripeProvider.void({ orderId: ORDER, pspReference: authorized.id }, ctx)).resolves.toMatchObject({ raw: { status: "canceled" } });
    // Stripe's refusals reach staff as the reason.
    await expect(stripeProvider.capture({ orderId: ORDER, amount: 5000, currency: "USD", pspReference: authorized.id }, ctx)).rejects.toMatchObject({ constructor: InvalidStateError, message: expect.stringMatching(/^Stripe: You cannot capture/) });
  });

  it("gives back what a checkout without an order paid, and leaves an unpaid payment usable", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const release = (session: Record<string, unknown>) => stripeProvider.void({ orderId: "", pspReference: null, session }, ctx);
    const unpaid = await begin(ctx);
    await release(unpaid.session.data);
    expect(fake.intent(unpaid.id).status).toBe("requires_payment_method");
    const authorized = await begin(ctx);
    fake.pay(authorized.id);
    await release(authorized.session.data);
    expect(fake.intent(authorized.id).status).toBe("canceled");
    const captured = await begin(ctx, { captureImmediately: true });
    fake.pay(captured.id);
    expect(await release(captured.session.data)).toMatchObject({ pspReference: expect.stringMatching(/^re_/), raw: { released: "refunded" } });
    expect(fake.chargeOf(captured.id)).toMatchObject({ amount_refunded: 5000 });
    expect(await release({})).toEqual({ pspReference: null });
  });
});

describe("Stripe provider: webhooks", () => {
  const url = "http://ecom.test/payments/webhooks/stripe";

  it("verifies Stripe-Signature: valid, invalid, stale, rolled secrets", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const event = fake.event("customer.created", { id: "cus_1" });
    expect(await stripeProvider.webhook!(fake.webhook(url, WEBHOOK_SECRET, event), ctx)).toEqual({ events: [] });
    await expect(stripeProvider.webhook!(fake.webhook(url, "whsec_other", event), ctx)).rejects.toBeInstanceOf(ValidationError);
    const stale = Math.floor(Date.now() / 1000) - 600;
    await expect(stripeProvider.webhook!(fake.webhook(url, WEBHOOK_SECRET, event, { timestamp: stale }), ctx)).rejects.toThrow("Invalid Stripe signature");
    await expect(stripeProvider.webhook!(new Request(url, { method: "POST", body: JSON.stringify(event) }), ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(stripeProvider.webhook!(fake.webhook(url, WEBHOOK_SECRET, event), contextFor(fake, { webhookSecret: undefined }))).rejects.toThrow(/signing secret/);

    const body = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);
    const rolled = `${signStripePayload("whsec_old", body, now)},${signStripePayload(WEBHOOK_SECRET, body, now).split(",")[1]}`;
    expect(verifyStripeSignature(WEBHOOK_SECRET, body, rolled)).toBe(true);
    expect(verifyStripeSignature(WEBHOOK_SECRET, `${body} `, rolled)).toBe(false);
    expect(verifyStripeSignature(WEBHOOK_SECRET, body, "garbage")).toBe(false);
  });

  it("maps PaymentIntent, refund and dispute events", async () => {
    const fake = createFakeStripe();
    const ctx = contextFor(fake);
    const events = async (event: Record<string, unknown>) => (await stripeProvider.webhook!(fake.webhook(url, WEBHOOK_SECRET, event), ctx)).events;
    const paid = await begin(ctx);
    const cartId = paid.input.cartId;
    fake.pay(paid.id);
    const intent = () => ({ ...fake.intent(paid.id) });
    const base = { pspReference: paid.id, currency: "USD", cartId };
    expect(await events(fake.event("payment_intent.amount_capturable_updated", intent(), "evt_auth"))).toEqual([expect.objectContaining({ ...base, id: "evt_auth", type: "authorized", amount: 5000 })]);
    await stripeProvider.capture({ orderId: ORDER, amount: 5000, currency: "USD", pspReference: paid.id }, ctx);
    expect(await events(fake.event("payment_intent.succeeded", intent(), "evt_paid"))).toEqual([expect.objectContaining({ ...base, type: "captured", amount: 5000 })]);
    expect(await events(fake.event("payment_intent.payment_failed", { ...intent(), status: "requires_payment_method", last_payment_error: { message: "Your card was declined." } }))).toEqual([
      expect.objectContaining({ ...base, type: "failed", reason: "Your card was declined." }),
    ]);
    expect(await events(fake.event("payment_intent.canceled", { ...intent(), status: "canceled", cancellation_reason: "automatic" }))).toEqual([expect.objectContaining({ ...base, type: "canceled", reason: "automatic" })]);

    // Charges in recent API versions carry no refunds: they are listed.
    const first = fake.refundInDashboard(paid.id, 1000);
    const second = fake.refundInDashboard(paid.id, 500);
    const refunded = await events(fake.event("charge.refunded", fake.chargeOf(paid.id), "evt_refund"));
    expect(refunded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `evt_refund:${first.id}`, type: "refunded", pspReference: paid.id, refundReference: first.id, amount: 1000, currency: "USD" }),
        expect.objectContaining({ refundReference: second.id, amount: 500 }),
      ]),
    );
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/v1/refunds", params: { charge: fake.chargeOf(paid.id).id } });
    fake.reset();
    const embedded = await events(fake.event("charge.refunded", { ...fake.chargeOf(paid.id), refunds: { data: [first], has_more: false } }));
    expect(embedded.map((e) => e.refundReference)).toEqual([first.id]);
    expect(fake.requests.filter((r) => r.path === "/v1/refunds")).toEqual([]);

    const dispute = { id: "dp_1", object: "dispute", amount: 5000, currency: "usd", reason: "fraudulent", status: "needs_response", payment_intent: paid.id, charge: fake.chargeOf(paid.id).id };
    expect(await events(fake.event("charge.dispute.created", dispute))).toEqual([expect.objectContaining({ type: "dispute_opened", pspReference: paid.id, amount: 5000, reason: "fraudulent" })]);
    expect(await events(fake.event("charge.dispute.closed", { ...dispute, status: "lost" }))).toEqual([expect.objectContaining({ type: "dispute_closed", reason: "lost" })]);
    expect(await events(fake.event("charge.dispute.created", { ...dispute, payment_intent: null }))).toEqual([]);
  });
});

describe("Stripe plugin: test connection", () => {
  it("reports whether the key works and its mode", async () => {
    const test = createFakeStripe();
    expect(await checkStripe(contextFor(test))).toEqual({ ok: true, message: "Connected to Stripe in test mode." });
    expect(await checkStripe(contextFor(test, { webhookSecret: undefined }))).toMatchObject({ ok: true, message: expect.stringMatching(/webhooks are refused/) });
    expect(await checkStripe(contextFor(test, { secretKey: "sk_test_wrong" }))).toEqual({ ok: false, message: "Stripe refused the secret key." });
    const live = createFakeStripe({ secretKey: "sk_live_fake", livemode: true });
    expect(await checkStripe(contextFor(live, { publishableKey: "pk_live_fake" }))).toMatchObject({ ok: true, message: expect.stringMatching(/live mode/) });
    expect(await checkStripe(contextFor(live))).toEqual({ ok: false, message: "The secret key is for live mode but the publishable key is for test mode." });
  });

  it("defines the plugin's settings and provider", () => {
    const plugin = stripe();
    expect(plugin).toMatchObject({ name: "stripe", title: "Stripe", payments: [{ code: "stripe" }] });
    expect(plugin.settings).toMatchObject({
      secretKey: { type: "secret", required: true, env: "STRIPE_SECRET_KEY" },
      publishableKey: { type: "string", required: true, env: "STRIPE_PUBLISHABLE_KEY" },
      webhookSecret: { type: "secret", env: "STRIPE_WEBHOOK_SECRET" },
      statementDescriptorSuffix: { type: "string" },
    });
  });
});

// ---------------------------------------------------------------- end to end, through the platform

/** The provider bound to a fixed context, as the plugin runtime binds an active plugin's. */
const bound = (ctx: PluginContext<StripeSettings>): PaymentProvider => ({
  code: stripeProvider.code,
  title: stripeProvider.title,
  plugin: "stripe",
  isAvailable: async () => true,
  createSession: (input) => stripeProvider.createSession!(input, ctx),
  authorize: (input) => stripeProvider.authorize(input, ctx),
  capture: (input) => stripeProvider.capture(input, ctx),
  refund: (input) => stripeProvider.refund(input, ctx),
  void: (input) => stripeProvider.void(input, ctx),
  webhook: (request) => stripeProvider.webhook!(request, ctx),
});

const ADDRESS = { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" };
const SESSION = `mutation($id: ID!) { cartPaymentSessionCreate(cartId: $id) {
  __typename
  ... on CartPaymentSessionPayload { session { provider methodCode amount { amount currencyCode } clientData } }
  ... on CartNotReadyError { missing }
  ... on Error { message }
} }`;
const PLACE = `mutation($id: ID!, $k: String!) { checkoutPlaceOrder(cartId: $id, idempotencyKey: $k, payment: {}) {
  __typename
  ... on CheckoutPayload { order { id number paymentStatus totals { total { amount } } } }
  ... on PaymentDeclinedError { declineCode }
  ... on CartNotReadyError { missing }
  ... on Error { message }
} }`;

describe("Stripe checkout through the platform", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let fake: FakeStripe;
  const staff = { type: "staff" as const, id: null };

  beforeAll(async () => {
    fake = createFakeStripe();
    t = await createTestApp({ paymentProviders: [bound(contextFor(fake))] });
    await createPaymentMethod(t.platform.db, t.platform.payments, { code: "stripe_card", name: { "en-US": "Card" }, provider: "stripe", config: { captureMode: "authorize" }, position: -2 });
    await createPaymentMethod(t.platform.db, t.platform.payments, { code: "stripe_now", name: { "en-US": "Card, paid now" }, provider: "stripe", config: { captureMode: "authorize_capture" }, position: -1 });
  });
  afterAll(() => t.close());

  const readyCart = async (lines: { sku: string; quantity: number }[] = [{ sku: "TOTE-BLACK", quantity: 1 }], method = "stripe_card") => {
    const created = await t.storefront(`mutation($lines: [CartLineInput!]!) { cartCreate(input: { email: "sam@example.test", lines: $lines }) { ... on CartPayload { cart { id } } } }`, { lines });
    const id = created.data.cartCreate.cart.id as string;
    const set = await t.storefront(
      `mutation($id: ID!, $a: AddressInput!, $m: String!) {
        a: cartShippingAddressSet(cartId: $id, address: { address: $a }) { __typename }
        b: cartBillingAddressSet(cartId: $id, address: { sameAsShipping: true }) { __typename }
        c: cartShippingMethodSet(cartId: $id, shippingMethodCode: "us_standard") { __typename }
        d: cartPaymentMethodSet(cartId: $id, paymentMethodCode: $m) { __typename }
      }`,
      { id, a: ADDRESS, m: method },
    );
    expect(Object.values(set.data).map((r: any) => r.__typename)).toEqual(["CartPayload", "CartPayload", "CartPayload", "CartPayload"]);
    return id;
  };
  const startSession = async (cartId: string) => {
    const result = await t.storefront(SESSION, { id: cartId });
    expect(result.data.cartPaymentSessionCreate.__typename).toBe("CartPaymentSessionPayload");
    const session = result.data.cartPaymentSessionCreate.session;
    return { ...session, paymentIntentId: (session.clientData.clientSecret as string).split("_secret_")[0]! };
  };
  const send = (event: Record<string, unknown>, secret = WEBHOOK_SECRET) => t.app.fetch(fake.webhook("http://ecom.test/payments/webhooks/stripe", secret, event));
  const rawId = (gid: string) => parseGlobalId(gid)!.id;
  const order = (id: string) => t.platform.db.query.orders.findFirst({ where: eq(orders.id, id) });
  const transactions = (orderId: string) => t.platform.db.select().from(paymentTransactions).where(eq(paymentTransactions.orderId, orderId)).orderBy(paymentTransactions.id);

  it("offers Stripe methods with a session, and checks out a PaymentIntent confirmed in the browser", async () => {
    const cartId = await readyCart();
    const methods = await t.storefront(`query($id: ID!) { cart(id: $id) { availablePaymentMethods { code provider sessionRequired } selectedPaymentMethod { code provider sessionRequired } } }`, { id: cartId });
    expect(methods.data.cart.availablePaymentMethods).toEqual(
      expect.arrayContaining([
        { code: "stripe_card", provider: "stripe", sessionRequired: true },
        { code: "card", provider: "test_gateway", sessionRequired: false },
        { code: "checkmo", provider: "offline", sessionRequired: false },
      ]),
    );
    expect(methods.data.cart.selectedPaymentMethod).toEqual({ code: "stripe_card", provider: "stripe", sessionRequired: true });

    const session = await startSession(cartId);
    expect(session).toMatchObject({ provider: "stripe", methodCode: "stripe_card", amount: { currencyCode: "USD" }, clientData: { publishableKey: "pk_test_fake", clientSecret: expect.stringMatching(/^pi_/) } });
    const intent = fake.intent(session.paymentIntentId);
    expect(intent).toMatchObject({ amount: Math.round(Number(session.amount.amount) * 100), currency: "usd", capture_method: "manual", metadata: { cart_id: rawId(cartId), method_code: "stripe_card" } });

    fake.pay(intent.id);
    const placed = await t.storefront(PLACE, { id: cartId, k: "stripe-checkout-1" });
    expect(placed.data.checkoutPlaceOrder).toMatchObject({ __typename: "CheckoutPayload", order: { paymentStatus: "AUTHORIZED", totals: { total: { amount: session.amount.amount } } } });
    const orderId = rawId(placed.data.checkoutPlaceOrder.order.id);
    expect(await transactions(orderId)).toEqual([expect.objectContaining({ kind: "authorization", status: "succeeded", provider: "stripe", pspReference: intent.id })]);
    expect(fake.intent(intent.id).metadata).toMatchObject({ order_id: orderId, order_number: placed.data.checkoutPlaceOrder.order.number });

    // Staff capture on shipment; Stripe's webhook for it then changes nothing.
    await capturePayment(t.platform, orderId, {}, staff);
    const succeeded = fake.event("payment_intent.succeeded", { ...fake.intent(intent.id) });
    expect((await send(succeeded)).status).toBe(200);
    expect((await send(succeeded)).status).toBe(200);
    expect((await transactions(orderId)).map((x) => `${x.kind}:${x.status}`)).toEqual(["authorization:succeeded", "capture:succeeded"]);
    expect(await order(orderId)).toMatchObject({ paymentStatus: "paid", amountCaptured: intent.amount });
  });

  it("keeps the session in step with the cart total", async () => {
    const cartId = await readyCart();
    const first = await startSession(cartId);
    await t.storefront(`mutation($id: ID!) { cartLinesAdd(cartId: $id, lines: [{ sku: "SOCK-BLACK", quantity: 2 }]) { __typename } }`, { id: cartId });
    const second = await startSession(cartId);
    expect(second.paymentIntentId).toBe(first.paymentIntentId);
    expect(second.clientData.clientSecret).toBe(first.clientData.clientSecret);
    expect(Number(second.amount.amount)).toBeGreaterThan(Number(first.amount.amount));
    expect(fake.intent(first.paymentIntentId).amount).toBe(Math.round(Number(second.amount.amount) * 100));
    const stored = await t.platform.db.query.carts.findFirst({ where: (c, { eq: e }) => e(c.id, rawId(cartId)) });
    expect(stored!.paymentSession).toMatchObject({ provider: "stripe", methodCode: "stripe_card", amount: fake.intent(first.paymentIntentId).amount, currency: "USD", data: { paymentIntentId: first.paymentIntentId } });
    // Paying for an older total is declined, and the money given back.
    fake.intents.get(first.paymentIntentId)!.amount = 100;
    fake.pay(first.paymentIntentId);
    const placed = await t.storefront(PLACE, { id: cartId, k: "stripe-stale-1" });
    expect(placed.data.checkoutPlaceOrder).toMatchObject({ __typename: "PaymentDeclinedError", declineCode: "amount_mismatch" });
    expect(fake.intent(first.paymentIntentId).status).toBe("canceled");
    // The cart reopened; a new session starts a new payment.
    expect((await startSession(cartId)).paymentIntentId).not.toBe(first.paymentIntentId);
  });

  it("places the order of a customer who paid but never came back, once", async () => {
    const cartId = await readyCart([{ sku: "BOOK-TRAIL-GUIDE", quantity: 1 }], "stripe_now");
    const session = await startSession(cartId);
    fake.pay(session.paymentIntentId);
    const succeeded = fake.event("payment_intent.succeeded", { ...fake.intent(session.paymentIntentId) });
    const [a, b] = await Promise.all([send(succeeded), send(succeeded)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual({ received: true });
    const placed = await t.platform.db.select().from(orders).where(eq(orders.cartId, rawId(cartId)));
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ paymentStatus: "paid", amountCaptured: fake.intent(session.paymentIntentId).amount });
    expect((await transactions(placed[0]!.id)).filter((x) => x.kind === "capture")).toHaveLength(1);
    // Back from the redirect at last: checkout returns that order.
    const back = await t.storefront(PLACE, { id: cartId, k: "stripe-came-back" });
    expect(back.data.checkoutPlaceOrder).toMatchObject({ __typename: "CheckoutPayload", order: { number: placed[0]!.number, paymentStatus: "PAID" } });
  });

  it("gives the money back when stock ran out after the customer paid", async () => {
    const cartId = await readyCart([{ sku: "TRL-BLACK-41", quantity: 4 }], "stripe_now");
    const session = await startSession(cartId);
    fake.pay(session.paymentIntentId);
    // Someone else buys the shoes meanwhile.
    const other = await readyCart([{ sku: "TRL-BLACK-41", quantity: 3 }], "card");
    expect((await t.storefront(PLACE, { id: other, k: "other-buyer-1" })).data.checkoutPlaceOrder.__typename).toBe("CheckoutPayload");
    const placed = await t.storefront(PLACE, { id: cartId, k: "stripe-sold-out" });
    expect(placed.data.checkoutPlaceOrder).toMatchObject({ __typename: "CartNotReadyError", missing: ["LINE_ISSUES"] });
    expect(fake.chargeOf(session.paymentIntentId)).toMatchObject({ amount_refunded: fake.intent(session.paymentIntentId).amount });
  });

  it("records refunds made in the Stripe dashboard once, and not those made in the admin", async () => {
    const cartId = await readyCart([{ sku: "TOTE-GREEN", quantity: 2 }], "stripe_now");
    const session = await startSession(cartId);
    fake.pay(session.paymentIntentId);
    const placed = await t.storefront(PLACE, { id: cartId, k: "stripe-refunds-1" });
    const orderId = rawId(placed.data.checkoutPlaceOrder.order.id);

    const dashboard = fake.refundInDashboard(session.paymentIntentId, 1000);
    const refunded = fake.event("charge.refunded", fake.chargeOf(session.paymentIntentId));
    expect((await send(refunded)).status).toBe(200);
    expect((await send(refunded)).status).toBe(200);
    expect(await order(orderId)).toMatchObject({ amountRefunded: 1000, paymentStatus: "partially_refunded" });
    const documents = await t.platform.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(documents).toEqual([expect.objectContaining({ amount: 1000, lines: [] })]);
    expect(await transactions(orderId)).toContainEqual(expect.objectContaining({ kind: "refund", pspReference: dashboard.id, referenceKey: `stripe:refund:${dashboard.id}` }));

    // Refunded in the admin: Stripe's event lists it with the dashboard's, and neither is counted again.
    await refundOrder(t.platform, orderId, { shippingAmount: "1.00" }, staff);
    expect(await order(orderId)).toMatchObject({ amountRefunded: 1100 });
    expect((await send(fake.event("charge.refunded", fake.chargeOf(session.paymentIntentId)))).status).toBe(200);
    expect(await order(orderId)).toMatchObject({ amountRefunded: 1100 });
    expect(fake.chargeOf(session.paymentIntentId).amount_refunded).toBe(1100);
    const outbox = await t.platform.db.select().from(outboxEvents).where(and(eq(outboxEvents.aggregateId, orderId), eq(outboxEvents.type, "order.refunded")));
    expect(outbox).toHaveLength(2);
  });

  it("records disputes, and payments that settle or fail later", async () => {
    const cartId = await readyCart([{ sku: "SOCK-BLUE", quantity: 1 }], "stripe_now");
    const session = await startSession(cartId);
    fake.pay(session.paymentIntentId, "processing");
    const placed = await t.storefront(PLACE, { id: cartId, k: "stripe-later-1" });
    expect(placed.data.checkoutPlaceOrder.order.paymentStatus).toBe("PENDING");
    const orderId = rawId(placed.data.checkoutPlaceOrder.order.id);
    expect(await transactions(orderId)).toEqual([expect.objectContaining({ kind: "authorization", status: "pending", pspReference: session.paymentIntentId })]);

    await send(fake.event("payment_intent.payment_failed", { ...fake.intent(session.paymentIntentId), status: "requires_payment_method", last_payment_error: { message: "The bank refused the debit." } }));
    expect((await transactions(orderId)).at(-1)).toMatchObject({ kind: "authorization", status: "failed", errorMessage: "The bank refused the debit." });
    expect(await order(orderId)).toMatchObject({ status: "open", paymentStatus: "pending" });

    fake.intents.get(session.paymentIntentId)!.status = "requires_payment_method";
    fake.pay(session.paymentIntentId);
    await send(fake.event("payment_intent.succeeded", { ...fake.intent(session.paymentIntentId) }));
    expect(await order(orderId)).toMatchObject({ paymentStatus: "paid", amountCaptured: fake.intent(session.paymentIntentId).amount });

    const dispute = { id: "dp_e2e", object: "dispute", amount: 1000, currency: "usd", reason: "fraudulent", status: "needs_response", payment_intent: session.paymentIntentId };
    const opened = fake.event("charge.dispute.created", dispute);
    await send(opened);
    await send(opened);
    await send(fake.event("charge.dispute.closed", { ...dispute, status: "won" }));
    const history = await t.platform.db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(orderEvents.id);
    expect(history.filter((e) => e.type.startsWith("payment_dispute")).map((e) => e.message)).toEqual([
      "Payment disputed for 10.00 USD (fraudulent): respond in the stripe dashboard (reported by stripe)",
      "Payment dispute closed: won (reported by stripe)",
    ]);
    const disputed = await t.platform.db.select().from(outboxEvents).where(and(eq(outboxEvents.aggregateId, orderId), eq(outboxEvents.type, "order.payment_disputed")));
    expect(disputed).toEqual([expect.objectContaining({ payload: expect.objectContaining({ amount: 1000, reason: "fraudulent", pspReference: session.paymentIntentId }) })]);
  });

  it("answers 404 for unknown providers and 400 for requests it cannot verify", async () => {
    const post = (path: string, init: RequestInit = {}) => t.app.fetch(new Request(`http://ecom.test${path}`, { method: "POST", body: "{}", ...init }));
    expect((await post("/payments/webhooks/nope")).status).toBe(404);
    expect((await post("/payments/webhooks/test_gateway")).status).toBe(404);
    const forged = await send(fake.event("payment_intent.succeeded", { id: "pi_x", currency: "usd", metadata: {} }), "whsec_forged");
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: { code: "INVALID_WEBHOOK", message: "The webhook could not be verified" } });
  });

  it("lists the provider for the payment method form", async () => {
    const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
    const auth = bearer(login.data.staffLogin.session.accessToken);
    const { data } = await t.admin(`{ paymentProviders { code title description plugin active } }`, {}, auth);
    expect(data.paymentProviders).toEqual(
      expect.arrayContaining([
        { code: "offline", title: "Offline payment", description: expect.any(String), plugin: null, active: true },
        { code: "test_gateway", title: "Test gateway", description: expect.any(String), plugin: null, active: true },
        // Bound by hand here, so the runtime does not know the plugin.
        { code: "stripe", title: "Stripe", description: null, plugin: "stripe", active: false },
      ]),
    );
  });
});


describe("Stripe through the plugin runtime", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let fake: FakeStripe;
  let auth: Record<string, string>;
  // Settings come from the environment first: keep a developer's own keys out of the test.
  const saved = Object.fromEntries(["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET"].map((k) => [k, process.env[k]]));

  beforeAll(async () => {
    for (const key of Object.keys(saved)) delete process.env[key];
    fake = createFakeStripe();
    t = await createTestApp({ plugins: [stripe()], fetch: fake.fetch });
    await createPaymentMethod(t.platform.db, t.platform.payments, { code: "stripe_card", name: { "en-US": "Card" }, provider: "stripe", config: { captureMode: "authorize" }, position: -1 });
    const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
    auth = bearer(login.data.staffLogin.session.accessToken);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
    await t.close();
  });

  const cart = async () => {
    const created = await t.storefront(`mutation { cartCreate(input: { email: "sam@example.test", lines: [{ sku: "TOTE-BLACK", quantity: 1 }] }) { ... on CartPayload { cart { id } } } }`);
    const id = created.data.cartCreate.cart.id as string;
    await t.storefront(
      `mutation($id: ID!, $a: AddressInput!) {
        a: cartShippingAddressSet(cartId: $id, address: { address: $a }) { __typename }
        b: cartBillingAddressSet(cartId: $id, address: { sameAsShipping: true }) { __typename }
        c: cartShippingMethodSet(cartId: $id, shippingMethodCode: "us_standard") { __typename }
      }`,
      { id, a: ADDRESS },
    );
    return id;
  };
  const offered = async (cartId: string) => (await t.storefront(`query($id: ID!) { cart(id: $id) { availablePaymentMethods { code } } }`, { id: cartId })).data.cart.availablePaymentMethods.map((m: { code: string }) => m.code);
  const provider = async () => (await t.admin(`{ paymentProviders { code plugin active } }`, {}, auth)).data.paymentProviders.find((p: { code: string }) => p.code === "stripe");

  it("offers Stripe once the plugin is set up, and checks out through the plugin's context", async () => {
    const cartId = await cart();
    expect(await offered(cartId)).not.toContain("stripe_card");
    expect(await provider()).toEqual({ code: "stripe", plugin: "stripe", active: false });

    await t.platform.plugins.update("stripe", { settings: { secretKey: fake.secretKey, publishableKey: "pk_test_fake", webhookSecret: WEBHOOK_SECRET } });
    expect(await provider()).toEqual({ code: "stripe", plugin: "stripe", active: true });
    expect(await offered(cartId)).toContain("stripe_card");
    expect(await t.platform.plugins.check("stripe")).toEqual({ ok: true, message: "Connected to Stripe in test mode." });

    await t.storefront(`mutation($id: ID!) { cartPaymentMethodSet(cartId: $id, paymentMethodCode: "stripe_card") { __typename } }`, { id: cartId });
    const session = (await t.storefront(SESSION, { id: cartId })).data.cartPaymentSessionCreate.session;
    expect(session.clientData).toEqual({ clientSecret: expect.stringMatching(/^pi_.+_secret_/), publishableKey: "pk_test_fake" });
    const paymentIntentId = (session.clientData.clientSecret as string).split("_secret_")[0]!;
    fake.pay(paymentIntentId);
    const placed = await t.storefront(PLACE, { id: cartId, k: "runtime-checkout-1" });
    expect(placed.data.checkoutPlaceOrder).toMatchObject({ __typename: "CheckoutPayload", order: { paymentStatus: "AUTHORIZED" } });

    const dispute = { id: "dp_runtime", object: "dispute", amount: 100, currency: "usd", reason: "general", status: "needs_response", payment_intent: paymentIntentId };
    const response = await t.app.fetch(fake.webhook("http://ecom.test/payments/webhooks/stripe", WEBHOOK_SECRET, fake.event("charge.dispute.created", dispute)));
    expect(response.status).toBe(200);
    const orderId = parseGlobalId(placed.data.checkoutPlaceOrder.order.id)!.id;
    expect(await t.platform.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, "payment_disputed")))).toHaveLength(1);
  });

  it("answers 503 while the plugin is disabled, so Stripe delivers the webhook again later", async () => {
    await t.platform.plugins.update("stripe", { enabled: false });
    const event = fake.event("payment_intent.succeeded", { id: "pi_x", object: "payment_intent", status: "succeeded", amount: 100, amount_received: 100, currency: "usd", metadata: {} });
    expect((await t.app.fetch(fake.webhook("http://ecom.test/payments/webhooks/stripe", WEBHOOK_SECRET, event))).status).toBe(503);
    await t.platform.plugins.update("stripe", { enabled: true });
    expect((await t.app.fetch(fake.webhook("http://ecom.test/payments/webhooks/stripe", WEBHOOK_SECRET, event))).status).toBe(200);
  });
});
