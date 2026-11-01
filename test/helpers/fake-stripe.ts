import { createHmac } from "node:crypto";

/** In-memory stand-in for the Stripe API calls the Stripe plugin makes, served through `fetch`. */

type Intent = {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number;
  amount_capturable: number;
  amount_received: number;
  currency: string;
  capture_method: string;
  client_secret: string;
  metadata: Record<string, string>;
  latest_charge: string | null;
  last_payment_error: { code?: string; decline_code?: string; message?: string } | null;
  cancellation_reason: string | null;
  statement_descriptor_suffix?: string;
};
type Charge = { id: string; object: "charge"; payment_intent: string; amount: number; amount_refunded: number; refunded: boolean; currency: string; metadata: Record<string, string> };
type Refund = { id: string; object: "refund"; amount: number; currency: string; status: string; reason: string | null; payment_intent: string; charge: string; metadata: Record<string, string> };
export type FakeStripeRequest = { method: string; path: string; params: Record<string, any>; headers: Record<string, string> };

/** `a[b][0]=c` → { a: { b: { 0: "c" } } }; numeric keys stay object keys, read with Object.values. */
export const decodeForm = (form: string): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [key, value] of new URLSearchParams(form)) {
    const path = key.replace(/\]/g, "").split("[");
    let node = out;
    path.forEach((part, i) => {
      if (i === path.length - 1) node[part] = value;
      else node = node[part] ??= {};
    });
  }
  return out;
};

