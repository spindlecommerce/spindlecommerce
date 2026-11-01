import { InvalidStateError } from "../../lib/errors.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { fromDecimalString } from "../../lib/money.ts";
import {
  createTaxClass,
  createTaxRate,
  createTaxRule,
  deleteTaxClass,
  deleteTaxRate,
  deleteTaxRule,
  listTaxClasses,
  listTaxRates,
  listTaxRules,
  updateTaxClass,
  updateTaxRate,
  updateTaxRule,
} from "../../modules/tax/service.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import { TaxClassRef, TaxRateRef, TaxRuleRef } from "../refs.ts";
import { DeletePayload } from "./common.ts";

/** Tax settings. Shipping and payment methods are in shipping.ts and payments.ts. */

export const byIdFrom = <T extends { id: string }>(list: (db: never) => Promise<T[]>) => async (ids: string[], ctx: { db: unknown }) => {
  const rows = await list(ctx.db as never);
  return ids.map((id) => rows.find((r) => r.id === id) ?? null);
};

export const MoneyByCurrencyInput = builder.inputType("MoneyByCurrencyInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ currencyCode: t.field({ type: "CurrencyCode", required: true }), amount: t.field({ type: "Decimal", required: true }) }),
});
export const toAmounts = (list: { currencyCode: string; amount: string }[] | null | undefined) =>
  Object.fromEntries((list ?? []).map((m) => [m.currencyCode, fromDecimalString(m.amount, m.currencyCode)]));

// ---------------------------------------------------------------- tax

const TaxClassKind = builder.enumType("TaxClassKind", { subGraphs: ADMIN, values: { PRODUCT: { value: "product" }, CUSTOMER: { value: "customer" } } as const });

builder.node(TaxClassRef, {
  subGraphs: ADMIN,
  id: { resolve: (x) => x.id },
  loadMany: byIdFrom(listTaxClasses),
  fields: (t) => ({ code: t.exposeString("code"), name: t.exposeString("name"), kind: t.field({ type: TaxClassKind, resolve: (x) => x.kind }) }),
});

builder.node(TaxRateRef, {
  subGraphs: ADMIN,
  id: { resolve: (x) => x.id },
  loadMany: byIdFrom(listTaxRates),
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    countryCode: t.field({ type: "CountryCode", resolve: (x) => x.countryCode }),
    regionCode: t.exposeString("regionCode", { nullable: true }),
    postalCodePattern: t.exposeString("postalCodePattern", { nullable: true }),
    rate: t.float({ description: "Percent.", resolve: (x) => Number(x.rate) }),
  }),
});

builder.node(TaxRuleRef, {
  subGraphs: ADMIN,
  id: { resolve: (x) => x.id },
  loadMany: byIdFrom(listTaxRules),
  fields: (t) => ({
    name: t.exposeString("name"),
    priority: t.exposeInt("priority", { description: "Equal priorities add; higher priorities compound." }),
    productTaxClasses: t.field({ type: [TaxClassRef], resolve: async (r, _a, ctx) => (await listTaxClasses(ctx.db)).filter((c) => r.productTaxClassIds.includes(c.id)) }),
    customerTaxClasses: t.field({ type: [TaxClassRef], resolve: async (r, _a, ctx) => (await listTaxClasses(ctx.db)).filter((c) => r.customerTaxClassIds.includes(c.id)) }),
    taxRates: t.field({ type: [TaxRateRef], resolve: async (r, _a, ctx) => (await listTaxRates(ctx.db)).filter((x) => r.taxRateIds.includes(x.id)) }),
  }),
});

builder.queryFields((t) => ({
  taxClasses: t.field({ type: [TaxClassRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listTaxClasses(ctx.db) }),
  taxRates: t.field({ type: [TaxRateRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listTaxRates(ctx.db) }),
  taxRules: t.field({ type: [TaxRuleRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listTaxRules(ctx.db) }),
}));

// ---------------------------------------------------------------- inputs

const TaxClassInput = builder.inputType("TaxClassInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ code: t.string({ required: true }), name: t.string({ required: true }), kind: t.field({ type: TaxClassKind, required: true }) }),
});
const TaxRateInput = builder.inputType("TaxRateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    name: t.string({ required: true }),
    countryCode: t.field({ type: "CountryCode", required: true }),
    regionCode: t.string(),
    postalCodePattern: t.string({ description: "Glob, e.g. 9* or 10115." }),
    rate: t.float({ required: true, description: "Percent." }),
  }),
});
const TaxRateUpdateInput = builder.inputType("TaxRateUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ name: t.string(), regionCode: t.string(), postalCodePattern: t.string(), rate: t.float() }),
});
const TaxRuleInput = builder.inputType("TaxRuleInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string({ required: true }),
    priority: t.int(),
    productTaxClassIds: t.globalIDList({ for: [TaxClassRef], required: true }),
    customerTaxClassIds: t.globalIDList({ for: [TaxClassRef] }),
    taxRateIds: t.globalIDList({ for: [TaxRateRef], required: true }),
  }),
});
const TaxRuleUpdateInput = builder.inputType("TaxRuleUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string(),
    priority: t.int(),
    productTaxClassIds: t.globalIDList({ for: [TaxClassRef] }),
    customerTaxClassIds: t.globalIDList({ for: [TaxClassRef] }),
    taxRateIds: t.globalIDList({ for: [TaxRateRef] }),
  }),
});

