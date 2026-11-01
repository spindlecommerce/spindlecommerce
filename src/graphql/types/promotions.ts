import { createPromotion, deleteCoupons, deletePromotion, generateCoupons, listPromotions, updatePromotion } from "../../modules/promotions/service.ts";
import type { Action, Condition, LinePredicate } from "../../modules/promotions/rules.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { ADMIN, builder, connectionComplexity, rawId } from "../builder.ts";
import { keysetConnection } from "../pagination.ts";
import { CategoryRef, ChannelRef, CouponRef, CustomerGroupRef, ProductRef, PromotionRef } from "../refs.ts";
import { DeletePayload } from "./common.ts";
import { MoneyByCurrencyInput, toAmounts } from "./settings.ts";

builder.node(PromotionRef, {
  subGraphs: ADMIN,
  id: { resolve: (p) => p.id },
  loadMany: async (ids, ctx) => (await ctx.loaders.promotion.loadMany(ids)).map((p) => (p instanceof Error ? null : p)),
  fields: (t) => ({
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    isActive: t.exposeBoolean("isActive"),
    priority: t.exposeInt("priority", { description: "Lower runs first." }),
    stopFurtherRules: t.exposeBoolean("stopFurtherRules"),
    requiresCoupon: t.exposeBoolean("requiresCoupon"),
    startsAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.startsAt }),
    endsAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.endsAt }),
    conditions: t.field({ type: "JSON", description: "Condition tree (see PromotionConditionInput).", resolve: (p) => p.conditions }),
    action: t.field({ type: "JSON", description: "Action (see PromotionActionInput). Amounts are minor units per currency.", resolve: (p) => p.action }),
    channels: t.field({ type: [ChannelRef], description: "Empty means every channel.", resolve: async (p, _a, ctx) => (await ctx.db.query.channels.findMany()).filter((c) => p.channelIds.includes(c.id)) }),
    customerGroups: t.field({ type: [CustomerGroupRef], description: "Empty means every group.", resolve: async (p, _a, ctx) => (await ctx.db.query.customerGroups.findMany()).filter((g) => p.customerGroupIds.includes(g.id)) }),
    usageLimit: t.exposeInt("usageLimit", { nullable: true }),
    usageLimitPerCustomer: t.exposeInt("usageLimitPerCustomer", { nullable: true }),
    timesUsed: t.exposeInt("timesUsed"),
    coupons: t.field({ type: [CouponRef], resolve: (p, _a, ctx) => ctx.loaders.coupons.load(p.id) }),
    createdAt: t.field({ type: "DateTime", resolve: (p) => p.createdAt }),
  }),
});

CouponRef.implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    id: t.id({ resolve: (c) => toGlobalId("Coupon", c.id) }),
    code: t.exposeString("code"),
    usageLimit: t.exposeInt("usageLimit", { nullable: true }),
    timesUsed: t.exposeInt("timesUsed"),
    expiresAt: t.field({ type: "DateTime", nullable: true, resolve: (c) => c.expiresAt }),
  }),
});

builder.queryField("promotions", (t) =>
  t.connection({
    type: PromotionRef,
    subGraphs: ADMIN,
    authScopes: { permission: "promotions:read" },
    args: { query: t.arg.string({ description: "Matches the name, or a coupon code exactly." }), isActive: t.arg.boolean() },
    complexity: connectionComplexity,
    resolve: (_r, { query, isActive, ...args }, ctx) => keysetConnection(args, (page) => listPromotions(ctx.db, page, { query, isActive })),
  }),
);

// ---------------------------------------------------------------- typed rule inputs (@oneOf)

const ComparisonOperator = builder.enumType("ComparisonOperator", {
  subGraphs: ADMIN,
  values: { GTE: { value: "gte" }, GT: { value: "gt" }, LTE: { value: "lte" }, LT: { value: "lt" }, EQ: { value: "eq" } } as const,
});

type LinePredicateArgs = {
  all?: LinePredicateArgs[] | null;
  any?: LinePredicateArgs[] | null;
  skuIn?: string[] | null;
  productIn?: { id: string }[] | null;
  categoryIn?: { id: string }[] | null;
  attributeIn?: { code: string; values: string[] } | null;
};

