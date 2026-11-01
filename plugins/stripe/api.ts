import { createHmac, timingSafeEqual } from "node:crypto";
import type { PluginContext } from "../../src/plugins/sdk.ts";
import type { StripeSettings } from "./settings.ts";

/**
 * Stripe's REST API over the platform's fetch, without the SDK. The version is pinned so responses
 * keep the shape read here (latest_charge on PaymentIntents, refunds listed apart from charges).
 */
export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_VERSION = "2024-06-20";

export type StripeCharge = {
  id: string;
  payment_intent: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  metadata?: Record<string, string>;
  refunds?: { data: StripeRefund[]; has_more?: boolean } | null;
};

export type StripePaymentIntent = {
  id: string;
  status: string;
  amount: number;
  amount_capturable?: number;
  amount_received?: number;
  currency: string;
  client_secret: string | null;
  metadata?: Record<string, string>;
  /** An id, or the charge itself when expanded. */
  latest_charge?: string | StripeCharge | null;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
  cancellation_reason?: string | null;
};

export type StripeRefund = { id: string; amount: number; currency: string; status: string | null; reason: string | null; payment_intent: string | null };

export type StripeDispute = { id: string; amount: number; currency: string; reason: string; status: string; payment_intent: string | null };

export type StripeEvent = { id: string; type: string; livemode: boolean; data: { object: Record<string, unknown> } };

/** `paymentIntent` is set on state errors, e.g. canceling an intent that succeeded. */
export class StripeError extends Error {
  readonly status: number;
  readonly type: string | null;
  readonly code: string | null;
  readonly declineCode: string | null;
  readonly paymentIntent: StripePaymentIntent | null;
  constructor(status: number, error: { message?: string; type?: string; code?: string; decline_code?: string; payment_intent?: StripePaymentIntent }) {
    super(error.message ?? `Stripe answered ${status}`);
    this.name = "StripeError";
    this.status = status;
    this.type = error.type ?? null;
    this.code = error.code ?? null;
    this.declineCode = error.decline_code ?? null;
    this.paymentIntent = error.payment_intent ?? null;
  }
}

export const isMissing = (error: unknown) => error instanceof StripeError && error.code === "resource_missing";

/** Stripe's form encoding: objects as `a[b]=c`, arrays as `a[0]=c`; nullish values are left out. */
export const encodeForm = (params: Record<string, unknown>): string => {
  const pairs: [string, string][] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else pairs.push([key, String(value)]);
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return new URLSearchParams(pairs).toString();
};

export const stripeRequest = async <T>(
  ctx: Pick<PluginContext<StripeSettings>, "fetch" | "settings">,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  options: { idempotencyKey?: string } = {},
): Promise<T> => {
  const form = encodeForm(params);
  const response = await ctx.fetch(method === "GET" && form ? `${STRIPE_API}${path}?${form}` : `${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.settings.secretKey}`,
      "stripe-version": STRIPE_VERSION,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: form } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: ConstructorParameters<typeof StripeError>[1] };
  if (!response.ok) throw new StripeError(response.status, body.error ?? {});
  return body as T;
};

/**
 * Stripe-Signature is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, with several v1
 * while a secret is rolled. Stale timestamps are refused so captured requests can't be replayed.
 */
export const verifyStripeSignature = (secret: string, body: string, header: string, now = Date.now(), toleranceSeconds = 300): boolean => {
  const parts = header.split(",").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
  });
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => Buffer.from(value));
  if (!Number.isInteger(timestamp) || signatures.length === 0 || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"));
  return signatures.some((signature) => signature.length === expected.length && timingSafeEqual(signature, expected));
};
