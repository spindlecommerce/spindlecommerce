import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { addressDraftSchema, addressSchema, type Address, type AddressDraft } from "../../lib/address.ts";
import { CouponNotApplicableError, InsufficientStockError, InvalidStateError, NotFoundError, ValidationError, type FieldError } from "../../lib/errors.ts";
import { parseInput } from "../../lib/validation.ts";
import { getListingsByProductIds, getProductsByIds, getVariantsByIds, getVariantsBySkus } from "../catalog/read.ts";
import { getChannel, type ResolvedScope } from "../channels/service.ts";
import { addressToSnapshot, getAddress } from "../customers/service.ts";
import { getSalableQuantities, isAvailable } from "../inventory/stock.ts";
import { withoutAvailabilityChecks } from "../payments/providers.ts";
import { checkCoupon } from "../promotions/service.ts";
import { buildQuote, resolveCustomerPricingGroup, type Cart, type QuoteProviders } from "./quote.ts";
import { cartLines, carts } from "./tables.ts";

export type { Cart, CartLine } from "./quote.ts";

export type CartActor = { customerId: string | null };

const MAX_LINE_QUANTITY = 10_000;
const MAX_LINES = 250;

const lineInputSchema = z
  .object({ variantId: z.uuid().optional(), sku: z.string().min(1).optional(), quantity: z.number().int().positive().max(MAX_LINE_QUANTITY) })
  .refine((l) => !!l.variantId !== !!l.sku, { message: "Give exactly one of variantId or sku" });

export const createCart = async (
  db: Database,
  scope: ResolvedScope,
  actor: CartActor,
  input: { email?: string | null; lines?: z.input<typeof lineInputSchema>[] } = {},
): Promise<Cart> =>
  db.transaction(async (tx) => {
    const email = input.email ? parseInput(z.email(), input.email, ["input", "email"]).toLowerCase() : null;
    const customerEmail = actor.customerId ? (await tx.query.customers.findFirst({ where: (c, { eq: e }) => e(c.id, actor.customerId!) }))?.email ?? null : null;
    const [cart] = await tx
      .insert(carts)
      .values({
        channelId: scope.channel.id,
        customerId: actor.customerId,
        currency: scope.currency,
        locale: scope.locale,
        email: email ?? customerEmail,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      })
      .returning();
    if (input.lines?.length) return addCartLines(tx, cart!, input.lines);
    return cart!;
  });

/** A customer's cart is invisible to everyone else: it reports as not found. */
export const getCartForActor = async (db: Database, cartId: string, actor: CartActor): Promise<Cart> => {
  const cart = await db.query.carts.findFirst({ where: eq(carts.id, cartId) });
  if (!cart || (cart.customerId && cart.customerId !== actor.customerId)) throw new NotFoundError("Cart", cartId);
  return cart;
};

const mutableCart = async (db: Database, cartId: string, actor: CartActor) => {
  const cart = await getCartForActor(db, cartId, actor);
  if (cart.status !== "active") throw new InvalidStateError(`The cart is ${cart.status}`);
  return cart;
};

const touch = async (db: Database, cartId: string, patch: Partial<typeof carts.$inferInsert> = {}) => {
  const [row] = await db
    .update(carts)
    .set({ ...patch, version: sql`${carts.version} + 1`, updatedAt: new Date() })
    .where(eq(carts.id, cartId))
    .returning();
  return row!;
};

const sellableVariants = async (db: Database, cart: Cart, lines: z.output<typeof lineInputSchema>[]) => {
  const byId = new Map((await getVariantsByIds(db, lines.flatMap((l) => (l.variantId ? [l.variantId] : []))).then((r) => r.map((v) => [v.id, v] as const))));
  const bySku = new Map((await getVariantsBySkus(db, lines.flatMap((l) => (l.sku ? [l.sku] : []))).then((r) => r.map((v) => [v.sku, v] as const))));
  const resolved = lines.map((l) => (l.variantId ? byId.get(l.variantId) : bySku.get(l.sku!)));
  const productIds = [...new Set(resolved.flatMap((v) => (v ? [v.productId] : [])))];
  const productRows = await getProductsByIds(db, productIds);
  const listings = await getListingsByProductIds(db, productIds);
  const errors = resolved.flatMap((variant, i) => {
    const product = variant && productRows.find((p) => p.id === variant.productId);
    const listing = product && listings.get(product.id)?.find((l) => l.channelId === cart.channelId);
    if (!variant) return [{ path: ["lines", String(i)], message: `No product variant ${lines[i]!.variantId ?? lines[i]!.sku}` }];
    if (!product || product.status !== "active" || !listing?.isPublished || !variant.isActive) return [{ path: ["lines", String(i)], message: `${variant.sku} is not for sale here` }];
    return [];
  });
  if (errors.length) throw new ValidationError("Some lines cannot be added", errors);
  return resolved.map((v) => v!);
};