const LinePredicateInput = builder.inputRef<LinePredicateArgs>("LinePredicateInput").implement({
  subGraphs: ADMIN,
  isOneOf: true,
  description: "Which cart lines a condition or action looks at. Exactly one field.",
  fields: (t) => ({
    all: t.field({ type: [LinePredicateInput] }),
    any: t.field({ type: [LinePredicateInput] }),
    skuIn: t.stringList(),
    productIn: t.globalIDList({ for: [ProductRef] }),
    categoryIn: t.globalIDList({ for: [CategoryRef], description: "Matches descendants too." }),
    attributeIn: t.field({
      type: builder.inputType("AttributeInPredicateInput", { subGraphs: ADMIN, fields: (f) => ({ code: f.string({ required: true }), values: f.stringList({ required: true }) }) }),
    }),
  }),
});

const toPredicate = (input: LinePredicateArgs): LinePredicate => {
  if (input.all) return { type: "all", predicates: input.all.map(toPredicate) };
  if (input.any) return { type: "any", predicates: input.any.map(toPredicate) };
  if (input.skuIn) return { type: "sku_in", skus: input.skuIn };
  if (input.productIn) return { type: "product_in", productIds: input.productIn.map(rawId) };
  if (input.categoryIn) return { type: "category_in", categoryIds: input.categoryIn.map(rawId) };
  return { type: "attribute_in", attribute: input.attributeIn!.code, values: input.attributeIn!.values };
};

type MoneyList = { currencyCode: string; amount: string }[];
type ConditionArgs = {
  all?: ConditionArgs[] | null;
  any?: ConditionArgs[] | null;
  not?: ConditionArgs | null;
  subtotal?: { operator: "gte" | "gt" | "lte" | "lt" | "eq"; amounts: MoneyList } | null;
  totalQuantity?: { operator: "gte" | "gt" | "lte" | "lt" | "eq"; value: number } | null;
  lineMatches?: { predicate: LinePredicateArgs; minQuantity?: number | null } | null;
  shippingCountryIn?: string[] | null;
  customerGroupIn?: { id: string }[] | null;
};

const PromotionConditionInput = builder.inputRef<ConditionArgs>("PromotionConditionInput").implement({
  subGraphs: ADMIN,
  isOneOf: true,
  description: "A condition tree node. Exactly one field.",
  fields: (t) => ({
    all: t.field({ type: [PromotionConditionInput] }),
    any: t.field({ type: [PromotionConditionInput] }),
    not: t.field({ type: PromotionConditionInput }),
    subtotal: t.field({
      type: builder.inputType("SubtotalConditionInput", {
        subGraphs: ADMIN,
        fields: (f) => ({ operator: f.field({ type: ComparisonOperator, required: true }), amounts: f.field({ type: [MoneyByCurrencyInput], required: true, description: "Per currency; carts in other currencies do not match." }) }),
      }),
    }),
    totalQuantity: t.field({
      type: builder.inputType("QuantityConditionInput", { subGraphs: ADMIN, fields: (f) => ({ operator: f.field({ type: ComparisonOperator, required: true }), value: f.int({ required: true }) }) }),
    }),
    lineMatches: t.field({
      type: builder.inputType("LineMatchesConditionInput", {
        subGraphs: ADMIN,
        fields: (f) => ({ predicate: f.field({ type: LinePredicateInput, required: true }), minQuantity: f.int({ description: "Units across matching lines; default 1." }) }),
      }),
    }),
    shippingCountryIn: t.field({ type: ["CountryCode"] }),
    customerGroupIn: t.globalIDList({ for: [CustomerGroupRef] }),
  }),
});

const toCondition = (input: ConditionArgs): Condition => {
  if (input.all) return { type: "all", conditions: input.all.map(toCondition) };
  if (input.any) return { type: "any", conditions: input.any.map(toCondition) };
  if (input.not) return { type: "not", condition: toCondition(input.not) };
  if (input.subtotal) return { type: "subtotal", operator: input.subtotal.operator, amounts: toAmounts(input.subtotal.amounts) };
  if (input.totalQuantity) return { type: "total_quantity", operator: input.totalQuantity.operator, value: input.totalQuantity.value };
  if (input.lineMatches) return { type: "line_matches", predicate: toPredicate(input.lineMatches.predicate), ...(input.lineMatches.minQuantity ? { minQuantity: input.lineMatches.minQuantity } : {}) };
  if (input.shippingCountryIn) return { type: "shipping_country_in", countries: input.shippingCountryIn };
  return { type: "customer_group_in", groupIds: input.customerGroupIn!.map(rawId) };
};

