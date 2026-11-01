import { CartNotReadyError, CouponNotApplicableError, InsufficientStockError, InvalidStateError, PaymentDeclinedError, ValidationError } from "../../lib/errors.ts";
import { parseGlobalId, toGlobalId } from "../../lib/ids.ts";
import { quoteProviders, type Quote } from "../../modules/carts/quote.ts";
import {
  addCartLines,
  applyCartCoupon,
  assignCartToCustomer,
  createCart,
  getCartForActor,
  removeCartCoupon,
  removeCartLines,
  setCartBillingAddress,
  setCartEmail,
  setCartPaymentMethod,
  setCartShippingAddress,
  setCartShippingMethod,
  updateCart,
  updateCartLines,
  type Cart,
  type CartUpdate,
} from "../../modules/carts/service.ts";
import { createCartPaymentSession, placeOrder, type CartPaymentSessionResult } from "../../modules/checkout/service.ts";
import type { AvailablePaymentMethod } from "../../modules/payments/service.ts";
import type { ShippingRate } from "../../modules/shipping/service.ts";
import { BOTH, builder, rawId, STOREFRONT } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { AddressRef, CartLineRef, CartRef, CustomerAddressRef, CustomerRef, MoneyRef, OrderRef, ProductRef, ProductVariantRef, type MoneyShape } from "../refs.ts";
import { AddressInput, CartRequirement, money } from "./common.ts";

const actorOf = (ctx: GraphQLContext) => ({ customerId: ctx.customer?.id ?? null });
const quoteOf = (ctx: GraphQLContext, cart: Cart): Promise<Quote> => ctx.loaders.quote.load(cart.id);
const m = (amount: number, cart: Cart): MoneyShape => money(amount, cart.currency);

// ---------------------------------------------------------------- types

export const ShippingRateRef = builder.objectRef<ShippingRate & { currency: string }>("ShippingRate").implement({
  subGraphs: BOTH,
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    carrier: t.exposeString("carrier"),
    price: t.field({ type: MoneyRef, resolve: (r) => money(r.amount, r.currency) }),
    minDeliveryDays: t.exposeInt("minDeliveryDays", { nullable: true }),
    maxDeliveryDays: t.exposeInt("maxDeliveryDays", { nullable: true }),
  }),
});

export const PaymentMethodOptionRef = builder.objectRef<AvailablePaymentMethod>("PaymentMethodOption").implement({
  subGraphs: BOTH,
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    instructions: t.exposeString("instructions", { nullable: true }),
    provider: t.exposeString("provider", { description: "The payment provider behind the method, e.g. stripe, offline." }),
    sessionRequired: t.exposeBoolean("sessionRequired", { description: "Start a payment session (cartPaymentSessionCreate) and confirm the payment in the browser before placing the order." }),
  }),
});

const CartPaymentSessionRef = builder.objectRef<CartPaymentSessionResult>("CartPaymentSession").implement({
  subGraphs: STOREFRONT,
  description: "The payment the cart's provider prepared for its current total, for the provider's own payment form in the browser.",
  fields: (t) => ({
    provider: t.exposeString("provider"),
    methodCode: t.exposeString("methodCode"),
    amount: t.field({ type: MoneyRef, resolve: (s) => money(s.amount, s.currency) }),
    clientData: t.field({ type: "JSON", description: "Provider data for the browser, e.g. Stripe's { clientSecret, publishableKey }.", resolve: (s) => s.clientData }),
  }),
});

export const TaxLineRef = builder.objectRef<{ name: string; rate: number; amount: MoneyShape }>("TaxLine").implement({
  fields: (t) => ({ name: t.exposeString("name"), rate: t.exposeFloat("rate", { description: "Percent." }), amount: t.field({ type: MoneyRef, resolve: (x) => x.amount }) }),
});

export const AppliedDiscountRef = builder.objectRef<{ name: string; couponCode: string | null; amount: MoneyShape }>("AppliedDiscount").implement({
  fields: (t) => ({ name: t.exposeString("name"), couponCode: t.exposeString("couponCode", { nullable: true }), amount: t.field({ type: MoneyRef, resolve: (x) => x.amount }) }),
});

export const CartCouponRef = builder.objectRef<{ code: string; applied: boolean; reason: string | null }>("CartCoupon").implement({
  subGraphs: BOTH,
  fields: (t) => ({
    code: t.exposeString("code"),
    applied: t.exposeBoolean("applied"),
    reason: t.exposeString("reason", { nullable: true, description: "Why the coupon currently gives no discount." }),
  }),
});