const assertStock = async (db: Database, cart: Cart, wanted: Map<string, { quantity: number; sku: string; trackInventory: boolean; allowBackorder: boolean }>) => {
  const channel = await getChannel(db, cart.channelId);
  const salable = await getSalableQuantities(db, channel.stockId, [...wanted.keys()]);
  for (const [variantId, w] of wanted) {
    const available = salable.get(variantId) ?? 0;
    if (!isAvailable(w, available, w.quantity)) throw new InsufficientStockError({ variantId, sku: w.sku, requested: w.quantity, available });
  }
};

export const addCartLines = async (db: Database, cartOrId: Cart | string, input: z.input<typeof lineInputSchema>[], actor: CartActor = { customerId: null }): Promise<Cart> =>
  db.transaction(async (tx) => {
    const cart = typeof cartOrId === "string" ? await mutableCart(tx, cartOrId, actor) : cartOrId;
    const lines = input.map((l, i) => parseInput(lineInputSchema, l, ["lines", String(i)]));
    const variants = await sellableVariants(tx, cart, lines);
    const existing = await tx.select().from(cartLines).where(eq(cartLines.cartId, cart.id));
    const wanted = new Map<string, { quantity: number; sku: string; trackInventory: boolean; allowBackorder: boolean }>();
    variants.forEach((variant, i) => {
      const current = wanted.get(variant.id)?.quantity ?? existing.find((e) => e.variantId === variant.id)?.quantity ?? 0;
      wanted.set(variant.id, { quantity: current + lines[i]!.quantity, sku: variant.sku, trackInventory: variant.trackInventory, allowBackorder: variant.allowBackorder });
    });
    if (new Set([...existing.map((e) => e.variantId), ...wanted.keys()]).size > MAX_LINES) {
      throw new ValidationError("Too many lines", [{ path: ["lines"], message: `A cart holds at most ${MAX_LINES} lines` }]);
    }
    for (const w of wanted.values()) {
      if (w.quantity > MAX_LINE_QUANTITY) throw new ValidationError("Quantity too large", [{ path: ["lines"], message: `At most ${MAX_LINE_QUANTITY} of ${w.sku}` }]);
    }
    await assertStock(tx, cart, wanted);
    for (const [variantId, w] of wanted) {
      await tx
        .insert(cartLines)
        .values({ cartId: cart.id, variantId, quantity: w.quantity })
        .onConflictDoUpdate({ target: [cartLines.cartId, cartLines.variantId], set: { quantity: w.quantity, updatedAt: new Date() } });
    }
    return touch(tx, cart.id);
  });

export const updateCartLines = async (db: Database, cartId: string, input: { lineId: string; quantity: number }[], actor: CartActor): Promise<Cart> =>
  db.transaction(async (tx) => {
    const cart = await mutableCart(tx, cartId, actor);
    const updates = input.map((u, i) => parseInput(z.object({ lineId: z.uuid(), quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY) }), u, ["lines", String(i)]));
    const existing = await tx.select().from(cartLines).where(eq(cartLines.cartId, cart.id));
    const missing = updates.filter((u) => !existing.some((e) => e.id === u.lineId));
    if (missing.length) throw new NotFoundError("CartLine", missing.map((m) => m.lineId).join(", "));
    const variants = new Map((await getVariantsByIds(tx, existing.map((e) => e.variantId))).map((v) => [v.id, v]));
    const wanted = new Map<string, { quantity: number; sku: string; trackInventory: boolean; allowBackorder: boolean }>();
    for (const u of updates.filter((u) => u.quantity > 0)) {
      const line = existing.find((e) => e.id === u.lineId)!;
      const v = variants.get(line.variantId)!;
      wanted.set(v.id, { quantity: u.quantity, sku: v.sku, trackInventory: v.trackInventory, allowBackorder: v.allowBackorder });
    }
    await assertStock(tx, cart, wanted);
    for (const u of updates) {
      if (u.quantity === 0) await tx.delete(cartLines).where(eq(cartLines.id, u.lineId));
      else await tx.update(cartLines).set({ quantity: u.quantity, updatedAt: new Date() }).where(eq(cartLines.id, u.lineId));
    }
    return touch(tx, cart.id);
  });