type ActionArgs = {
  percentageOff?: { percent: number; target?: LinePredicateArgs | null; maxDiscount?: MoneyList | null } | null;
  fixedOffEach?: { amounts: MoneyList; target?: LinePredicateArgs | null } | null;
  fixedOffCart?: { amounts: MoneyList; target?: LinePredicateArgs | null } | null;
  buyXGetY?: { buyQuantity: number; getQuantity: number; percent?: number | null; target?: LinePredicateArgs | null } | null;
  shippingOff?: { percent?: number | null; methodCodes?: string[] | null } | null;
};

const PromotionActionInput = builder.inputRef<ActionArgs>("PromotionActionInput").implement({
  subGraphs: ADMIN,
  isOneOf: true,
  description: "What the promotion does. Exactly one field.",
  fields: (t) => ({
    percentageOff: t.field({
      type: builder.inputType("PercentageOffActionInput", {
        subGraphs: ADMIN,
        fields: (f) => ({ percent: f.float({ required: true }), target: f.field({ type: LinePredicateInput }), maxDiscount: f.field({ type: [MoneyByCurrencyInput] }) }),
      }),
    }),
    fixedOffEach: t.field({
      type: builder.inputType("FixedOffEachActionInput", { subGraphs: ADMIN, fields: (f) => ({ amounts: f.field({ type: [MoneyByCurrencyInput], required: true }), target: f.field({ type: LinePredicateInput }) }) }),
    }),
    fixedOffCart: t.field({
      type: builder.inputType("FixedOffCartActionInput", { subGraphs: ADMIN, fields: (f) => ({ amounts: f.field({ type: [MoneyByCurrencyInput], required: true }), target: f.field({ type: LinePredicateInput }) }) }),
    }),
    buyXGetY: t.field({
      type: builder.inputType("BuyXGetYActionInput", {
        subGraphs: ADMIN,
        fields: (f) => ({ buyQuantity: f.int({ required: true }), getQuantity: f.int({ required: true }), percent: f.float({ description: "Default 100 (free)." }), target: f.field({ type: LinePredicateInput }) }),
      }),
    }),
    shippingOff: t.field({
      type: builder.inputType("ShippingOffActionInput", { subGraphs: ADMIN, fields: (f) => ({ percent: f.float({ description: "Default 100 (free shipping)." }), methodCodes: f.stringList() }) }),
    }),
  }),
});

const toAction = (input: ActionArgs): Action => {
  const target = (t: LinePredicateArgs | null | undefined) => (t ? { target: toPredicate(t) } : {});
  if (input.percentageOff) return { type: "percentage_off", percent: input.percentageOff.percent, ...target(input.percentageOff.target), ...(input.percentageOff.maxDiscount ? { maxDiscountAmounts: toAmounts(input.percentageOff.maxDiscount) } : {}) };
  if (input.fixedOffEach) return { type: "fixed_off_each", amounts: toAmounts(input.fixedOffEach.amounts), ...target(input.fixedOffEach.target) };
  if (input.fixedOffCart) return { type: "fixed_off_cart", amounts: toAmounts(input.fixedOffCart.amounts), ...target(input.fixedOffCart.target) };
  if (input.buyXGetY) return { type: "buy_x_get_y", buyQuantity: input.buyXGetY.buyQuantity, getQuantity: input.buyXGetY.getQuantity, percent: input.buyXGetY.percent ?? 100, ...target(input.buyXGetY.target) };
  return { type: "shipping_off", percent: input.shippingOff?.percent ?? 100, ...(input.shippingOff?.methodCodes ? { methodCodes: input.shippingOff.methodCodes } : {}) };
};

const PromotionInput = builder.inputType("PromotionInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string({ required: true }),
    description: t.string(),
    isActive: t.boolean(),
    priority: t.int(),
    stopFurtherRules: t.boolean(),
    requiresCoupon: t.boolean(),
    couponCodes: t.stringList(),
    startsAt: t.field({ type: "DateTime" }),
    endsAt: t.field({ type: "DateTime" }),
    channelIds: t.globalIDList({ for: [ChannelRef] }),
    customerGroupIds: t.globalIDList({ for: [CustomerGroupRef] }),
    conditions: t.field({ type: PromotionConditionInput }),
    action: t.field({ type: PromotionActionInput, required: true }),
    usageLimit: t.int(),
    usageLimitPerCustomer: t.int(),
  }),
});