const CartCostRef = builder.objectRef<Quote>("CartCost").implement({
  subGraphs: STOREFRONT,
  description: "Totals from the pricing pipeline: subtotal → discounts → shipping → shipping discount → tax → total.",
  fields: (t) => ({
    subtotal: t.field({ type: MoneyRef, resolve: (q) => m(q.totals.subtotal, q.cart) }),
    discountTotal: t.field({ type: MoneyRef, description: "Line discounts plus shipping discount.", resolve: (q) => m(q.totals.discountTotal + q.totals.shippingDiscount, q.cart) }),
    shipping: t.field({ type: MoneyRef, description: "After shipping discounts.", resolve: (q) => m(q.totals.shippingTotal, q.cart) }),
    shippingDiscount: t.field({ type: MoneyRef, resolve: (q) => m(q.totals.shippingDiscount, q.cart) }),
    tax: t.field({ type: MoneyRef, resolve: (q) => m(q.totals.taxTotal, q.cart) }),
    total: t.field({ type: MoneyRef, resolve: (q) => m(q.totals.grandTotal, q.cart) }),
    pricesIncludeTax: t.boolean({ resolve: (q) => q.channel.pricesIncludeTax }),
    taxLines: t.field({ type: [TaxLineRef], resolve: (q) => q.totals.taxLines.map((x) => ({ ...x, amount: m(x.amount, q.cart) })) }),
  }),
});

const CartLineIssueCode = builder.enumType("CartLineIssueCode", {
  subGraphs: BOTH,
  values: { UNAVAILABLE: {}, OUT_OF_STOCK: {}, INSUFFICIENT_STOCK: {}, NO_PRICE: {} } as const,
});
export const CartLineIssueRef = builder.objectRef<{ code: "UNAVAILABLE" | "OUT_OF_STOCK" | "INSUFFICIENT_STOCK" | "NO_PRICE"; message: string }>("CartLineIssue").implement({
  subGraphs: BOTH,
  fields: (t) => ({ code: t.field({ type: CartLineIssueCode, resolve: (i) => i.code }), message: t.exposeString("message") }),
});

CartLineRef.implement({
  subGraphs: STOREFRONT,
  fields: (t) => ({
    id: t.id({ resolve: (l) => toGlobalId("CartLine", l.line.id) }),
    quantity: t.int({ resolve: (l) => l.line.quantity }),
    name: t.exposeString("name"),
    variant: t.field({ type: ProductVariantRef, resolve: (l) => l.variant }),
    product: t.field({ type: ProductRef, resolve: (l) => l.product }),
    unitPrice: t.field({ type: MoneyRef, nullable: true, resolve: (l) => (l.unitPrice === null ? null : money(l.unitPrice, l.currency)) }),
    compareAtUnitPrice: t.field({ type: MoneyRef, nullable: true, resolve: (l) => (l.compareAtUnitPrice === null ? null : money(l.compareAtUnitPrice, l.currency)) }),
    subtotal: t.field({ type: MoneyRef, nullable: true, resolve: (l) => (l.totals ? money(l.totals.subtotal, l.currency) : null) }),
    discount: t.field({ type: MoneyRef, nullable: true, resolve: (l) => (l.totals ? money(l.totals.discount, l.currency) : null) }),
    tax: t.field({ type: MoneyRef, nullable: true, resolve: (l) => (l.totals ? money(l.totals.tax, l.currency) : null) }),
    total: t.field({ type: MoneyRef, nullable: true, resolve: (l) => (l.totals ? money(l.totals.total, l.currency) : null) }),
    quantityAvailable: t.int({ nullable: true, resolve: (l) => (l.variant.trackInventory ? Math.max(0, l.salableQuantity) : null) }),
    issue: t.field({ type: CartLineIssueRef, nullable: true, resolve: (l) => l.issue }),
  }),
});