export const removeCartLines = async (db: Database, cartId: string, lineIds: string[], actor: CartActor): Promise<Cart> =>
  db.transaction(async (tx) => {
    const cart = await mutableCart(tx, cartId, actor);
    if (lineIds.length) await tx.delete(cartLines).where(and(eq(cartLines.cartId, cart.id), inArray(cartLines.id, lineIds)));
    return touch(tx, cart.id);
  });

export const setCartEmail = async (db: Database, cartId: string, email: string, actor: CartActor) => {
  await mutableCart(db, cartId, actor);
  return touch(db, cartId, { email: parseInput(z.email(), email, ["email"]).toLowerCase() });
};

const resolveAddress = async (db: Database, actor: CartActor, input: { address?: unknown; customerAddressId?: string | null }, path: string): Promise<Address> => {
  if (input.customerAddressId) {
    if (!actor.customerId) throw new ValidationError("Sign in to use a saved address", [{ path: [path, "customerAddressId"], message: "Not signed in" }]);
    return addressToSnapshot(await getAddress(db, actor.customerId, input.customerAddressId));
  }
  if (!input.address) throw new ValidationError("An address is required", [{ path: [path, "address"], message: "Required" }]);
  return parseInput(addressSchema, input.address, [path, "address"]);
};

export const setCartShippingAddress = async (db: Database, cartId: string, input: { address?: unknown; customerAddressId?: string | null }, actor: CartActor) => {
  const cart = await mutableCart(db, cartId, actor);
  const address = await resolveAddress(db, actor, input, "input");
  const channel = await getChannel(db, cart.channelId);
  if (!channel.countries.includes(address.countryCode)) {
    throw new ValidationError("We do not ship to this country", [{ path: ["input", "address", "countryCode"], message: `${address.countryCode} is not served by this store` }]);
  }
  return touch(db, cartId, { shippingAddress: address });
};

/** `sameAsShipping` clears the billing address, so billing follows the shipping address. */
export const setCartBillingAddress = async (db: Database, cartId: string, input: { address?: unknown; customerAddressId?: string | null; sameAsShipping?: boolean | null }, actor: CartActor) => {
  await mutableCart(db, cartId, actor);
  if (input.sameAsShipping) return touch(db, cartId, { billingAddress: null });
  return touch(db, cartId, { billingAddress: await resolveAddress(db, actor, input, "input") });
};

export const setCartShippingMethod = async (db: Database, cartId: string, code: string, actor: CartActor, providers?: QuoteProviders) => {
  const cart = await mutableCart(db, cartId, actor);
  const quote = await buildQuote(db, { ...cart, shippingMethodCode: code }, providers);
  if (!quote.shippingRates.some((r) => r.code === code)) {
    const reason = cart.shippingAddress ? `Available: ${quote.shippingRates.map((r) => r.code).join(", ") || "none"}` : "Set a shipping address first";
    throw new ValidationError("This shipping method is not available for the cart", [{ path: ["shippingMethodCode"], message: reason }]);
  }
  return touch(db, cartId, { shippingMethodCode: code });
};

export const setCartPaymentMethod = async (db: Database, cartId: string, code: string, actor: CartActor, providers?: QuoteProviders) => {
  const cart = await mutableCart(db, cartId, actor);
  const quote = await buildQuote(db, cart, providers);
  if (!quote.paymentMethods.some((m) => m.code === code)) {
    throw new ValidationError("This payment method is not available for the cart", [{ path: ["paymentMethodCode"], message: `Available: ${quote.paymentMethods.map((m) => m.code).join(", ") || "none"}` }]);
  }
  return touch(db, cartId, { paymentMethodCode: code });
};

export type CartAddressDraftInput = { address?: unknown; customerAddressId?: string | null };

/**
 * Omitted fields stay; null clears one (a null shipping method falls back to the cheapest rate).
 * Addresses may be incomplete. Currency and locale must be the channel's and can't be cleared.
 */
export type CartUpdate = {
  email?: string | null;
  shippingAddress?: CartAddressDraftInput | null;
  billingAddress?: (CartAddressDraftInput & { sameAsShipping?: boolean | null }) | null;
  shippingMethodCode?: string | null;
  paymentMethodCode?: string | null;
  currencyCode?: string | null;
  locale?: string | null;
};