const PromotionUpdateInput = builder.inputType("PromotionUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string(),
    description: t.string(),
    isActive: t.boolean(),
    priority: t.int(),
    stopFurtherRules: t.boolean(),
    couponCodes: t.stringList({ description: "Added to the existing codes." }),
    startsAt: t.field({ type: "DateTime" }),
    endsAt: t.field({ type: "DateTime" }),
    channelIds: t.globalIDList({ for: [ChannelRef] }),
    customerGroupIds: t.globalIDList({ for: [CustomerGroupRef] }),
    conditions: t.field({ type: PromotionConditionInput }),
    action: t.field({ type: PromotionActionInput }),
    usageLimit: t.int(),
    usageLimitPerCustomer: t.int(),
  }),
});

type PromotionArgs = Partial<{
  name: string | null; description: string | null; isActive: boolean | null; priority: number | null; stopFurtherRules: boolean | null; requiresCoupon: boolean | null;
  couponCodes: string[] | null; startsAt: Date | null; endsAt: Date | null; channelIds: { id: string }[] | null; customerGroupIds: { id: string }[] | null;
  conditions: ConditionArgs | null; action: ActionArgs | null; usageLimit: number | null; usageLimitPerCustomer: number | null;
}>;

/** Fields an explicit null clears; for the rest, null means "unchanged". */
const CLEARABLE = new Set(["description", "startsAt", "endsAt", "usageLimit", "usageLimitPerCustomer"]);

const toPromotion = (input: PromotionArgs) =>
  Object.fromEntries(
    Object.entries({
      ...input,
      channelIds: input.channelIds?.map(rawId),
      customerGroupIds: input.customerGroupIds?.map(rawId),
      conditions: input.conditions ? toCondition(input.conditions) : undefined,
      action: input.action ? toAction(input.action) : undefined,
    }).filter(([key, v]) => v !== undefined && (v !== null || CLEARABLE.has(key))),
  );

const PromotionPayload = builder.simpleObject("PromotionPayload", { subGraphs: ADMIN, fields: (t) => ({ promotion: t.field({ type: PromotionRef }) }) });
const CouponsDeletePayload = builder.simpleObject("CouponsDeletePayload", { subGraphs: ADMIN, fields: (t) => ({ deletedIds: t.idList() }) });
const CouponsGeneratePayload = builder.simpleObject("CouponsGeneratePayload", { subGraphs: ADMIN, fields: (t) => ({ coupons: t.field({ type: [CouponRef] }) }) });
const write = { subGraphs: ADMIN, authScopes: { permission: "promotions:write" }, errors: {} } as const;

builder.mutationFields((t) => ({
  promotionCreate: t.field({
    ...write,
    type: PromotionPayload,
    args: { input: t.arg({ type: PromotionInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({ promotion: await createPromotion(ctx.db, toPromotion(input)) }),
  }),
  promotionUpdate: t.field({
    ...write,
    type: PromotionPayload,
    args: { id: t.arg.globalID({ for: [PromotionRef], required: true }), input: t.arg({ type: PromotionUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({ promotion: await updatePromotion(ctx.db, rawId(id), toPromotion(input)) }),
  }),
  promotionDelete: t.field({
    ...write,
    type: DeletePayload,
    args: { id: t.arg.globalID({ for: [PromotionRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Promotion", await deletePromotion(ctx.db, rawId(id))) }),
  }),
  couponsDelete: t.field({
    ...write,
    type: CouponsDeletePayload,
    description: "Delete coupon codes. Past orders keep the code they used.",
    args: { ids: t.arg.idList({ required: true }) },
    resolve: async (_r, { ids }, ctx) => ({ deletedIds: (await deleteCoupons(ctx.db, ids.map((id) => rawId(String(id))))).map((id) => toGlobalId("Coupon", id)) }),
  }),
  couponsGenerate: t.field({
    ...write,
    type: CouponsGeneratePayload,
    description: "Bulk-generate unique single-promotion coupon codes.",
    args: {
      promotionId: t.arg.globalID({ for: [PromotionRef], required: true }),
      quantity: t.arg.int({ required: true }),
      prefix: t.arg.string(),
      length: t.arg.int({ description: "Random part length, 6–32 (default 10)." }),
      usageLimit: t.arg.int({ description: "Uses per code." }),
      expiresAt: t.arg({ type: "DateTime" }),
    },
    resolve: async (_r, args, ctx) => ({
      coupons: await generateCoupons(ctx.db, {
        promotionId: rawId(args.promotionId),
        quantity: args.quantity,
        prefix: args.prefix,
        length: args.length ?? undefined,
        usageLimit: args.usageLimit,
        expiresAt: args.expiresAt,
      }),
    }),
  }),
}));