builder.node(CartRef, {
  subGraphs: STOREFRONT,
  description: "Guest carts are addressed by their unguessable id; a customer's cart is visible only to that customer.",
  id: { resolve: (c) => c.id },
  loadMany: (ids, ctx) => Promise.all(ids.map((id) => getCartForActor(ctx.db, id, actorOf(ctx)).catch(() => null))),
  fields: (t) => ({
    email: t.field({ type: "EmailAddress", nullable: true, resolve: (c) => c.email }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (c) => c.currency }),
    locale: t.field({ type: "LocaleCode", resolve: (c) => c.locale }),
    isOpen: t.boolean({ description: "False once the cart became an order.", resolve: (c) => c.status === "active" }),
    lines: t.field({
      type: [CartLineRef],
      complexity: { field: 1, multiplier: 10 },
      resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).lines.map((line) => ({ ...line, currency: c.currency })),
    }),
    totalQuantity: t.int({ resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).totalQuantity }),
    cost: t.field({ type: CartCostRef, resolve: (c, _a, ctx) => quoteOf(ctx, c) }),
    discounts: t.field({ type: [AppliedDiscountRef], resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).totals.discounts.map((d) => ({ name: d.name, couponCode: d.couponCode, amount: m(d.amount, c) })) }),
    coupons: t.field({ type: [CartCouponRef], resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).coupons }),
    requiresShipping: t.boolean({ resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).requiresShipping }),
    shippingAddress: t.field({ type: AddressRef, nullable: true, description: "As far as it is filled in.", resolve: (c) => c.shippingAddress }),
    billingAddress: t.field({
      type: AddressRef,
      nullable: true,
      description: "The cart's own billing address, or else the shipping address (billingSameAsShipping). As far as it is filled in.",
      resolve: (c) => c.billingAddress ?? c.shippingAddress,
    }),
    billingSameAsShipping: t.boolean({ description: "True while the cart has no billing address of its own and bills to the shipping address, the default.", resolve: (c) => !c.billingAddress }),
    availableShippingMethods: t.field({
      type: [ShippingRateRef],
      description: "Rates for the current contents, once the shipping address has a country and postal code. Carriers' rates need the whole address.",
      resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).shippingRates.map((r) => ({ ...r, currency: c.currency })),
    }),
    selectedShippingMethod: t.field({
      type: ShippingRateRef,
      nullable: true,
      description: "The shopper's choice while it is available, else the cheapest rate.",
      resolve: async (c, _a, ctx) => {
        const rate = (await quoteOf(ctx, c)).selectedShippingRate;
        return rate ? { ...rate, currency: c.currency } : null;
      },
    }),
    availablePaymentMethods: t.field({ type: [PaymentMethodOptionRef], resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).paymentMethods }),
    selectedPaymentMethod: t.field({
      type: PaymentMethodOptionRef,
      nullable: true,
      resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).paymentMethods.find((p) => p.code === c.paymentMethodCode) ?? null,
    }),
    missing: t.field({
      type: [CartRequirement],
      description: "Empty when the cart can be checked out.",
      resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).missing as (typeof CartRequirement.$inferType)[],
    }),
    checkoutReady: t.boolean({ resolve: async (c, _a, ctx) => (await quoteOf(ctx, c)).missing.length === 0 }),
    customer: t.field({ type: CustomerRef, nullable: true, resolve: (c, _a, ctx) => (c.customerId && c.customerId === ctx.customer?.id ? ctx.customer : null) }),
    order: t.field({ type: OrderRef, nullable: true, resolve: (c, _a, ctx) => (c.convertedOrderId ? ctx.loaders.order.load(c.convertedOrderId) : null) }),
    version: t.exposeInt("version", { description: "Increments on every change." }),
    createdAt: t.field({ type: "DateTime", resolve: (c) => c.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (c) => c.updatedAt }),
  }),
});

builder.queryField("cart", (t) =>
  t.field({
    type: CartRef,
    nullable: true,
    subGraphs: STOREFRONT,
    args: { id: t.arg.globalID({ for: [CartRef], required: true }) },
    resolve: (_r, { id }, ctx) => getCartForActor(ctx.db, rawId(id), actorOf(ctx)).catch(() => null),
  }),
);

// ---------------------------------------------------------------- inputs and payloads