export const signStripePayload = (secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

export const createFakeStripe = (options: { secretKey?: string; livemode?: boolean } = {}) => {
  const secretKey = options.secretKey ?? "sk_test_fake";
  const intents = new Map<string, Intent>();
  const charges = new Map<string, Charge>();
  const refunds = new Map<string, Refund>();
  const idempotent = new Map<string, { status: number; body: unknown }>();
  const requests: FakeStripeRequest[] = [];
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_${String(++sequence).padStart(6, "0")}`;
  /** Make the next call to `path` (and method) fail like Stripe would. */
  const failures: { method: string; path: RegExp; status: number; error: Record<string, unknown> }[] = [];

  const error = (status: number, body: Record<string, unknown>) => ({ status, body: { error: { type: "invalid_request_error", ...body } } });
  const missing = (id: string) => error(404, { code: "resource_missing", message: `No such object: '${id}'` });
  const unexpected = (intent: Intent, action: string) =>
    error(400, { code: "payment_intent_unexpected_state", message: `You cannot ${action} this PaymentIntent because it has a status of ${intent.status}.`, payment_intent: view(intent) });
  const view = (intent: Intent, expand: string[] = []) => ({
    ...intent,
    latest_charge: expand.includes("latest_charge") && intent.latest_charge ? charges.get(intent.latest_charge) ?? null : intent.latest_charge,
  });
  const UNPAID = ["requires_payment_method", "requires_confirmation", "requires_action"];

  const createRefund = (intent: Intent, amount: number | undefined, metadata: Record<string, string> = {}, reason: string | null = null) => {
    const charge = intent.latest_charge ? charges.get(intent.latest_charge) : undefined;
    if (intent.status !== "succeeded" || !charge) return error(400, { code: "charge_not_refundable", message: "This PaymentIntent has no successful charge to refund." });
    const remaining = charge.amount - charge.amount_refunded;
    const value = amount ?? remaining;
    if (value > remaining) return error(400, { code: "charge_already_refunded", message: `Refund amount exceeds what is left (${remaining}).` });
    const refund: Refund = { id: next("re"), object: "refund", amount: value, currency: intent.currency, status: "succeeded", reason, payment_intent: intent.id, charge: charge.id, metadata };
    refunds.set(refund.id, refund);
    charge.amount_refunded += value;
    charge.refunded = charge.amount_refunded >= charge.amount;
    return { status: 200, body: refund };
  };

  const route = (method: string, path: string, params: Record<string, any>, headers: Record<string, string>): { status: number; body: unknown } => {
    if (headers.authorization !== `Bearer ${secretKey}`) return { status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided" } } };
    const failure = failures.findIndex((f) => f.method === method && f.path.test(path));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return { status: f!.status, body: { error: f!.error } };
    }
    const expand = params.expand ? Object.values(params.expand as Record<string, string>) : [];
    let match: RegExpMatchArray | null;
    if (method === "GET" && path === "/v1/balance") return { status: 200, body: { object: "balance", livemode: options.livemode ?? false, available: [] } };
    if (method === "POST" && path === "/v1/payment_intents") {
      const intent: Intent = {
        id: next("pi"),
        object: "payment_intent",
        status: "requires_payment_method",
        amount: Number(params.amount),
        amount_capturable: 0,
        amount_received: 0,
        currency: params.currency,
        capture_method: params.capture_method ?? "automatic",
        client_secret: "",
        metadata: { ...params.metadata },
        latest_charge: null,
        last_payment_error: null,
        cancellation_reason: null,
        ...(params.statement_descriptor_suffix ? { statement_descriptor_suffix: params.statement_descriptor_suffix } : {}),
      };
      intent.client_secret = `${intent.id}_secret_${sequence}`;
      intents.set(intent.id, intent);
      return { status: 200, body: view(intent) };
    }
    if ((match = path.match(/^\/v1\/payment_intents\/([^/]+)$/))) {
      const intent = intents.get(decodeURIComponent(match[1]!));
      if (!intent) return missing(match[1]!);
      if (method === "GET") return { status: 200, body: view(intent, expand) };
      const changesPayment = ["amount", "currency", "capture_method"].some((k) => params[k] !== undefined);
      if (changesPayment && !UNPAID.includes(intent.status)) return unexpected(intent, "update");
      if (params.amount !== undefined) intent.amount = Number(params.amount);
      if (params.currency !== undefined) intent.currency = params.currency;
      if (params.capture_method !== undefined) intent.capture_method = params.capture_method;
      if (params.metadata) Object.assign(intent.metadata, params.metadata);
      return { status: 200, body: view(intent) };
    }
    if (method === "POST" && (match = path.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/))) {
      const intent = intents.get(decodeURIComponent(match[1]!));
      if (!intent) return missing(match[1]!);
      if (intent.status !== "requires_capture") return unexpected(intent, "capture");
      const amount = params.amount_to_capture !== undefined ? Number(params.amount_to_capture) : intent.amount_capturable;
      intent.status = "succeeded";
      intent.amount_received = amount;
      intent.amount_capturable = 0;
      charges.get(intent.latest_charge!)!.amount = amount;
      return { status: 200, body: view(intent) };
    }
    if (method === "POST" && (match = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/))) {
      const intent = intents.get(decodeURIComponent(match[1]!));
      if (!intent) return missing(match[1]!);
      if (intent.status === "succeeded" || intent.status === "canceled") return unexpected(intent, "cancel");
      intent.status = "canceled";
      intent.amount_capturable = 0;
      intent.cancellation_reason = params.cancellation_reason ?? null;
      return { status: 200, body: view(intent) };
    }
    if (method === "POST" && path === "/v1/refunds") {
      const intent = intents.get(params.payment_intent);
      if (!intent) return missing(params.payment_intent);
      return createRefund(intent, params.amount !== undefined ? Number(params.amount) : undefined, params.metadata);
    }
    if (method === "GET" && path === "/v1/refunds") {
      const list = [...refunds.values()].filter((r) => (!params.charge || r.charge === params.charge) && (!params.payment_intent || r.payment_intent === params.payment_intent));
      return { status: 200, body: { object: "list", data: list.reverse(), has_more: false } };
    }
    if (method === "GET" && (match = path.match(/^\/v1\/refunds\/([^/]+)$/))) {
      const refund = refunds.get(decodeURIComponent(match[1]!));
      return refund ? { status: 200, body: refund } : missing(match[1]!);
    }
    if (method === "GET" && (match = path.match(/^\/v1\/charges\/([^/]+)$/))) {
      const charge = charges.get(decodeURIComponent(match[1]!));
      return charge ? { status: 200, body: charge } : missing(match[1]!);
    }
    return { status: 404, body: { error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${path})` } } };
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected request to ${url.href}`);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const params = decodeForm(method === "GET" ? url.search.slice(1) : String(init?.body ?? ""));
    requests.push({ method, path: url.pathname, params, headers });
    const key = headers["idempotency-key"];
    const cached = key ? idempotent.get(key) : undefined;
    const result = cached ?? route(method, url.pathname, params, headers);
    if (key && !cached && result.status < 500) idempotent.set(key, result);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };

  const intent = (id: string) => {
    const found = intents.get(id);
    if (!found) throw new Error(`No PaymentIntent ${id}`);
    return found;
  };

  /** The customer confirms the PaymentIntent in the browser. With manual capture, "paid" authorizes. */
  const pay = (id: string, outcome: "paid" | "processing" | "declined" = "paid") => {
    const pi = intent(id);
    if (outcome === "declined") {
      pi.status = "requires_payment_method";
      pi.last_payment_error = { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." };
      return pi;
    }
    if (outcome === "processing") {
      pi.status = "processing";
      return pi;
    }
    const charge: Charge = { id: next("ch"), object: "charge", payment_intent: pi.id, amount: pi.amount, amount_refunded: 0, refunded: false, currency: pi.currency, metadata: { ...pi.metadata } };
    charges.set(charge.id, charge);
    pi.latest_charge = charge.id;
    pi.last_payment_error = null;
    if (pi.capture_method === "manual") {
      pi.status = "requires_capture";
      pi.amount_capturable = pi.amount;
    } else {
      pi.status = "succeeded";
      pi.amount_received = pi.amount;
    }
    return pi;
  };

  /** A refund made in the Stripe dashboard. */
  const refundInDashboard = (paymentIntentId: string, amount?: number) => {
    const result = createRefund(intent(paymentIntentId), amount, {}, "requested_by_customer");
    if (result.status !== 200) throw new Error(JSON.stringify(result.body));
    return result.body as Refund;
  };

  /** A Stripe event, as JSON. */
  const event = (type: string, object: Record<string, unknown>, id = next("evt")) => ({ id, object: "event", type, livemode: options.livemode ?? false, created: Math.floor(Date.now() / 1000), data: { object } });

  /** The webhook request Stripe would send to the platform. */
  const webhook = (url: string, secret: string, body: Record<string, unknown>, options: { signature?: string; timestamp?: number } = {}) => {
    const raw = JSON.stringify(body);
    return new Request(url, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": options.signature ?? signStripePayload(secret, raw, options.timestamp) }, body: raw });
  };

  return {
    secretKey,
    fetch,
    requests,
    intents,
    charges,
    refunds,
    intent,
    pay,
    refundInDashboard,
    event,
    webhook,
    /** The charge as webhooks carry it: without refunds, as in API versions since 2022-11-15. */
    chargeOf: (paymentIntentId: string) => ({ ...charges.get(intent(paymentIntentId).latest_charge!)! }),
    failNext: (method: string, path: RegExp, status: number, error: Record<string, unknown>) => failures.push({ method, path, status, error }),
    reset: () => (requests.length = 0),
  };
};

export type FakeStripe = ReturnType<typeof createFakeStripe>;
