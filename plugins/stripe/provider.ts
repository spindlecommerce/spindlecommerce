import { createHash } from "node:crypto";
import {
  InvalidStateError,
  PaymentDeclinedError,
  ValidationError,
  type AuthorizeResult,
  type PaymentProviderDefinition,
  type PaymentSessionInput,
  type PaymentWebhookEvent,
  type PluginContext,
} from "../../src/plugins/sdk.ts";
import {
  isMissing,
  StripeError,
  stripeRequest,
  verifyStripeSignature,
  type StripeCharge,
  type StripeDispute,
  type StripeEvent,
  type StripePaymentIntent,
  type StripeRefund,
} from "./api.ts";
import type { StripeSettings } from "./settings.ts";

type Context = PluginContext<StripeSettings>;

/** Statuses in which a PaymentIntent's amount, currency and capture method can still change. */
const UNPAID = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

const retrieve = (ctx: Context, id: string) => stripeRequest<StripePaymentIntent>(ctx, "GET", `/v1/payment_intents/${encodeURIComponent(id)}`, { expand: ["latest_charge"] });

const chargeOf = (intent: StripePaymentIntent) => (intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null);
const refunded = (intent: StripePaymentIntent) => (chargeOf(intent)?.amount_refunded ?? 0) > 0;
const matches = (intent: StripePaymentIntent, amount: number, currency: string) => intent.amount === amount && intent.currency === currency.toLowerCase();

/** Shows staff Stripe's refusal of their request, e.g. capturing an expired authorization. */
const staffFacing = (error: unknown) =>
  error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 401 ? new InvalidStateError(`Stripe: ${error.message}`) : error;

/** The PaymentIntent behind a stored reference: its own id, or a refund's or charge's. */
const paymentIntentId = async (ctx: Context, reference: string | null) => {
  if (!reference) throw new InvalidStateError("This order has no Stripe payment");
  const parent =
    reference.startsWith("re_") ? await stripeRequest<StripeRefund>(ctx, "GET", `/v1/refunds/${encodeURIComponent(reference)}`)
    : reference.startsWith("ch_") || reference.startsWith("py_") ? await stripeRequest<StripeCharge>(ctx, "GET", `/v1/charges/${encodeURIComponent(reference)}`)
    : null;
  if (!parent) return reference;
  if (!parent.payment_intent) throw new InvalidStateError(`Stripe ${reference} belongs to no PaymentIntent`);
  return parent.payment_intent;
};

