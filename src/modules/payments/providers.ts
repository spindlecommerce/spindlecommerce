import { randomToken } from "../../lib/crypto.ts";
import { PaymentDeclinedError } from "../../lib/errors.ts";
import type { AuthorizeInput, AuthorizeResult, PaymentSession, PaymentSessionInput, PaymentWebhookResult, ProviderResult } from "../../plugins/sdk.ts";

export type { AuthorizeInput, AuthorizeResult, PaymentSession, PaymentSessionInput, PaymentWebhookResult, ProviderResult };

/**
 * A PSP as the platform calls it: built in, or a plugin's definition bound to its context. A bound
 * plugin provider must define `isAvailable`, false while the plugin is disabled or not configured,
 * and pass every input through (`void` carries `session`).
 */
export interface PaymentProvider {
  readonly code: string;
  readonly title?: string;
  readonly description?: string;
  /** Unset for built-in providers. */
  readonly plugin?: string;
  isAvailable?(input: { currency: string; countryCode: string | null; amount: number }): Promise<boolean>;
  createSession?(input: PaymentSessionInput): Promise<PaymentSession>;
  /** For orders placed from a PSP webhook, `paymentData` is `{ pspReference }`. */
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  capture(input: { orderId: string; amount: number; currency: string; pspReference: string | null }): Promise<ProviderResult>;
  refund(input: { orderId: string; amount: number; currency: string; pspReference: string | null }): Promise<ProviderResult>;
  /**
   * Cancel an order's authorization. With an empty `orderId`, checkout placed no order: release
   * what the payment secured, found by `pspReference` or `session`, and leave an unpaid one usable.
   */
  void(input: { orderId: string; pspReference: string | null; session?: Record<string, unknown> | null }): Promise<ProviderResult>;
  webhook?(request: Request): Promise<PaymentWebhookResult>;
}

/** Nothing is charged at checkout; staff record the payment with a capture when it arrives. */
export const offlineProvider: PaymentProvider = {
  code: "offline",
  title: "Offline payment",
  description: "Bank transfer, check or cash on delivery: staff record the payment when it arrives.",
  authorize: async () => ({ status: "pending", pspReference: null }),
  capture: async () => ({ pspReference: null, raw: { manual: true } }),
  refund: async () => ({ pspReference: null, raw: { manual: true } }),
  void: async () => ({ pspReference: null }),
};

/** Deterministic card gateway for development and tests, using PSP-style test tokens. */
export const testGatewayProvider: PaymentProvider = {
  code: "test_gateway",
  title: "Test gateway",
  description: "A fake card gateway for development: tok_visa succeeds, tok_declined is declined.",
  authorize: async ({ amount, paymentData, captureImmediately }) => {
    const token = typeof paymentData.token === "string" ? paymentData.token : "tok_visa";
    if (token === "tok_declined") throw new PaymentDeclinedError("card_declined", "The card was declined");
    if (token === "tok_insufficient_funds") throw new PaymentDeclinedError("insufficient_funds", "The card has insufficient funds");
    if (amount <= 0) return { status: "captured", pspReference: null };
    return { status: captureImmediately ? "captured" : "authorized", pspReference: `tg_${randomToken(12)}`, raw: { token, last4: "4242" } };
  },
  capture: async ({ pspReference }) => ({ pspReference: pspReference ?? `tg_${randomToken(12)}` }),
  refund: async () => ({ pspReference: `tgr_${randomToken(12)}` }),
  void: async ({ pspReference }) => ({ pspReference }),
};

export type PaymentProviderRegistry = ReadonlyMap<string, PaymentProvider>;

export const createProviderRegistry = (...providers: PaymentProvider[]): PaymentProviderRegistry =>
  new Map([offlineProvider, testGatewayProvider, ...providers].map((p) => [p.code, p]));

/**
 * For quotes inside a transaction; check availability before it. A check may be slow or query the
 * database, and must not run while the transaction holds locks (on PGlite it deadlocks).
 */
export const withoutAvailabilityChecks = (registry: PaymentProviderRegistry): PaymentProviderRegistry =>
  new Map([...registry].map(([code, provider]) => [code, Object.assign(Object.create(provider) as PaymentProvider, { isAvailable: undefined })]));