const CartLineInput = builder.inputType("CartLineInput", {
  subGraphs: STOREFRONT,
  description: "One product variant, by id or SKU. Works the same for every product type.",
  fields: (t) => ({ variantId: t.globalID({ for: [ProductVariantRef] }), sku: t.string(), quantity: t.int({ required: true }) }),
});
const CartLineUpdateInput = builder.inputType("CartLineUpdateInput", {
  subGraphs: STOREFRONT,
  fields: (t) => ({ lineId: t.id({ required: true }), quantity: t.int({ required: true, description: "0 removes the line." }) }),
});
const CartCreateInput = builder.inputType("CartCreateInput", {
  subGraphs: STOREFRONT,
  fields: (t) => ({ email: t.field({ type: "EmailAddress" }), lines: t.field({ type: [CartLineInput] }) }),
});
const CartAddressInput = builder.inputType("CartAddressInput", {
  subGraphs: STOREFRONT,
  isOneOf: true,
  description: "Exactly one: an address, or a saved address of the signed-in customer.",
  fields: (t) => ({ address: t.field({ type: AddressInput }), customerAddressId: t.globalID({ for: [CustomerAddressRef] }) }),
});
const CartBillingAddressInput = builder.inputType("CartBillingAddressInput", {
  subGraphs: STOREFRONT,
  isOneOf: true,
  fields: (t) => ({ address: t.field({ type: AddressInput }), customerAddressId: t.globalID({ for: [CustomerAddressRef] }), sameAsShipping: t.boolean() }),
});
const AddressDraftInput = builder.inputType("AddressDraftInput", {
  subGraphs: STOREFRONT,
  description: "An address as far as it is filled in: the country, and any of the rest. Blank fields are left out.",
  fields: (t) => ({
    firstName: t.string(),
    lastName: t.string(),
    company: t.string(),
    line1: t.string(),
    line2: t.string(),
    city: t.string(),
    region: t.string(),
    regionCode: t.string(),
    postalCode: t.string(),
    countryCode: t.field({ type: "CountryCode", required: true }),
    phone: t.string(),
  }),
});
const CartUpdateAddressInput = builder.inputType("CartUpdateAddressInput", {
  subGraphs: STOREFRONT,
  isOneOf: true,
  description: "Exactly one: an address, complete or not, or a saved address of the signed-in customer.",
  fields: (t) => ({ address: t.field({ type: AddressDraftInput }), customerAddressId: t.globalID({ for: [CustomerAddressRef] }) }),
});
const CartUpdateBillingAddressInput = builder.inputType("CartUpdateBillingAddressInput", {
  subGraphs: STOREFRONT,
  isOneOf: true,
  description: "Exactly one: an address, complete or not, a saved address of the signed-in customer, or sameAsShipping: true to bill to the shipping address.",
  fields: (t) => ({ address: t.field({ type: AddressDraftInput }), customerAddressId: t.globalID({ for: [CustomerAddressRef] }), sameAsShipping: t.boolean() }),
});
const CartUpdateInput = builder.inputType("CartUpdateInput", {
  subGraphs: STOREFRONT,
  description: "Checkout details to set, in any combination. Omitted fields stay as they are; null clears one.",
  fields: (t) => ({
    email: t.field({ type: "EmailAddress" }),
    shippingAddress: t.field({ type: CartUpdateAddressInput }),
    billingAddress: t.field({ type: CartUpdateBillingAddressInput }),
    shippingMethodCode: t.string({ description: "A code from availableShippingMethods. Null goes back to the cheapest rate." }),
    paymentMethodCode: t.string({ description: "A code from availablePaymentMethods." }),
    currencyCode: t.field({
      type: "CurrencyCode",
      description: "Switch to another of the channel's currencies (Channel.currencies). Prices, shipping and tax follow; a chosen shipping or payment method no longer offered is dropped.",
    }),
    locale: t.field({ type: "LocaleCode", description: "Move the cart to another of its channel's languages (Channel.locales): line names, and the emails for its order." }),
  }),
});
const PaymentDataInput = builder.inputType("PaymentDataInput", {
  subGraphs: STOREFRONT,
  description: "Provider-specific payment data, e.g. a tokenized card from the PSP's client SDK. Never raw card numbers.",
  fields: (t) => ({ token: t.string() }),
});

const CartPayload = builder.simpleObject("CartPayload", { subGraphs: STOREFRONT, fields: (t) => ({ cart: t.field({ type: CartRef }) }) });
const CheckoutPayload = builder.simpleObject("CheckoutPayload", { subGraphs: STOREFRONT, fields: (t) => ({ order: t.field({ type: OrderRef }) }) });
const CartPaymentSessionPayload = builder.simpleObject("CartPaymentSessionPayload", { subGraphs: STOREFRONT, fields: (t) => ({ session: t.field({ type: CartPaymentSessionRef }) }) });

const lineId = (gid: string) => {
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.type !== "CartLine") throw new ValidationError("Invalid line id", [{ path: ["lines", "lineId"], message: `Expected a CartLine id, got ${gid}` }]);
  return parsed.id;
};