const cancel = async (ctx: Context, id: string, reason?: string) => {
  try {
    return await stripeRequest<StripePaymentIntent>(ctx, "POST", `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, reason ? { cancellation_reason: reason } : {});
  } catch (error) {
    if (error instanceof StripeError && error.paymentIntent?.status === "canceled") return error.paymentIntent;
    throw error;
  }
};

/** Cancels an authorization or refunds a payment; an unpaid PaymentIntent is left as it is. */
const release = async (ctx: Context, intent: StripePaymentIntent): Promise<{ pspReference: string; raw: Record<string, unknown> }> => {
  if (intent.status === "requires_capture" || intent.status === "processing") {
    const canceled = await cancel(ctx, intent.id, "abandoned");
    return { pspReference: canceled.id, raw: { released: "canceled", status: canceled.status } };
  }
  const charge = chargeOf(intent);
  if (intent.status === "succeeded" && (!charge || charge.amount_refunded < charge.amount)) {
    const refund = await stripeRequest<StripeRefund>(ctx, "POST", "/v1/refunds", { payment_intent: intent.id, metadata: { reason: "checkout_not_placed" } });
    return { pspReference: refund.id, raw: { released: "refunded", status: refund.status, paymentIntent: intent.id } };
  }
  return { pspReference: intent.id, raw: { released: false, status: intent.status } };
};

const intentParams = (input: PaymentSessionInput, ctx: Context) => ({
  amount: input.amount,
  currency: input.currency.toLowerCase(),
  capture_method: input.captureImmediately ? "automatic" : "manual",
  metadata: { cart_id: input.cartId, method_code: input.methodCode },
  statement_descriptor_suffix: text(ctx.settings.statementDescriptorSuffix),
});

/** Hashes the request, so a repeat (a double click, an effect run twice) reuses the PaymentIntent. */
const creationKey = (cartId: string, params: Record<string, unknown>, replacing: string | null) =>
  `ecom-cart-${cartId}-${createHash("sha256").update(JSON.stringify([params, replacing])).digest("hex").slice(0, 32)}`;

const mapStatus = (status: string): AuthorizeResult["status"] | null =>
  status === "requires_capture" ? "authorized" : status === "succeeded" ? "captured" : status === "processing" ? "pending" : null;

const intentEvent = (event: StripeEvent, type: PaymentWebhookEvent["type"], fields: { amount?: number; reason?: string | null } = {}): PaymentWebhookEvent => {
  const intent = event.data.object as unknown as StripePaymentIntent;
  return {
    id: event.id,
    type,
    pspReference: intent.id,
    amount: fields.amount,
    currency: intent.currency.toUpperCase(),
    cartId: text(intent.metadata?.cart_id) ?? undefined,
    orderId: text(intent.metadata?.order_id) ?? undefined,
    reason: fields.reason ?? undefined,
    raw: { event: event.type, status: intent.status },
  };
};

/** Webhook events, as payment events: PaymentIntents' outcomes, refunds made anywhere, disputes. */
const toPaymentEvents = async (event: StripeEvent, ctx: Context): Promise<PaymentWebhookEvent[]> => {
  const object = event.data.object;
  switch (event.type) {
    case "payment_intent.amount_capturable_updated":
      return [intentEvent(event, "authorized", { amount: (object as unknown as StripePaymentIntent).amount_capturable })];
    case "payment_intent.succeeded":
      return [intentEvent(event, "captured", { amount: (object as unknown as StripePaymentIntent).amount_received })];
    case "payment_intent.payment_failed": {
      const error = (object as unknown as StripePaymentIntent).last_payment_error;
      return [intentEvent(event, "failed", { amount: (object as unknown as StripePaymentIntent).amount, reason: error?.message ?? error?.code ?? null })];
    }
    case "payment_intent.canceled":
      return [intentEvent(event, "canceled", { reason: (object as unknown as StripePaymentIntent).cancellation_reason ?? null })];
    case "charge.refunded": {
      const charge = object as unknown as StripeCharge;
      if (typeof charge.payment_intent !== "string") return [];
      // Newer API versions omit a charge's refunds, and long lists are paged.
      const refunds = charge.refunds?.data && !charge.refunds.has_more ? charge.refunds.data : (await stripeRequest<{ data: StripeRefund[] }>(ctx, "GET", "/v1/refunds", { charge: charge.id, limit: 100 })).data;
      return refunds
        .filter((r) => r.status !== "failed" && r.status !== "canceled")
        .map((r) => ({
          id: `${event.id}:${r.id}`,
          type: "refunded" as const,
          pspReference: charge.payment_intent as string,
          refundReference: r.id,
          amount: r.amount,
          currency: r.currency.toUpperCase(),
          cartId: text(charge.metadata?.cart_id) ?? undefined,
          orderId: text(charge.metadata?.order_id) ?? undefined,
          reason: r.reason ?? undefined,
          raw: { event: event.type, refund: r.id, status: r.status },
        }));
    }
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      const dispute = object as unknown as StripeDispute;
      // Charges without a PaymentIntent weren't made by this platform.
      if (typeof dispute.payment_intent !== "string") return [];
      const opened = event.type === "charge.dispute.created";
      return [
        {
          id: event.id,
          type: opened ? "dispute_opened" : "dispute_closed",
          pspReference: dispute.payment_intent,
          amount: dispute.amount,
          currency: dispute.currency.toUpperCase(),
          reason: opened ? dispute.reason : dispute.status,
          raw: { event: event.type, dispute: dispute.id, status: dispute.status },
        },
      ];
    }
    default:
      return [];
  }
};

/** PaymentIntents with automatic payment methods, paid with the Payment Element. See README.md. */
export const stripeProvider: PaymentProviderDefinition<StripeSettings> = {
  code: "stripe",
  title: "Stripe",
  description: "Cards, wallets and local payment methods through Stripe's Payment Element.",

  /**
   * One PaymentIntent per cart, updated while unpaid. One already paid for this total is kept; one
   * paid for another total is given back and replaced.
   */
  createSession: async (input, ctx) => {
    const publishableKey = ctx.settings.publishableKey;
    // Nothing to pay (a fully discounted cart): the storefront places the order directly.
    if (input.amount <= 0) return { data: { paymentIntentId: null }, clientData: { clientSecret: null, publishableKey } };
    const params = intentParams(input, ctx);
    const previousId = text(input.previous?.paymentIntentId);
    let intent: StripePaymentIntent | null = null;
    try {
      const previous = previousId ? await retrieve(ctx, previousId).catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error))) : null;
      if (previous && UNPAID.has(previous.status)) {
        intent = await stripeRequest<StripePaymentIntent>(ctx, "POST", `/v1/payment_intents/${encodeURIComponent(previous.id)}`, params);
      } else if (previous && ["requires_capture", "processing", "succeeded"].includes(previous.status) && matches(previous, input.amount, input.currency) && !refunded(previous)) {
        intent = previous;
      } else if (previous) {
        await release(ctx, previous);
      }
      intent ??= await stripeRequest<StripePaymentIntent>(ctx, "POST", "/v1/payment_intents", { ...params, automatic_payment_methods: { enabled: true } }, { idempotencyKey: creationKey(input.cartId, params, previousId) });
      // An idempotent replay may return an intent canceled since; start afresh.
      if (intent.status === "canceled") intent = await stripeRequest<StripePaymentIntent>(ctx, "POST", "/v1/payment_intents", { ...params, automatic_payment_methods: { enabled: true } });
    } catch (error) {
      // An amount below Stripe's minimum, an unsupported currency: not payable as it stands.
      if (error instanceof StripeError && error.type === "invalid_request_error" && error.status === 400) throw new InvalidStateError(`Stripe cannot take this payment: ${error.message}`);
      throw error;
    }
    return { data: { paymentIntentId: intent.id }, clientData: { clientSecret: intent.client_secret, publishableKey } };
  },

  /** Checks the confirmed PaymentIntent belongs to the cart and matches the order total exactly. */
  authorize: async (input, ctx) => {
    if (input.amount <= 0) return { status: "captured", pspReference: null };
    // paymentData: the payment a webhook reported, when the platform places the order itself.
    const id = text(input.paymentData.pspReference) ?? text(input.paymentData.paymentIntentId) ?? text(input.session?.paymentIntentId);
    if (!id) throw new PaymentDeclinedError("payment_incomplete", "No payment was started for this checkout");
    let intent = await retrieve(ctx, id).catch((error: unknown) => {
      throw isMissing(error) ? new PaymentDeclinedError("payment_incomplete", "The payment was not found") : error;
    });
    if (input.cartId && text(intent.metadata?.cart_id) && intent.metadata!.cart_id !== input.cartId) throw new PaymentDeclinedError("payment_mismatch", "The payment belongs to another checkout");
    if (!matches(intent, input.amount, input.currency)) throw new PaymentDeclinedError("amount_mismatch", "The payment does not match the order total; pay again");
    // The method now captures at checkout, but the intent was made to authorize only.
    if (intent.status === "requires_capture" && input.captureImmediately) {
      intent = await stripeRequest<StripePaymentIntent>(ctx, "POST", `/v1/payment_intents/${encodeURIComponent(intent.id)}/capture`, {}, { idempotencyKey: `ecom-capture-${intent.id}` });
    }
    const status = mapStatus(intent.status);
    if (!status) {
      const error = intent.last_payment_error;
      throw new PaymentDeclinedError(error?.decline_code ?? error?.code ?? "payment_incomplete", error?.message ?? `The payment is not complete (${intent.status.replaceAll("_", " ")})`);
    }
    if (status === "captured" && refunded(intent)) throw new PaymentDeclinedError("payment_refunded", "The payment was refunded; pay again");
    try {
      await stripeRequest(ctx, "POST", `/v1/payment_intents/${encodeURIComponent(intent.id)}`, { metadata: { order_id: input.orderId, order_number: input.orderNumber } });
    } catch (error) {
      // Only a label in the Stripe dashboard: the platform finds the order by the PaymentIntent's id.
      ctx.logger.warn({ err: error, paymentIntent: intent.id, orderId: input.orderId }, "Could not label the PaymentIntent with its order");
    }
    const charge = chargeOf(intent);
    return { status, pspReference: intent.id, raw: { status: intent.status, ...(charge ? { charge: charge.id } : {}) } };
  },

  capture: async (input, ctx) => {
    try {
      const id = await paymentIntentId(ctx, input.pspReference);
      try {
        const intent = await stripeRequest<StripePaymentIntent>(ctx, "POST", `/v1/payment_intents/${encodeURIComponent(id)}/capture`, { amount_to_capture: input.amount }, { idempotencyKey: `ecom-capture-${id}-${input.amount}` });
        return { pspReference: intent.id, raw: { status: intent.status, amountReceived: intent.amount_received } };
      } catch (error) {
        // Captured already (a retry, or in the Stripe dashboard): the outcome staff asked for.
        if (error instanceof StripeError && error.paymentIntent?.status === "succeeded") return { pspReference: id, raw: { status: "succeeded", amountReceived: error.paymentIntent.amount_received } };
        throw error;
      }
    } catch (error) {
      throw staffFacing(error);
    }
  },

  refund: async (input, ctx) => {
    try {
      const id = await paymentIntentId(ctx, input.pspReference);
      const refund = await stripeRequest<StripeRefund>(ctx, "POST", "/v1/refunds", { payment_intent: id, amount: input.amount, metadata: { order_id: input.orderId } });
      return { pspReference: refund.id, raw: { status: refund.status, paymentIntent: id } };
    } catch (error) {
      throw staffFacing(error);
    }
  },

  /** Cancels an order's authorization; without an order, releases whatever the checkout secured. */
  void: async (input: { orderId: string; pspReference: string | null; session?: Record<string, unknown> | null }, ctx) => {
    try {
      const id = input.pspReference ? await paymentIntentId(ctx, input.pspReference) : text(input.session?.paymentIntentId);
      if (!id) return { pspReference: null };
      if (!input.orderId) return await release(ctx, await retrieve(ctx, id));
      const intent = await cancel(ctx, id);
      return { pspReference: intent.id, raw: { status: intent.status } };
    } catch (error) {
      throw staffFacing(error);
    }
  },

  webhook: async (request, ctx) => {
    const secret = ctx.settings.webhookSecret;
    if (!secret) throw new ValidationError("Stripe webhooks are refused until the webhook signing secret is set");
    const body = await request.text();
    if (!verifyStripeSignature(secret, body, request.headers.get("stripe-signature") ?? "")) throw new ValidationError("Invalid Stripe signature");
    return { events: await toPaymentEvents(JSON.parse(body) as StripeEvent, ctx) };
  },
};
