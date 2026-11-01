import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { completeAddress, type Address, type AddressDraft } from "../../lib/address.ts";
import { sha256 } from "../../lib/crypto.ts";
import { pickLocalized } from "../../lib/i18n.ts";
import type { RateQuote } from "../../plugins/sdk.ts";
import { getChannel } from "../channels/service.ts";
import { getStockLocationIds, listStockLocations } from "../inventory/service.ts";
import { createShippingRegistry, DEFAULT_RATE_CACHE_SECONDS, isBuiltInConfig, isLiveProvider, type RateContext, type ShippingProvider, type ShippingProviderRegistry, type ShippingRateRequest } from "./providers.ts";
import type { ShippingMethod, ShippingRate } from "./service.ts";
import { shippingMethods, shippingRateCache, shippingZones } from "./tables.ts";

/** Live providers get this long to answer (the SDK promises plugins 10 seconds). */
export const LIVE_RATE_TIMEOUT_MS = 10_000;

/**
 * How long past expiry checkout still accepts a cached live rate. Checkout prices from the cache,
 * never calling a carrier while writing the order; after the grace it reports `shipping_method`
 * missing, and reading the cart again fetches fresh rates under the same codes.
 */
export const CHECKOUT_RATE_GRACE_SECONDS = 3600;

type RateLogger = Pick<Logger, "warn">;

/** `weightGrams` is per unit. */
export type RateLine = ShippingRateRequest["lines"][number];

/** `destination` may be incomplete; live providers then give no rates. */
export type RateInput = RateContext & { channelId: string; locale: string; destination: AddressDraft; lines: RateLine[] };

export type LiveRateRequest = { key: string; provider: ShippingProvider; request: ShippingRateRequest };

export type RateProviders = {
  shipping: ShippingProviderRegistry;
  /** False reads only the cache, for use inside transactions (checkout). */
  liveRates: boolean;
  logger?: RateLogger;
  /** Cache-only mode collects its misses here, for fetchLiveRates after the transaction. */
  misses?: LiveRateRequest[];
};

const ADDRESS_FIELDS = ["firstName", "lastName", "company", "line1", "line2", "city", "region", "regionCode", "postalCode", "countryCode", "phone"] as const;
const addressKey = (address: AddressDraft | Partial<Address> | null) => (address ? ADDRESS_FIELDS.map((f) => address[f] ?? null) : null);

/** The method's updatedAt stands for its options, so editing a method retires its cached rates. */
export const rateCacheKey = (provider: Pick<ShippingProvider, "code">, method: Pick<ShippingMethod, "id" | "updatedAt">, request: ShippingRateRequest) =>
  sha256(
    JSON.stringify([
      provider.code,
      method.id,
      method.updatedAt.toISOString(),
      request.channelId,
      request.locale,
      request.currency,
      request.subtotal,
      request.weightGrams,
      request.quantity,
      addressKey(request.destination),
      addressKey(request.origin),
      request.lines.map((l) => [l.sku, l.quantity, l.weightGrams, l.unitPrice]),
    ]),
  );

/** The channel stock's first active location by priority that has at least a country. */
export const shipFromLocation = async (db: Database, channelId: string): Promise<{ id: string; name: string; address: Partial<Address> } | null> => {
  const channel = await getChannel(db, channelId);
  if (!channel.stockId) return null;
  const ids = await getStockLocationIds(db, channel.stockId);
  const locations = await listStockLocations(db);
  for (const id of ids) {
    const location = locations.find((l) => l.id === id);
    if (location?.isActive && location.address.countryCode) return { id: location.id, name: location.name, address: location.address };
  }
  return null;
};

