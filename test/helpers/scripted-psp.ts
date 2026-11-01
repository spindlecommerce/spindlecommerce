import { PaymentDeclinedError, ValidationError } from "../../src/lib/errors.ts";
import type { AuthorizeInput, PaymentProvider, PaymentSessionInput } from "../../src/modules/payments/providers.ts";
import type { PaymentWebhookEvent } from "../../src/plugins/sdk.ts";

type Payment = { ref: string; cartId: string; amount: number; currency: string; status: "unpaid" | "pending" | "authorized" | "captured"; released: boolean };

/** A payment provider whose PSP the test plays: `pay` as the customer, `webhook` to send events. */
export const createScriptedPsp = (code = "scripted") => {
  const payments = new Map<string, Payment>();
  const calls: { method: string; input: unknown }[] = [];
  let available: boolean | "throw" = true;
  let sequence = 0;
  const provider: PaymentProvider = {
    code,
    title: "Scripted PSP",
    description: "A PSP played by the test.",
    plugin: code,
    isAvailable: async (input) => {
      calls.push({ method: "isAvailable", input });
      if (available === "throw") throw new Error("PSP down");
      return available;
    },
    createSession: async (input: PaymentSessionInput) => {
      calls.push({ method: "createSession", input });
      const previous = typeof input.previous?.ref === "string" ? payments.get(input.previous.ref) : undefined;
      const payment = previous && previous.status === "unpaid" ? previous : { ref: `${code}_${++sequence}`, cartId: input.cartId, amount: 0, currency: "", status: "unpaid" as const, released: false };
      Object.assign(payment, { amount: input.amount, currency: input.currency });
      payments.set(payment.ref, payment);
      return { data: { ref: payment.ref }, clientData: { token: `tok_${payment.ref}` } };
    },
    authorize: async (input: AuthorizeInput) => {
      calls.push({ method: "authorize", input });
      const ref = typeof input.paymentData.pspReference === "string" ? input.paymentData.pspReference : (input.session?.ref as string | undefined);
      const payment = ref ? payments.get(ref) : undefined;
      if (!payment || payment.status === "unpaid") throw new PaymentDeclinedError("payment_incomplete", "Not paid");
      if (payment.amount !== input.amount || payment.currency !== input.currency) throw new PaymentDeclinedError("amount_mismatch", "Another amount was paid");
      return { status: payment.status, pspReference: payment.ref };
    },
    capture: async (input) => ({ pspReference: input.pspReference }),
    refund: async () => ({ pspReference: `${code}_refund_${++sequence}` }),
    void: async (input) => {
      calls.push({ method: "void", input });
      const ref = input.pspReference ?? (input.session?.ref as string | undefined);
      const payment = ref ? payments.get(ref) : undefined;
      if (payment && payment.status !== "unpaid") payment.released = true;
      return { pspReference: ref ?? null };
    },
    webhook: async (request) => {
      if (request.headers.get("x-signature") !== "valid") throw new ValidationError("Bad signature");
      return (await request.json()) as { events: PaymentWebhookEvent[] };
    },
  };
  return {
    provider,
    payments,
    calls,
    callsOf: (method: string) => calls.filter((c) => c.method === method).map((c) => c.input as Record<string, any>),
    setAvailable: (value: boolean | "throw") => (available = value),
    /** The customer pays in the browser; `pending` while the PSP is still processing. */
    pay: (ref: string, status: "pending" | "authorized" | "captured" = "authorized") => Object.assign(payments.get(ref)!, { status }),
    /** A payment made outside any session, e.g. from a second tab. */
    payment: (cartId: string, amount: number, currency: string, status: "authorized" | "captured" = "captured") => {
      const payment = { ref: `${code}_${++sequence}`, cartId, amount, currency, status, released: false };
      payments.set(payment.ref, payment);
      return payment;
    },
    webhook: (events: PaymentWebhookEvent[], signature = "valid") =>
      new Request(`http://ecom.test/payments/webhooks/${code}`, { method: "POST", headers: { "content-type": "application/json", "x-signature": signature }, body: JSON.stringify({ events }) }),
  };
};

export type ScriptedPsp = ReturnType<typeof createScriptedPsp>;