const resolveAddressDraft = async (db: Database, actor: CartActor, input: CartAddressDraftInput, path: string[]): Promise<AddressDraft> => {
  if (input.customerAddressId) {
    if (!actor.customerId) throw new ValidationError("Sign in to use a saved address", [{ path: [...path, "customerAddressId"], message: "Not signed in" }]);
    return addressToSnapshot(await getAddress(db, actor.customerId, input.customerAddressId));
  }
  if (!input.address) throw new ValidationError("An address is required", [{ path: [...path, "address"], message: "Required" }]);
  return parseInput(addressDraftSchema, input.address, [...path, "address"]);
};

/**
 * Incomplete addresses price shipping and tax from what is there; checkout asks for the rest.
 * Every invalid field is reported, and nothing is saved unless all are valid.
 */
export const updateCart = async (db: Database, cartId: string, input: CartUpdate, actor: CartActor, providers?: QuoteProviders): Promise<Cart> => {
  const cart = await mutableCart(db, cartId, actor);
  const patch: Partial<typeof carts.$inferInsert> = {};
  const failures: ValidationError[] = [];
  const check = async <T>(work: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      failures.push(error);
      return undefined;
    }
  };

  if (input.email !== undefined) {
    const email = input.email;
    patch.email = email === null ? null : await check(() => parseInput(z.email(), email, ["input", "email"]).toLowerCase());
  }
  const shipping = input.shippingAddress;
  if (shipping === null) patch.shippingAddress = null;
  else if (shipping) {
    patch.shippingAddress = await check(async () => {
      const address = await resolveAddressDraft(db, actor, shipping, ["input", "shippingAddress"]);
      const channel = await getChannel(db, cart.channelId);
      if (!channel.countries.includes(address.countryCode)) {
        const path = shipping.customerAddressId ? ["input", "shippingAddress", "customerAddressId"] : ["input", "shippingAddress", "address", "countryCode"];
        throw new ValidationError("We do not ship to this country", [{ path, message: `${address.countryCode} is not served by this store` }]);
      }
      return address;
    });
  }
  const billing = input.billingAddress;
  if (billing === null || billing?.sameAsShipping) patch.billingAddress = null;
  else if (billing) {
    patch.billingAddress = await check(() => {
      if (billing.sameAsShipping === false && !billing.address && !billing.customerAddressId) {
        throw new ValidationError("Give the billing address instead", [{ path: ["input", "billingAddress", "sameAsShipping"], message: "Give an address instead" }]);
      }
      return resolveAddressDraft(db, actor, billing, ["input", "billingAddress"]);
    });
  }
  if (input.shippingMethodCode !== undefined) patch.shippingMethodCode = input.shippingMethodCode;
  if (input.paymentMethodCode !== undefined) patch.paymentMethodCode = input.paymentMethodCode;

  // Prices, shipping and tax follow the currency; line names and order emails follow the locale.
  if (input.currencyCode !== undefined || input.locale !== undefined) {
    const channel = await getChannel(db, cart.channelId);
    if (input.currencyCode !== undefined) {
      patch.currency = await check(() => {
        const currency = input.currencyCode?.toUpperCase();
        if (!currency || !channel.currencies.includes(currency)) {
          throw new ValidationError("This store does not sell in that currency", [{ path: ["input", "currencyCode"], message: `Available: ${channel.currencies.join(", ")}` }]);
        }
        return currency;
      });
    }
    if (input.locale !== undefined) {
      patch.locale = await check(() => {
        const locale = input.locale;
        if (!locale || !channel.locales.includes(locale)) {
          throw new ValidationError("This store does not offer that language", [{ path: ["input", "locale"], message: `Available: ${channel.locales.join(", ")}` }]);
        }
        return locale;
      });
    }
  }

  // A previous choice the new address or currency can't use is dropped (back to the cheapest rate).
  const currencyChanged = patch.currency !== undefined && patch.currency !== cart.currency;
  const keptShippingChoice = (patch.shippingAddress !== undefined || currencyChanged) && patch.shippingMethodCode === undefined && !!cart.shippingMethodCode;
  const keptPaymentChoice = currencyChanged && patch.paymentMethodCode === undefined && !!cart.paymentMethodCode;
  if (failures.length === 0 && (patch.shippingMethodCode || patch.paymentMethodCode || keptShippingChoice || keptPaymentChoice)) {
    const quote = await buildQuote(db, { ...cart, ...patch } as Cart, providers);
    if (keptShippingChoice && !quote.shippingRates.some((r) => r.code === cart.shippingMethodCode)) patch.shippingMethodCode = null;
    if (keptPaymentChoice && !quote.paymentMethods.some((m) => m.code === cart.paymentMethodCode)) patch.paymentMethodCode = null;
    if (patch.shippingMethodCode && !quote.shippingRates.some((r) => r.code === patch.shippingMethodCode)) {
      const available = quote.shippingRates.map((r) => r.code).join(", ");
      failures.push(new ValidationError("This shipping method is not available for the cart", [{ path: ["input", "shippingMethodCode"], message: available ? `Available: ${available}` : "None yet: give the shipping address first" }]));
    }
    if (patch.paymentMethodCode && !quote.paymentMethods.some((m) => m.code === patch.paymentMethodCode)) {
      failures.push(new ValidationError("This payment method is not available for the cart", [{ path: ["input", "paymentMethodCode"], message: `Available: ${quote.paymentMethods.map((m) => m.code).join(", ") || "none"}` }]));
    }
  }
  if (failures.length === 1) throw failures[0]!;
  if (failures.length > 1) throw new ValidationError("The input is invalid", failures.flatMap((f) => f.fieldErrors));
  return touch(db, cartId, patch);
};