const quoteSchema = z.object({
  code: z.string().min(1).max(200),
  name: z.string().max(500),
  amount: z.number().int().nonnegative(),
  carrier: z.string().max(200).nullish(),
  minDeliveryDays: z.number().int().nonnegative().nullish(),
  maxDeliveryDays: z.number().int().nonnegative().nullish(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Valid quotes with unique codes, as plain JSON; invalid ones are logged and dropped. */
const cleanQuotes = (quotes: unknown, provider: ShippingProvider, method: string, logger?: RateLogger): RateQuote[] => {
  if (!Array.isArray(quotes)) throw new Error(`${provider.code} returned no list of rates`);
  const seen = new Set<string>();
  return quotes.flatMap((raw) => {
    const parsed = quoteSchema.safeParse(raw);
    if (!parsed.success) {
      logger?.warn({ provider: provider.code, method, issues: parsed.error.issues }, "Dropped an invalid shipping rate");
      return [];
    }
    if (seen.has(parsed.data.code)) return [];
    seen.add(parsed.data.code);
    return [JSON.parse(JSON.stringify(parsed.data)) as RateQuote];
  });
};

const withTimeout = <T>(work: () => Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
};

/** Providers that are inactive or fail to say, each asked once. */
const inactiveProviders = async (list: ShippingProvider[], logger?: RateLogger) => {
  const unique = [...new Map(list.map((p) => [p.code, p])).values()];
  const active = await Promise.all(
    unique.map(async (p) => {
      try {
        return (await p.isActive?.()) ?? true;
      } catch (error) {
        logger?.warn({ err: error, provider: p.code }, "Could not tell whether a shipping provider is active");
        return false;
      }
    }),
  );
  return new Set(unique.filter((_, i) => !active[i]).map((p) => p.code));
};

const readCachedRates = async (db: Database, keys: string[], graceSeconds: number) => {
  const rows = await db
    .select({ key: shippingRateCache.key, rates: shippingRateCache.rates })
    .from(shippingRateCache)
    .where(and(inArray(shippingRateCache.key, keys), gt(shippingRateCache.expiresAt, new Date(Date.now() - graceSeconds * 1000))));
  return new Map(rows.map((r) => [r.key, r.rates as RateQuote[]]));
};

const writeCachedRates = async (db: Database, rows: { key: string; quotes: RateQuote[]; expiresAt: Date }[], logger?: RateLogger) => {
  try {
    const unique = [...new Map(rows.map((r) => [r.key, r])).values()];
    await db
      .insert(shippingRateCache)
      .values(unique.map((r) => ({ key: r.key, rates: r.quotes, expiresAt: r.expiresAt })))
      .onConflictDoUpdate({ target: shippingRateCache.key, set: { rates: sql`excluded.rates`, expiresAt: sql`excluded.expires_at`, createdAt: sql`now()` } });
    // Prune a batch of rows past the checkout grace; they can never be used again.
    const unusable = db
      .select({ key: shippingRateCache.key })
      .from(shippingRateCache)
      .where(lt(shippingRateCache.expiresAt, new Date(Date.now() - CHECKOUT_RATE_GRACE_SECONDS * 1000)))
      .limit(200)
      .for("update", { skipLocked: true });
    await db.delete(shippingRateCache).where(inArray(shippingRateCache.key, unusable));
  } catch (error) {
    logger?.warn({ err: error }, "Could not cache shipping rates");
  }
};

/** Caches what live providers answer. A failure or timeout is logged; that method gets no rates. */
const fetchRates = async (db: Database, requests: LiveRateRequest[], logger?: RateLogger) => {
  const results = await Promise.all(
    requests.map(async ({ key, provider, request }) => {
      try {
        const answer = await withTimeout(() => provider.rates(request), LIVE_RATE_TIMEOUT_MS, `${provider.title} did not answer within ${LIVE_RATE_TIMEOUT_MS / 1000} seconds`);
        const quotes = cleanQuotes(answer, provider, request.method.code, logger);
        return [{ key, quotes, expiresAt: new Date(Date.now() + (provider.cacheSeconds ?? DEFAULT_RATE_CACHE_SECONDS) * 1000) }];
      } catch (error) {
        logger?.warn({ err: error, provider: provider.code, method: request.method.code }, "Live shipping rates failed; the method offers none");
        return [];
      }
    }),
  );
  const fetched = results.flat();
  if (fetched.length) await writeCachedRates(db, fetched, logger);
  return new Map(fetched.map((f) => [f.key, f.quotes]));
};

/** For the misses a cache-only quote collected. Call outside any transaction. */
export const fetchLiveRates = async (db: Database, requests: LiveRateRequest[], logger?: RateLogger) => {
  const inactive = await inactiveProviders(requests.map((r) => r.provider), logger);
  return fetchRates(db, requests.filter((r) => !inactive.has(r.provider.code)), logger);
};

const toShippingRate = (method: ShippingMethod, provider: ShippingProvider, quote: RateQuote, locale: string): ShippingRate => ({
  // Built-in methods quote under their own code, so their rate codes stay the method codes.
  code: quote.code === method.code ? method.code : `${method.code}:${quote.code}`,
  name: quote.name || (pickLocalized(method.name, locale) ?? method.code),
  description: pickLocalized(method.description, locale),
  carrier: quote.carrier ?? provider.code,
  amount: quote.amount,
  minDeliveryDays: quote.minDeliveryDays ?? method.minDeliveryDays,
  maxDeliveryDays: quote.maxDeliveryDays ?? method.maxDeliveryDays,
  taxClassId: method.taxClassId,
  details: { provider: provider.code, method: method.code, rate: quote.code, data: quote.data ?? {} },
});

/**
 * Rates from each active method whose zone covers the destination, in position order. A built-in
 * method gives at most one rate, coded as the method; a plugin provider any number, coded
 * `<method code>:<quote code>`. Without `liveRates` only the cache is read (with the checkout
 * grace) and no plugin code runs, so it is safe inside transactions.
 */
export const listShippingRates = async (
  db: Database,
  input: RateInput,
  providers: RateProviders = { shipping: createShippingRegistry(), liveRates: false },
): Promise<ShippingRate[]> => {
  const zones = (await db.select().from(shippingZones)).filter((z) => z.countries.includes(input.destination.countryCode));
  if (zones.length === 0) return [];
  const methods = await db
    .select()
    .from(shippingMethods)
    .where(and(eq(shippingMethods.isActive, true), inArray(shippingMethods.zoneId, zones.map((z) => z.id))))
    .orderBy(asc(shippingMethods.position));
  const routed = methods
    .filter((m) => m.channelIds.length === 0 || m.channelIds.includes(input.channelId))
    .flatMap((method) => {
      const provider = providers.shipping.get(method.config.kind);
      return provider ? [{ method, provider }] : [];
    });
  // Carriers price whole addresses: their methods offer rates once the destination is complete.
  const live = completeAddress(input.destination) ? routed.filter((r) => isLiveProvider(r.provider)) : [];
  const origin = live.length ? ((await shipFromLocation(db, input.channelId))?.address ?? null) : null;
  const requestFor = (method: ShippingMethod): ShippingRateRequest => ({
    method: {
      id: method.id,
      code: method.code,
      name: pickLocalized(method.name, input.locale) ?? method.code,
      options: isBuiltInConfig(method.config) ? method.config : (method.config.options ?? {}),
    },
    channelId: input.channelId,
    locale: input.locale,
    currency: input.currency,
    subtotal: input.subtotal,
    weightGrams: input.weightGrams,
    quantity: input.quantity,
    destination: input.destination,
    origin,
    lines: input.lines,
  });

  const quotes = new Map<string, RateQuote[]>();
  for (const { method, provider } of routed) {
    if (isLiveProvider(provider)) continue;
    try {
      quotes.set(method.id, cleanQuotes(await provider.rates(requestFor(method)), provider, method.code, providers.logger));
    } catch (error) {
      providers.logger?.warn({ err: error, provider: provider.code, method: method.code }, "Shipping rates failed; the method offers none");
    }
  }

  // isActive may read the database outside `db`, so only ask outside transactions.
  const inactive = providers.liveRates ? await inactiveProviders(live.map((r) => r.provider), providers.logger) : new Set<string>();
  const pending = live
    .filter((r) => !inactive.has(r.provider.code))
    .map(({ method, provider }) => {
      const request = requestFor(method);
      return { methodId: method.id, key: rateCacheKey(provider, method, request), provider, request };
    });
  if (pending.length) {
    const cached = await readCachedRates(db, pending.map((p) => p.key), providers.liveRates ? 0 : CHECKOUT_RATE_GRACE_SECONDS);
    const misses = pending.filter((p) => !cached.has(p.key)).map(({ key, provider, request }) => ({ key, provider, request }));
    const fetched = providers.liveRates && misses.length ? await fetchRates(db, misses, providers.logger) : new Map<string, RateQuote[]>();
    if (!providers.liveRates) providers.misses?.push(...misses);
    for (const p of pending) quotes.set(p.methodId, cached.get(p.key) ?? fetched.get(p.key) ?? []);
  }

  return routed.flatMap(({ method, provider }) => (quotes.get(method.id) ?? []).map((quote) => toShippingRate(method, provider, quote, input.locale)));
};