const toLines = (lines: { variantId?: { id: string } | null; sku?: string | null; quantity: number }[]) =>
  lines.map((l) => ({ ...(l.variantId ? { variantId: rawId(l.variantId) } : {}), ...(l.sku ? { sku: l.sku } : {}), quantity: l.quantity }));

type AddressChoice = { address?: object | null; customerAddressId?: { id: string } | null };
const toAddressChoice = (input: AddressChoice) => ({ address: input.address ?? undefined, customerAddressId: input.customerAddressId ? rawId(input.customerAddressId) : null });

/** cartUpdate's input as the service takes it: undefined leaves a detail as it is, null clears it. */
const toCartUpdate = (input: typeof CartUpdateInput.$inferInput): CartUpdate => ({
  email: input.email,
  shippingAddress: input.shippingAddress && toAddressChoice(input.shippingAddress),
  billingAddress: input.billingAddress && { ...toAddressChoice(input.billingAddress), sameAsShipping: input.billingAddress.sameAsShipping },
  shippingMethodCode: input.shippingMethodCode,
  paymentMethodCode: input.paymentMethodCode,
  currencyCode: input.currencyCode,
  locale: input.locale,
});

/** Drops the cached quote, so the payload shows the change. */
const cartMutation = async (ctx: GraphQLContext, work: Promise<Cart>) => {
  const cart = await work;
  ctx.loaders.quote.clear(cart.id);
  return { cart };
};

