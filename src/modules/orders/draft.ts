import { and, eq, inArray, TransactionRollbackError } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { addressSchema } from "../../lib/address.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { parseInput } from "../../lib/validation.ts";
import type { Platform } from "../../platform.ts";
import { buildQuote, quoteProviders, type Cart, type Quote, type QuoteProviders } from "../carts/quote.ts";
import { cartLines, carts } from "../carts/tables.ts";
import { productVariants } from "../catalog/tables.ts";
import { getChannel } from "../channels/service.ts";
import { placeOrder } from "../checkout/service.ts";
import { customers } from "../customers/tables.ts";
import { withoutAvailabilityChecks } from "../payments/providers.ts";
import { listAvailablePaymentMethods } from "../payments/service.ts";
import { isLiveProvider } from "../shipping/providers.ts";
import { fetchLiveRates, type LiveRateRequest } from "../shipping/rates.ts";
import { addOrderNote, appendOrderEvent, type Actor } from "./service.ts";

/**
 * Staff-created orders. The client sends the whole draft each time; it is staged as a cart, so it
 * prices and checks out exactly as the storefront does.
 */
const draftSchema = z.object({
  channelId: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  locale: z.string().min(2).nullish(),
  customerId: z.uuid().nullish(),
  email: z.email().nullish(),
  lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().positive().max(10_000) })).max(250),
  shippingAddress: addressSchema.nullish(),
  billingAddress: addressSchema.nullish(),
  billingSameAsShipping: z.boolean().nullish(),
  shippingMethodCode: z.string().nullish(),
  paymentMethodCode: z.string().nullish(),
  couponCodes: z.array(z.string().trim().min(1)).max(10).nullish(),
  note: z.string().trim().max(5000).nullish(),
});
export type DraftOrderInput = z.input<typeof draftSchema>;

