import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../db/client.ts";
import { completeAddress, missingAddressFields, type AddressDraft } from "../../lib/address.ts";
import { NotFoundError, type FieldError } from "../../lib/errors.ts";
import {
  ancestorIdsFromPath,
  getCategoriesByIds,
  getCategoryIdsByProductIds,
  getListingsByProductIds,
  getProductsByIds,
  getProductTypesByIds,
  getTranslationsByProductIds,
  getVariantsByIds,
  type Product,
  type ProductVariant,
} from "../catalog/read.ts";
import { getChannel, type Channel } from "../channels/service.ts";
import { GUEST_GROUP_CODE } from "../customers/service.ts";
import { customerGroups, customers } from "../customers/tables.ts";
import { getSalableQuantities, isAvailable } from "../inventory/stock.ts";
import { createProviderRegistry, type PaymentProviderRegistry } from "../payments/providers.ts";
import { listAvailablePaymentMethods, type AvailablePaymentMethod } from "../payments/service.ts";
import { resolveVariantPrices } from "../pricing/resolve.ts";
import { calculateTotals, type Totals, type TotalsLine, type TotalsLineInput } from "../pricing/totals.ts";
import { applyPromotions } from "../promotions/engine.ts";
import { loadApplicableRules } from "../promotions/service.ts";
import { createShippingRegistry, type ShippingProviderRegistry } from "../shipping/providers.ts";
import { listShippingRates, type LiveRateRequest } from "../shipping/rates.ts";
import type { ShippingRate } from "../shipping/service.ts";
import { loadTaxTables } from "../tax/service.ts";
import { cartLines, carts } from "./tables.ts";

export type Cart = typeof carts.$inferSelect;
export type CartLine = typeof cartLines.$inferSelect;