builder.mutationFields((t) => ({
  cartCreate: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    description: "Create a cart in the request's channel and currency; signed-in customers own it.",
    errors: { types: [InsufficientStockError] },
    args: { input: t.arg({ type: CartCreateInput }) },
    resolve: (_r, { input }, ctx) => cartMutation(ctx, createCart(ctx.db, ctx.scope, actorOf(ctx), { email: input?.email, lines: toLines(input?.lines ?? []) })),
  }),
  cartLinesAdd: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    description: "Add variants; quantities add up for variants already in the cart. Checked against salable stock.",
    errors: { types: [InsufficientStockError, InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), lines: t.arg({ type: [CartLineInput], required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, addCartLines(ctx.db, rawId(args.cartId), toLines(args.lines), actorOf(ctx))),
  }),
  cartLinesUpdate: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    errors: { types: [InsufficientStockError, InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), lines: t.arg({ type: [CartLineUpdateInput], required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, updateCartLines(ctx.db, rawId(args.cartId), args.lines.map((l) => ({ lineId: lineId(l.lineId), quantity: l.quantity })), actorOf(ctx))),
  }),
  cartLinesRemove: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), lineIds: t.arg.idList({ required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, removeCartLines(ctx.db, rawId(args.cartId), args.lineIds.map((id) => lineId(String(id))), actorOf(ctx))),
  }),
  cartUpdate: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    description:
      "Set any checkout details, in any order and as often as the shopper changes them. Addresses may be incomplete: rates and tax follow once the shipping address has a country and postal code, and checkout reports the rest (CartNotReadyError.fieldErrors). The cheapest rate is selected until the shopper picks one; billing follows shipping unless the cart has its own. Every invalid field is reported at once; nothing is saved unless all are valid.",
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), input: t.arg({ type: CartUpdateInput, required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, updateCart(ctx.db, rawId(args.cartId), toCartUpdate(args.input), actorOf(ctx), quoteProviders(ctx.platform))),
  }),
  cartEmailUpdate: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    deprecationReason: "Use cartUpdate, which sets any checkout details in one call and takes incomplete addresses.",
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), email: t.arg({ type: "EmailAddress", required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, setCartEmail(ctx.db, rawId(args.cartId), args.email, actorOf(ctx))),
  }),
  cartShippingAddressSet: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    deprecationReason: "Use cartUpdate, which sets any checkout details in one call and takes incomplete addresses.",
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), address: t.arg({ type: CartAddressInput, required: true }) },
    resolve: (_r, args, ctx) =>
      cartMutation(ctx, setCartShippingAddress(ctx.db, rawId(args.cartId), { address: args.address.address ?? undefined, customerAddressId: args.address.customerAddressId ? rawId(args.address.customerAddressId) : null }, actorOf(ctx))),
  }),
  cartBillingAddressSet: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    deprecationReason: "Use cartUpdate, which sets any checkout details in one call and takes incomplete addresses.",
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), address: t.arg({ type: CartBillingAddressInput, required: true }) },
    resolve: (_r, args, ctx) =>
      cartMutation(
        ctx,
        setCartBillingAddress(
          ctx.db,
          rawId(args.cartId),
          { address: args.address.address ?? undefined, customerAddressId: args.address.customerAddressId ? rawId(args.address.customerAddressId) : null, sameAsShipping: args.address.sameAsShipping },
          actorOf(ctx),
        ),
      ),
  }),
  cartShippingMethodSet: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    deprecationReason: "Use cartUpdate, which sets any checkout details in one call and takes incomplete addresses.",
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), shippingMethodCode: t.arg.string({ required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, setCartShippingMethod(ctx.db, rawId(args.cartId), args.shippingMethodCode, actorOf(ctx), quoteProviders(ctx.platform))),
  }),
  cartPaymentMethodSet: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    deprecationReason: "Use cartUpdate, which sets any checkout details in one call and takes incomplete addresses.",
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), paymentMethodCode: t.arg.string({ required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, setCartPaymentMethod(ctx.db, rawId(args.cartId), args.paymentMethodCode, actorOf(ctx), quoteProviders(ctx.platform))),
  }),
  cartCouponApply: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    description: "Fails with CouponNotApplicableError (and a reason) unless the coupon is valid and its promotion applies to the cart.",
    errors: { types: [CouponNotApplicableError, InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), code: t.arg.string({ required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, applyCartCoupon(ctx.db, rawId(args.cartId), args.code, actorOf(ctx), quoteProviders(ctx.platform))),
  }),
  cartCouponRemove: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }), code: t.arg.string({ required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, removeCartCoupon(ctx.db, rawId(args.cartId), args.code, actorOf(ctx))),
  }),
  cartAssignToCustomer: t.field({
    type: CartPayload,
    subGraphs: STOREFRONT,
    description: "Adopt a guest cart after sign-in, merging it into the customer's open cart if there is one.",
    authScopes: { customer: true },
    errors: { types: [InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }) },
    resolve: (_r, args, ctx) => cartMutation(ctx, assignCartToCustomer(ctx.db, rawId(args.cartId), ctx.customer!.id)),
  }),
  cartPaymentSessionCreate: t.field({
    type: CartPaymentSessionPayload,
    subGraphs: STOREFRONT,
    description:
      "Start the payment with the selected method's provider for the cart's total (e.g. a Stripe PaymentIntent) when its sessionRequired is true. Call again after the total changes to update the same payment. See docs/payments.md.",
    errors: { types: [CartNotReadyError, InvalidStateError] },
    args: { cartId: t.arg.globalID({ for: [CartRef], required: true }) },
    resolve: async (_r, args, ctx) => ({ session: await createCartPaymentSession(ctx.platform, rawId(args.cartId), actorOf(ctx)) }),
  }),
  checkoutPlaceOrder: t.field({
    type: CheckoutPayload,
    subGraphs: STOREFRONT,
    description:
      "Turn a ready cart into an order: re-price, reserve stock, authorize payment. `input` is saved first, as cartUpdate saves it, so one call can do everything. Retries return the same order: with the same idempotencyKey, or any key once the cart is an order. A declined payment releases stock and reopens the cart. With a payment session, confirm the payment in the browser first and pass an empty payment.",
    errors: { types: [CartNotReadyError, InsufficientStockError, PaymentDeclinedError, InvalidStateError] },
    args: {
      cartId: t.arg.globalID({ for: [CartRef], required: true }),
      idempotencyKey: t.arg.string({ required: true, description: "Client-generated, e.g. a UUID per checkout attempt." }),
      input: t.arg({ type: CartUpdateInput, description: "Checkout details to save before placing the order." }),
      payment: t.arg({ type: PaymentDataInput }),
    },
    resolve: async (_r, args, ctx) => {
      if (args.idempotencyKey.length < 8 || args.idempotencyKey.length > 200) {
        throw new ValidationError("Invalid idempotency key", [{ path: ["idempotencyKey"], message: "Use 8–200 characters" }]);
      }
      const order = await placeOrder(
        ctx.platform,
        { cartId: rawId(args.cartId), idempotencyKey: args.idempotencyKey, paymentData: args.payment ? { ...args.payment } : null, details: args.input ? toCartUpdate(args.input) : null },
        actorOf(ctx),
      );
      ctx.loaders.quote.clear(rawId(args.cartId));
      return { order };
    },
  }),
}));