const stageCart = async (db: Database, raw: DraftOrderInput): Promise<Cart> => {
  const input = parseInput(draftSchema, raw, ["input"]);
  const channel = await getChannel(db, input.channelId);
  const currency = input.currency ?? channel.defaultCurrency;
  if (!channel.currencies.includes(currency)) throw new ValidationError("Currency not sold in this channel", [{ path: ["input", "currency"], message: `Use one of ${channel.currencies.join(", ")}` }]);
  const locale = input.locale && channel.locales.includes(input.locale) ? input.locale : channel.defaultLocale;
  const customer = input.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, input.customerId) }) : null;
  if (input.customerId && !customer) throw new NotFoundError("Customer", input.customerId);
  if (input.shippingAddress && !channel.countries.includes(input.shippingAddress.countryCode)) {
    throw new ValidationError("The channel does not ship to this country", [{ path: ["input", "shippingAddress", "countryCode"], message: `${input.shippingAddress.countryCode} is not served by ${channel.code}` }]);
  }
  const quantities = new Map<string, number>();
  for (const line of input.lines) quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + line.quantity);
  const known = quantities.size ? await db.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.id, [...quantities.keys()])) : [];
  const missing = [...quantities.keys()].filter((id) => !known.some((k) => k.id === id));
  if (missing.length) throw new NotFoundError("ProductVariant", missing.join(", "));

  const [cart] = await db
    .insert(carts)
    .values({
      channelId: channel.id,
      customerId: customer?.id ?? null,
      currency,
      locale,
      email: input.email?.toLowerCase() ?? customer?.email ?? null,
      couponCodes: [...new Set((input.couponCodes ?? []).map((c) => c.toUpperCase()))],
      shippingAddress: input.shippingAddress ?? null,
      billingAddress: input.billingSameAsShipping ? (input.shippingAddress ?? null) : (input.billingAddress ?? null),
      shippingMethodCode: input.shippingMethodCode ?? null,
      paymentMethodCode: input.paymentMethodCode ?? null,
      note: input.note ?? null,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning();
  if (quantities.size) await db.insert(cartLines).values([...quantities].map(([variantId, quantity]) => ({ cartId: cart!.id, variantId, quantity })));
  return cart!;
};

export type DraftOrderQuote = {
  currency: string;
  requiresShipping: boolean;
  lines: {
    variantId: string;
    productId: string;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: number | null;
    subtotal: number | null;
    discount: number | null;
    tax: number | null;
    total: number | null;
    salableQuantity: number;
    issue: { code: string; message: string } | null;
  }[];
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  discounts: Quote["totals"]["discounts"];
  taxLines: Quote["totals"]["taxLines"];
  shippingRates: Quote["shippingRates"];
  selectedShippingMethodCode: string | null;
  paymentMethods: Quote["paymentMethods"];
  coupons: Quote["coupons"];
  missing: string[];
};

const summarize = (quote: Quote): DraftOrderQuote => ({
  currency: quote.cart.currency,
  requiresShipping: quote.requiresShipping,
  lines: quote.lines.map((l) => ({
    variantId: l.variant.id,
    productId: l.product.id,
    sku: l.variant.sku,
    name: l.name,
    quantity: l.line.quantity,
    unitPrice: l.unitPrice,
    subtotal: l.totals?.subtotal ?? null,
    discount: l.totals?.discount ?? null,
    tax: l.totals?.tax ?? null,
    total: l.totals?.total ?? null,
    salableQuantity: l.salableQuantity,
    issue: l.issue,
  })),
  subtotal: quote.totals.subtotal,
  discountTotal: quote.totals.discountTotal + quote.totals.shippingDiscount,
  shippingTotal: quote.totals.shippingTotal,
  taxTotal: quote.totals.taxTotal,
  grandTotal: quote.totals.grandTotal,
  discounts: quote.totals.discounts,
  taxLines: quote.totals.taxLines,
  shippingRates: quote.shippingRates,
  selectedShippingMethodCode: quote.selectedShippingRate?.code ?? null,
  paymentMethods: quote.paymentMethods,
  coupons: quote.coupons,
  missing: quote.missing,
});

const stagedQuote = async (db: Database, input: DraftOrderInput, providers?: QuoteProviders): Promise<DraftOrderQuote> => {
  let result: DraftOrderQuote | null = null;
  try {
    await db.transaction(async (tx) => {
      const cart = await stageCart(tx, input);
      result = summarize(await buildQuote(tx, cart, providers));
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
  return result!;
};

/**
 * Prices the draft in a rolled-back transaction. No provider code runs inside it (it may be slow,
 * and deadlocks PGlite): missing live rates are fetched after and the draft priced again, then
 * payment methods are checked with their providers.
 */
export const quoteDraftOrder = async (db: Database, input: DraftOrderInput, providers?: QuoteProviders): Promise<DraftOrderQuote> => {
  if (!providers) return stagedQuote(db, input);
  const inside: QuoteProviders = { ...providers, payments: withoutAvailabilityChecks(providers.payments), liveRates: false };
  const misses: LiveRateRequest[] = [];
  let quote = await stagedQuote(db, input, { ...inside, misses });
  if (providers.liveRates && misses.length) {
    await fetchLiveRates(db, misses, providers.logger);
    quote = await stagedQuote(db, input, inside);
  }
  const address = input.billingSameAsShipping ? input.shippingAddress : (input.billingAddress ?? input.shippingAddress);
  const available = await listAvailablePaymentMethods(
    db,
    { channelId: input.channelId, countryCode: address?.countryCode ?? null, currency: quote.currency, grandTotal: quote.grandTotal, locale: input.locale ?? "en" },
    providers.payments,
  );
  const paymentMethods = quote.paymentMethods.filter((m) => available.some((a) => a.code === m.code));
  const unavailable = !!input.paymentMethodCode && !paymentMethods.some((m) => m.code === input.paymentMethodCode);
  return { ...quote, paymentMethods, missing: unavailable && !quote.missing.includes("payment_method") ? [...quote.missing, "payment_method"] : quote.missing };
};

export const placeDraftOrder = async (platform: Platform, input: DraftOrderInput, actor: Actor, actorLabel: string) => {
  const cart = await platform.db.transaction((tx) => stageCart(tx, input));
  try {
    // Checkout prices from cached live rates only: make sure this cart's are there.
    if ([...platform.shipping.values()].some(isLiveProvider)) await buildQuote(platform.db, cart, quoteProviders(platform));
    const order = await placeOrder(platform, { cartId: cart.id, idempotencyKey: newId() }, { customerId: cart.customerId });
    await appendOrderEvent(platform.db, order.id, { type: "created_by_staff", message: `Created in the admin by ${actorLabel}`, actor });
    if (cart.note) await addOrderNote(platform.db, order.id, cart.note, actor);
    return order;
  } catch (error) {
    // Never leave the staged cart behind as the customer's active storefront cart.
    await platform.db.update(carts).set({ status: "abandoned", updatedAt: new Date() }).where(and(eq(carts.id, cart.id), eq(carts.status, "active")));
    throw error;
  }
};