const TaxClassPayload = builder.simpleObject("TaxClassPayload", { subGraphs: ADMIN, fields: (t) => ({ taxClass: t.field({ type: TaxClassRef }) }) });
const TaxRatePayload = builder.simpleObject("TaxRatePayload", { subGraphs: ADMIN, fields: (t) => ({ taxRate: t.field({ type: TaxRateRef }) }) });
const TaxRulePayload = builder.simpleObject("TaxRulePayload", { subGraphs: ADMIN, fields: (t) => ({ taxRule: t.field({ type: TaxRuleRef }) }) });

// ---------------------------------------------------------------- mutations

const write = { subGraphs: ADMIN, authScopes: { permission: "settings:write" }, errors: {} } as const;
const writeOrInvalid = { subGraphs: ADMIN, authScopes: { permission: "settings:write" as const }, errors: { types: [InvalidStateError] } };
const ids = (list: { id: string }[] | null | undefined) => (list ?? []).map(rawId);

builder.mutationFields((t) => ({
  taxClassCreate: t.field({ ...write, type: TaxClassPayload, args: { input: t.arg({ type: TaxClassInput, required: true }) }, resolve: async (_r, { input }, ctx) => ({ taxClass: await createTaxClass(ctx.db, input) }) }),
  taxClassUpdate: t.field({
    ...write,
    type: TaxClassPayload,
    description: "Code and kind are fixed once created.",
    args: { id: t.arg.globalID({ for: [TaxClassRef], required: true }), name: t.arg.string({ required: true }) },
    resolve: async (_r, { id, name }, ctx) => ({ taxClass: await updateTaxClass(ctx.db, rawId(id), { name }) }),
  }),
  taxClassDelete: t.field({
    ...writeOrInvalid,
    type: DeletePayload,
    description: "Fails while products, product types, customer groups, channels or shipping methods use the class.",
    args: { id: t.arg.globalID({ for: [TaxClassRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("TaxClass", await deleteTaxClass(ctx.db, rawId(id))) }),
  }),
  taxRateCreate: t.field({ ...write, type: TaxRatePayload, args: { input: t.arg({ type: TaxRateInput, required: true }) }, resolve: async (_r, { input }, ctx) => ({ taxRate: await createTaxRate(ctx.db, input) }) }),
  taxRateUpdate: t.field({
    ...write,
    type: TaxRatePayload,
    args: { id: t.arg.globalID({ for: [TaxRateRef], required: true }), input: t.arg({ type: TaxRateUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({
      // Null clears the region code or postal pattern; for name and rate it means "unchanged".
      taxRate: await updateTaxRate(ctx.db, rawId(id), Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && (v !== null || k === "regionCode" || k === "postalCodePattern")))),
    }),
  }),
  taxRateDelete: t.field({
    ...write,
    type: DeletePayload,
    description: "Also removes the rate from every tax rule.",
    args: { id: t.arg.globalID({ for: [TaxRateRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("TaxRate", await deleteTaxRate(ctx.db, rawId(id))) }),
  }),
  taxRuleCreate: t.field({
    ...write,
    type: TaxRulePayload,
    args: { input: t.arg({ type: TaxRuleInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      taxRule: await createTaxRule(ctx.db, { name: input.name, priority: input.priority ?? 0, productTaxClassIds: ids(input.productTaxClassIds), customerTaxClassIds: ids(input.customerTaxClassIds), taxRateIds: ids(input.taxRateIds) }),
    }),
  }),
  taxRuleUpdate: t.field({
    ...write,
    type: TaxRulePayload,
    args: { id: t.arg.globalID({ for: [TaxRuleRef], required: true }), input: t.arg({ type: TaxRuleUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({
      taxRule: await updateTaxRule(ctx.db, rawId(id), {
        ...(input.name != null ? { name: input.name } : {}),
        ...(input.priority != null ? { priority: input.priority } : {}),
        ...(input.productTaxClassIds ? { productTaxClassIds: ids(input.productTaxClassIds) } : {}),
        ...(input.customerTaxClassIds ? { customerTaxClassIds: ids(input.customerTaxClassIds) } : {}),
        ...(input.taxRateIds ? { taxRateIds: ids(input.taxRateIds) } : {}),
      }),
    }),
  }),
  taxRuleDelete: t.field({
    ...write,
    type: DeletePayload,
    args: { id: t.arg.globalID({ for: [TaxRuleRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("TaxRule", await deleteTaxRule(ctx.db, rawId(id))) }),
  }),
}));
