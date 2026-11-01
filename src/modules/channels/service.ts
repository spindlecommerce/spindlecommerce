import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { NotFoundError } from "../../lib/errors.ts";
import { CURRENCY_CODE } from "../../lib/money.ts";
import { parseInput } from "../../lib/validation.ts";
import { channels, exchangeRates, sequences } from "./tables.ts";

export type Channel = typeof channels.$inferSelect;

const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;

export const channelInputSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    name: z.string().min(1).max(200),
    defaultLocale: z.string().regex(LOCALE),
    locales: z.array(z.string().regex(LOCALE)).min(1),
    defaultCurrency: z.string().regex(CURRENCY_CODE),
    currencies: z.array(z.string().regex(CURRENCY_CODE)).min(1),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    stockId: z.uuid().nullable().optional(),
    pricesIncludeTax: z.boolean().default(false),
    shippingTaxClassId: z.uuid().nullable().optional(),
    orderNumberPrefix: z.string().max(10).default(""),
    isActive: z.boolean().default(true),
  })
  .refine((c) => c.locales.includes(c.defaultLocale), { path: ["defaultLocale"], message: "Must be one of locales" })
  .refine((c) => c.currencies.includes(c.defaultCurrency), { path: ["defaultCurrency"], message: "Must be one of currencies" });

export const createChannel = async (db: Database, input: unknown): Promise<Channel> => {
  const data = parseInput(channelInputSchema, input);
  const [row] = await db.insert(channels).values(data).returning();
  return row!;
};

export const updateChannel = async (db: Database, id: string, input: unknown): Promise<Channel> => {
  const existing = await getChannel(db, id);
  const data = parseInput(channelInputSchema, { ...existing, ...(input as object) });
  const [row] = await db.update(channels).set(data).where(eq(channels.id, id)).returning();
  return row!;
};

export const getChannel = async (db: Database, id: string): Promise<Channel> => {
  const row = await db.query.channels.findFirst({ where: eq(channels.id, id) });
  if (!row) throw new NotFoundError("Channel", id);
  return row;
};

export const findChannelByCode = (db: Database, code: string) =>
  db.query.channels.findFirst({ where: and(eq(channels.code, code), eq(channels.isActive, true)) });

export const listChannels = (db: Database) => db.query.channels.findMany({ orderBy: channels.code });

export type ResolvedScope = { channel: Channel; locale: string; currency: string };

/** Unknown locales match by language, else the default; unknown currencies get the default. */
export const resolveScope = async (
  db: Database,
  requested: { channel?: string | null; locale?: string | null; currency?: string | null },
  defaultChannelCode?: string,
): Promise<ResolvedScope> => {
  const code = requested.channel ?? defaultChannelCode;
  const channel = code
    ? await findChannelByCode(db, code)
    : await db.query.channels.findFirst({ where: eq(channels.isActive, true), orderBy: channels.createdAt });
  if (!channel) throw new NotFoundError("Channel", code ?? "(default)");
  const locale = matchLocale(channel, requested.locale);
  const currency = requested.currency && channel.currencies.includes(requested.currency.toUpperCase())
    ? requested.currency.toUpperCase()
    : channel.defaultCurrency;
  return { channel, locale, currency };
};

const matchLocale = (channel: Channel, requested: string | null | undefined): string => {
  if (!requested) return channel.defaultLocale;
  // Accept-Language may carry a list: "de-CH,de;q=0.9,en;q=0.8"
  const candidates = requested.split(",").map((part) => part.split(";")[0]!.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const exact = channel.locales.find((l) => l.toLowerCase() === candidate.toLowerCase());
    if (exact) return exact;
    const language = candidate.split("-")[0]!.toLowerCase();
    const sameLanguage = channel.locales.find((l) => l.split("-")[0]!.toLowerCase() === language);
    if (sameLanguage) return sameLanguage;
  }
  return channel.defaultLocale;
};

/** Atomic counter: one statement, safe under concurrency. */
export const nextSequenceValue = async (db: Database, key: string): Promise<number> => {
  const [row] = await db
    .insert(sequences)
    .values({ key, value: 1 })
    .onConflictDoUpdate({ target: sequences.key, set: { value: sql`${sequences.value} + 1` } })
    .returning({ value: sequences.value });
  return row!.value;
};

export const formatDocumentNumber = (prefix: string, value: number) => `${prefix}${String(value).padStart(6, "0")}`;

export const getExchangeRate = async (db: Database, base: string, quote: string): Promise<number | null> => {
  if (base === quote) return 1;
  const row = await db.query.exchangeRates.findFirst({
    where: and(eq(exchangeRates.baseCurrency, base), eq(exchangeRates.quoteCurrency, quote)),
  });
  return row ? Number(row.rate) : null;
};

export const setExchangeRate = async (db: Database, base: string, quote: string, rate: number) => {
  await db
    .insert(exchangeRates)
    .values({ baseCurrency: base, quoteCurrency: quote, rate: String(rate) })
    .onConflictDoUpdate({ target: [exchangeRates.baseCurrency, exchangeRates.quoteCurrency], set: { rate: String(rate), updatedAt: new Date() } });
};

export const listExchangeRates = (db: Database) => db.query.exchangeRates.findMany({ orderBy: [exchangeRates.baseCurrency, exchangeRates.quoteCurrency] });

export const deleteExchangeRate = async (db: Database, base: string, quote: string) => {
  const [row] = await db
    .delete(exchangeRates)
    .where(and(eq(exchangeRates.baseCurrency, base), eq(exchangeRates.quoteCurrency, quote)))
    .returning();
  if (!row) throw new NotFoundError("ExchangeRate", `${base}/${quote}`);
  return row;
};