export type LineIssue = { code: "UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | "NO_PRICE"; message: string };

export type QuoteLine = {
  line: CartLine;
  variant: ProductVariant;
  product: Product;
  name: string;
  unitPrice: number | null;
  compareAtUnitPrice: number | null;
  totals: TotalsLine | null;
  salableQuantity: number;
  issue: LineIssue | null;
};

export type CouponStatus = { code: string; applied: boolean; reason: string | null };

export type Quote = {
  cart: Cart;
  channel: Channel;
  customerGroupId: string | null;
  lines: QuoteLine[];
  totals: Totals;
  requiresShipping: boolean;
  totalQuantity: number;
  totalWeightGrams: number;
  shippingRates: ShippingRate[];
  /** The shopper's choice if it is available; until they choose, the cheapest rate. */
  selectedShippingRate: ShippingRate | null;
  /** Falls back to the shipping address. */
  billingAddress: AddressDraft | null;
  paymentMethods: AvailablePaymentMethod[];
  coupons: CouponStatus[];
  /** What checkout still needs; empty means ready. */
  missing: string[];
  /** The same per field, with paths as in cartUpdate's input. */
  missingFields: FieldError[];
};

/** Ties go to the first, in method position order. */
const cheapest = (rates: ShippingRate[]) => rates.reduce<ShippingRate | null>((best, rate) => (!best || rate.amount < best.amount ? rate : best), null);

export const resolveCustomerPricingGroup = async (db: Database, customerId: string | null) => {
  if (customerId) {
    const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
    if (customer) {
      const group = await db.query.customerGroups.findFirst({ where: eq(customerGroups.id, customer.groupId) });
      return { groupId: customer.groupId, taxClassId: group?.taxClassId ?? null };
    }
  }
  const guest = await db.query.customerGroups.findFirst({ where: eq(customerGroups.code, GUEST_GROUP_CODE) });
  return { groupId: guest?.id ?? null, taxClassId: guest?.taxClassId ?? null };
};

/**
 * `liveRates: false` prices from cached carrier rates; never pass true inside a transaction, as
 * plugin code reads the database outside it. `misses` collects what the cache lacked, to fetch
 * after the transaction (fetchLiveRates).
 */
export type QuoteProviders = {
  payments: PaymentProviderRegistry;
  shipping: ShippingProviderRegistry;
  liveRates: boolean;
  logger?: Pick<Logger, "warn">;
  misses?: LiveRateRequest[];
};

export const BUILT_IN_QUOTE_PROVIDERS: QuoteProviders = { payments: createProviderRegistry(), shipping: createShippingRegistry(), liveRates: false };

export const quoteProviders = (
  platform: { payments: PaymentProviderRegistry; shipping: ShippingProviderRegistry; logger?: Pick<Logger, "warn"> },
  options: { liveRates?: boolean } = {},
): QuoteProviders => ({
  payments: platform.payments,
  shipping: platform.shipping,
  liveRates: options.liveRates ?? true,
  logger: platform.logger,
});

export const buildQuote = async (db: Database, cartOrId: Cart | string, providers: QuoteProviders = BUILT_IN_QUOTE_PROVIDERS, at = new Date()): Promise<Quote> => {
  const cart = typeof cartOrId === "string" ? await db.query.carts.findFirst({ where: eq(carts.id, cartOrId) }) : cartOrId;
  if (!cart) throw new NotFoundError("Cart", String(cartOrId));
  const channel = await getChannel(db, cart.channelId);
  const lineRows = await db.select().from(cartLines).where(eq(cartLines.cartId, cart.id)).orderBy(cartLines.id);
  const variants = new Map((await getVariantsByIds(db, lineRows.map((l) => l.variantId))).map((v) => [v.id, v]));
  const productIds = [...new Set([...variants.values()].map((v) => v.productId))];
  // Sequential on purpose: `db` may be a transaction, which runs one query at a time.
  const productRows = await getProductsByIds(db, productIds);
  const translations = await getTranslationsByProductIds(db, productIds);
  const listings = await getListingsByProductIds(db, productIds);
  const categoryIdsByProduct = await getCategoryIdsByProductIds(db, productIds);
  const productsById = new Map(productRows.map((p) => [p.id, p]));
  const types = new Map((await getProductTypesByIds(db, [...new Set(productRows.map((p) => p.productTypeId))])).map((t) => [t.id, t]));
  const categoryRows = new Map((await getCategoriesByIds(db, [...new Set([...categoryIdsByProduct.values()].flat())])).map((c) => [c.id, c]));
  const pricing = await resolveCustomerPricingGroup(db, cart.customerId);
  const prices = await resolveVariantPrices(
    db,
    [...variants.keys()],
    { channelId: channel.id, currency: cart.currency, defaultCurrency: channel.defaultCurrency, customerGroupId: pricing.groupId, at },
    new Map(lineRows.map((l) => [l.variantId, l.quantity])),
  );
  const salable = await getSalableQuantities(db, channel.stockId, [...variants.keys()]);

  const quoteLines: QuoteLine[] = [];
  const totalsLines: TotalsLineInput[] = [];
  for (const line of lineRows) {
    const variant = variants.get(line.variantId)!;
    const product = productsById.get(variant.productId)!;
    const t = translations.get(product.id) ?? [];
    const name = (t.find((x) => x.locale === cart.locale) ?? t.find((x) => x.locale === channel.defaultLocale) ?? t[0])?.name ?? variant.sku;
    const listing = listings.get(product.id)?.find((l) => l.channelId === channel.id);
    const price = prices.get(variant.id);
    const available = salable.get(variant.id) ?? 0;
    let issue: LineIssue | null = null;
    if (product.status !== "active" || !listing?.isPublished || !variant.isActive) issue = { code: "UNAVAILABLE", message: `${name} is no longer available` };
    else if (!price) issue = { code: "NO_PRICE", message: `${name} has no price in ${cart.currency}` };
    else if (!isAvailable(variant, available, 1)) issue = { code: "OUT_OF_STOCK", message: `${name} is out of stock` };
    else if (!isAvailable(variant, available, line.quantity)) issue = { code: "INSUFFICIENT_STOCK", message: `Only ${available} of ${name} available` };
    quoteLines.push({ line, variant, product, name, unitPrice: price?.amount ?? null, compareAtUnitPrice: price?.compareAtAmount ?? null, totals: null, salableQuantity: available, issue });
    if (issue?.code === "UNAVAILABLE" || issue?.code === "NO_PRICE") continue;
    const categoryIds = new Set<string>();
    for (const id of categoryIdsByProduct.get(product.id) ?? []) for (const a of ancestorIdsFromPath(categoryRows.get(id)?.path ?? "")) categoryIds.add(a);
    totalsLines.push({
      id: line.id,
      variantId: variant.id,
      productId: product.id,
      sku: variant.sku,
      quantity: line.quantity,
      unitPrice: price!.amount,
      subtotal: price!.amount * line.quantity,
      categoryIds: [...categoryIds],
      attributes: { ...product.attributes, ...variant.attributes },
      taxClassId: product.taxClassId ?? types.get(product.productTypeId)?.taxClassId ?? null,
      isShippable: types.get(product.productTypeId)?.isShippable ?? true,
      weightGrams: (variant.weightGrams ?? 0) * line.quantity,
    });
  }

  const requiresShipping = totalsLines.some((l) => l.isShippable);
  const shippable = totalsLines.filter((l) => l.isShippable);
  const totalWeightGrams = shippable.reduce((s, l) => s + l.weightGrams, 0);
  const totalQuantity = totalsLines.reduce((s, l) => s + l.quantity, 0);
  const billingAddress = cart.billingAddress ?? cart.shippingAddress;
  // Tax goes by where the order goes, as far as the address is known.
  const address = requiresShipping ? cart.shippingAddress : billingAddress;
  const destination = address ? { countryCode: address.countryCode, regionCode: address.regionCode ?? null, postalCode: address.postalCode ?? null } : null;

  const { rules, invalidCoupons } = await loadApplicableRules(db, {
    channelId: channel.id,
    customerGroupId: pricing.groupId,
    customerId: cart.customerId,
    couponCodes: cart.couponCodes,
    at,
  });

  // Rates depend on the discounted subtotal, so discount once before pricing shipping.
  const preliminary = applyPromotions({ currency: cart.currency, lines: totalsLines, customerGroupId: pricing.groupId, shippingCountry: destination?.countryCode ?? null }, rules);
  const discountedSubtotal = totalsLines.reduce((s, l) => s + l.subtotal - (preliminary.lineDiscounts.get(l.id) ?? 0), 0);
  // Rates need at least a country and postal code; carriers need the whole address.
  const misses: LiveRateRequest[] = [];
  const shippingRates = requiresShipping && cart.shippingAddress?.postalCode
    ? await listShippingRates(db, {
        channelId: channel.id,
        locale: cart.locale,
        currency: cart.currency,
        subtotal: discountedSubtotal,
        weightGrams: totalWeightGrams,
        quantity: shippable.reduce((s, l) => s + l.quantity, 0),
        destination: cart.shippingAddress,
        lines: shippable.map((l) => {
          const { name, variant } = quoteLines.find((q) => q.line.id === l.id)!;
          return { sku: l.sku, name, quantity: l.quantity, weightGrams: variant.weightGrams ?? 0, unitPrice: l.unitPrice };
        }),
      }, { ...providers, misses })
    : [];
  providers.misses?.push(...misses);
  // A choice is never swapped for another rate. Without one, the cheapest, unless the cache lacked
  // some carriers' rates: that might not be the rate the shopper saw.
  const selectedShippingRate = cart.shippingMethodCode
    ? (shippingRates.find((r) => r.code === cart.shippingMethodCode) ?? null)
    : misses.length ? null : cheapest(shippingRates);

  const totals = calculateTotals({
    currency: cart.currency,
    pricesIncludeTax: channel.pricesIncludeTax,
    lines: totalsLines,
    customerGroupId: pricing.groupId,
    customerTaxClassId: pricing.taxClassId,
    destination,
    rules,
    // Shipping promotions name methods, and a provider's method can offer several rates.
    shipping: selectedShippingRate && { ...selectedShippingRate, code: selectedShippingRate.details?.method ?? selectedShippingRate.code },
    shippingTaxClassId: channel.shippingTaxClassId,
    tax: await loadTaxTables(db),
  });
  for (const ql of quoteLines) ql.totals = totals.lines.find((t) => t.id === ql.line.id) ?? null;

  const paymentMethods = await listAvailablePaymentMethods(db, {
    channelId: channel.id,
    countryCode: billingAddress?.countryCode ?? null,
    currency: cart.currency,
    grandTotal: totals.grandTotal,
    locale: cart.locale,
  }, providers.payments);

  // Applied when its conditions hold, even at zero discount (e.g. free shipping on a free method).
  const appliedCodes = new Set(
    [...totals.promotions.applied.map((a) => a.couponCode), ...totals.promotions.shippingDiscounts.map((s) => s.couponCode)].filter(Boolean),
  );
  const coupons = cart.couponCodes.map((code) => {
    const invalid = invalidCoupons.find((c) => c.code === code);
    return { code, applied: appliedCodes.has(code), reason: invalid?.reason ?? (appliedCodes.has(code) ? null : "the cart does not meet the promotion's conditions") };
  });

  const missing: string[] = [];
  const missingFields: FieldError[] = [];
  const need = (requirement: string, errors: FieldError[]) => {
    missing.push(requirement);
    missingFields.push(...errors);
  };
  const addressErrors = (field: string, draft: AddressDraft | null) =>
    draft ? missingAddressFields(draft).map((f) => ({ path: [field, "address", f], message: "Required" })) : [{ path: [field], message: "Required" }];
  if (quoteLines.length === 0) need("lines", [{ path: ["lines"], message: "The cart is empty" }]);
  if (quoteLines.some((l) => l.issue)) need("line_issues", quoteLines.flatMap((l) => (l.issue ? [{ path: ["lines"], message: l.issue.message }] : [])));
  if (!cart.email) need("email", [{ path: ["email"], message: "Required" }]);
  if (requiresShipping && !completeAddress(cart.shippingAddress)) need("shipping_address", addressErrors("shippingAddress", cart.shippingAddress));
  if (requiresShipping && !selectedShippingRate) {
    // An incomplete address already says what is missing.
    const message = shippingRates.length ? "Choose a shipping method" : "No shipping method is available for this address";
    need("shipping_method", completeAddress(cart.shippingAddress) ? [{ path: ["shippingMethodCode"], message }] : []);
  }
  // A billing address that follows an incomplete shipping address is reported there.
  if (!completeAddress(billingAddress) && (cart.billingAddress || !requiresShipping)) need("billing_address", addressErrors("billingAddress", cart.billingAddress ?? billingAddress));
  if (!cart.paymentMethodCode) need("payment_method", [{ path: ["paymentMethodCode"], message: "Required" }]);
  else if (!paymentMethods.some((m) => m.code === cart.paymentMethodCode)) need("payment_method", [{ path: ["paymentMethodCode"], message: "Not available for this cart" }]);

  return {
    cart,
    channel,
    customerGroupId: pricing.groupId,
    lines: quoteLines,
    totals,
    requiresShipping,
    totalQuantity,
    totalWeightGrams,
    shippingRates,
    selectedShippingRate,
    billingAddress,
    paymentMethods,
    coupons,
    missing,
    missingFields,
  };
};