/** Kept only if valid now and its promotion applies to this cart. */
export const applyCartCoupon = async (db: Database, cartId: string, rawCode: string, actor: CartActor, providers?: QuoteProviders) =>
  db.transaction(async (tx) => {
    const cart = await mutableCart(tx, cartId, actor);
    const code = rawCode.trim().toUpperCase();
    if (cart.couponCodes.includes(code)) return cart;
    const pricing = await resolveCustomerPricingGroup(tx, cart.customerId);
    const check = await checkCoupon(tx, code, { channelId: cart.channelId, customerGroupId: pricing.groupId, customerId: cart.customerId, at: new Date() });
    if (!check.ok) throw new CouponNotApplicableError(code, check.reason);
    // No provider calls inside the transaction: they may be slow or use another connection.
    const quote = await buildQuote(tx, { ...cart, couponCodes: [...cart.couponCodes, code] }, providers && { ...providers, payments: withoutAvailabilityChecks(providers.payments), liveRates: false });
    const status = quote.coupons.find((c) => c.code === code);
    if (!status?.applied) throw new CouponNotApplicableError(code, status?.reason ?? "the cart does not meet the promotion's conditions");
    return touch(tx, cartId, { couponCodes: [...cart.couponCodes, code] });
  });

export const removeCartCoupon = async (db: Database, cartId: string, rawCode: string, actor: CartActor) => {
  const cart = await mutableCart(db, cartId, actor);
  const code = rawCode.trim().toUpperCase();
  return touch(db, cartId, { couponCodes: cart.couponCodes.filter((c) => c !== code) });
};

export const findActiveCustomerCart = (db: Database, customerId: string, channelId: string) =>
  db.query.carts.findFirst({
    where: and(eq(carts.customerId, customerId), eq(carts.channelId, channelId), eq(carts.status, "active")),
    orderBy: desc(carts.updatedAt),
  });

/**
 * After sign-in. Merges the guest cart into the customer's active cart in the channel (quantities
 * add up) and closes it, or makes it the customer's if there is none.
 */
export const assignCartToCustomer = async (db: Database, guestCartId: string, customerId: string): Promise<Cart> =>
  db.transaction(async (tx) => {
    const guest = await tx.query.carts.findFirst({ where: eq(carts.id, guestCartId) });
    if (!guest || (guest.customerId && guest.customerId !== customerId)) throw new NotFoundError("Cart", guestCartId);
    if (guest.status !== "active") throw new InvalidStateError(`The cart is ${guest.status}`);
    const customer = await tx.query.customers.findFirst({ where: (c, { eq: e }) => e(c.id, customerId) });
    const target = await findActiveCustomerCart(tx, customerId, guest.channelId);
    if (!target || target.id === guest.id) return touch(tx, guest.id, { customerId, email: guest.email ?? customer?.email ?? null });
    const guestLines = await tx.select().from(cartLines).where(eq(cartLines.cartId, guest.id));
    for (const line of guestLines) {
      await tx
        .insert(cartLines)
        .values({ cartId: target.id, variantId: line.variantId, quantity: line.quantity })
        .onConflictDoUpdate({ target: [cartLines.cartId, cartLines.variantId], set: { quantity: sql`${cartLines.quantity} + ${line.quantity}`, updatedAt: new Date() } });
    }
    await tx.update(carts).set({ status: "abandoned", updatedAt: new Date() }).where(eq(carts.id, guest.id));
    return touch(tx, target.id, { couponCodes: [...new Set([...target.couponCodes, ...guest.couponCodes])] });
  });
