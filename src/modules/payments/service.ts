import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { pickLocalized } from "../../lib/i18n.ts";
import { parseInput } from "../../lib/validation.ts";
import { createProviderRegistry, type PaymentProviderRegistry } from "./providers.ts";
import { paymentMethods, paymentTransactions } from "./tables.ts";

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;

/** `sessionRequired`: call cartPaymentSessionCreate before placing the order. */
export type AvailablePaymentMethod = { code: string; name: string; instructions: string | null; provider: string; sessionRequired: boolean };

export const listAvailablePaymentMethods = async (
  db: Database,
  input: { channelId: string; countryCode: string | null; currency: string; grandTotal: number; locale: string },
  providers: PaymentProviderRegistry = createProviderRegistry(),
): Promise<AvailablePaymentMethod[]> => {
  const rows = await db.select().from(paymentMethods).where(eq(paymentMethods.isActive, true)).orderBy(asc(paymentMethods.position));
  const candidates = rows
    .filter((m) => providers.has(m.provider))
    .filter((m) => m.channelIds.length === 0 || m.channelIds.includes(input.channelId))
    .filter((m) => m.countries.length === 0 || (input.countryCode !== null && m.countries.includes(input.countryCode)))
    .filter((m) => {
      const min = m.config.minimumTotals?.[input.currency];
      const max = m.config.maximumTotals?.[input.currency];
      return (min === undefined || input.grandTotal >= min) && (max === undefined || input.grandTotal <= max);
    });
  // Once per provider; a check that fails hides its methods rather than failing the whole cart.
  const codes = [...new Set(candidates.map((m) => m.provider))];
  const available = new Map(
    await Promise.all(
      codes.map(async (code) => {
        const provider = providers.get(code)!;
        const ok = provider.isAvailable ? await provider.isAvailable({ currency: input.currency, countryCode: input.countryCode, amount: input.grandTotal }).catch(() => false) : true;
        return [code, ok] as const;
      }),
    ),
  );
  return candidates
    .filter((m) => available.get(m.provider))
    .map((m) => ({
      code: m.code,
      name: pickLocalized(m.name, input.locale) ?? m.code,
      instructions: m.config.instructions ? pickLocalized(m.config.instructions, input.locale) : null,
      provider: m.provider,
      sessionRequired: typeof providers.get(m.provider)!.createSession === "function",
    }));
};

const methodSchema = (providers: PaymentProviderRegistry) =>
  z.object({
    code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    name: z.record(z.string(), z.string()),
    provider: z.string().refine((p) => providers.has(p), "Unknown payment provider"),
    channelIds: z.array(z.uuid()).default([]),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).default([]),
    config: z
      .object({
        captureMode: z.enum(["authorize", "authorize_capture"]).optional(),
        instructions: z.record(z.string(), z.string()).optional(),
        minimumTotals: z.record(z.string(), z.number().int().nonnegative()).optional(),
        maximumTotals: z.record(z.string(), z.number().int().nonnegative()).optional(),
      })
      .default({}),
    isActive: z.boolean().default(true),
    position: z.number().int().default(0),
  });

export const createPaymentMethod = async (db: Database, providers: PaymentProviderRegistry, input: unknown) => {
  const [row] = await db.insert(paymentMethods).values(parseInput(methodSchema(providers), input)).returning();
  return row!;
};

export const updatePaymentMethod = async (db: Database, providers: PaymentProviderRegistry, id: string, input: unknown) => {
  const existing = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.id, id) });
  if (!existing) throw new NotFoundError("PaymentMethod", id);
  const data = parseInput(methodSchema(providers), { ...existing, ...(input as object), code: existing.code });
  const [row] = await db.update(paymentMethods).set({ ...data, updatedAt: new Date() }).where(eq(paymentMethods.id, id)).returning();
  return row!;
};

export const listPaymentMethods = (db: Database) => db.query.paymentMethods.findMany({ orderBy: asc(paymentMethods.position) });

export const findPaymentMethod = async (db: Database, code: string) => {
  const method = await db.query.paymentMethods.findFirst({ where: eq(paymentMethods.code, code) });
  if (!method) throw new ValidationError("Unknown payment method", [{ path: ["paymentMethodCode"], message: `No payment method ${code}` }]);
  return method;
};

export const recordTransaction = async (db: Database, input: typeof paymentTransactions.$inferInsert) => {
  const [row] = await db.insert(paymentTransactions).values(input).returning();
  return row!;
};

export const listTransactions = (db: Database, orderId: string) =>
  db.query.paymentTransactions.findMany({ where: eq(paymentTransactions.orderId, orderId), orderBy: asc(paymentTransactions.id) });
