import { InvalidStateError } from "../../lib/errors.ts";
import { toGlobalId } from "../../lib/ids.ts";
import type { SettingField } from "../../plugins/sdk.ts";
import { BUILT_IN_SHIPPING_KINDS, isBuiltInConfig, isLiveProvider, type ShippingProvider } from "../../modules/shipping/providers.ts";
import {
  createShippingMethod,
  createShippingZone,
  deleteShippingMethod,
  deleteShippingZone,
  listShippingMethods,
  listShippingZones,
  updateShippingMethod,
  updateShippingZone,
} from "../../modules/shipping/service.ts";
import type { ShippingMethodConfig } from "../../modules/shipping/tables.ts";
import { listTaxClasses } from "../../modules/tax/service.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import { ChannelRef, ShippingMethodRef, ShippingZoneRef, TaxClassRef } from "../refs.ts";
import { DeletePayload, fromLocalizedList, LocalizedStringInput, LocalizedStringRef, toLocalizedList } from "./common.ts";
import { byIdFrom, MoneyByCurrencyInput, toAmounts } from "./settings.ts";

builder.node(ShippingZoneRef, {
  subGraphs: ADMIN,
  id: { resolve: (x) => x.id },
  loadMany: byIdFrom(listShippingZones),
  fields: (t) => ({ name: t.exposeString("name"), countries: t.field({ type: ["CountryCode"], resolve: (z) => z.countries }) }),
});

const ShippingRateKind = builder.enumType("ShippingRateKind", { values: { FLAT_RATE: { value: "flat_rate" }, TABLE_RATE: { value: "table_rate" }, FREE: { value: "free" } } as const });

// ---------------------------------------------------------------- providers

const ShippingProviderOptionType = builder.enumType("ShippingProviderOptionType", {
  subGraphs: ADMIN,
  values: { STRING: { value: "string" }, SECRET: { value: "secret" }, BOOLEAN: { value: "boolean" }, NUMBER: { value: "number" }, SELECT: { value: "select" } } as const,
});

const ShippingProviderOptionRef = builder.objectRef<{ key: string; field: SettingField }>("ShippingProviderOption").implement({
  subGraphs: ADMIN,
  description: "One option a shipping method sets for its provider, described like a plugin setting so the admin can render a form.",
  fields: (t) => ({
    key: t.string({ resolve: (o) => o.key }),
    label: t.string({ resolve: (o) => o.field.label }),
    description: t.string({ nullable: true, resolve: (o) => o.field.description ?? null }),
    type: t.field({ type: ShippingProviderOptionType, resolve: (o) => o.field.type }),
    required: t.boolean({ resolve: (o) => ("required" in o.field && o.field.required) || false }),
    options: t.field({
      type: [builder.objectRef<{ value: string; label: string }>("ShippingProviderOptionChoice").implement({ subGraphs: ADMIN, fields: (f) => ({ value: f.exposeString("value"), label: f.exposeString("label") }) })],
      nullable: true,
      description: "The choices of a SELECT.",
      resolve: (o) => (o.field.type === "select" ? [...o.field.options] : null),
    }),
    placeholder: t.string({ nullable: true, resolve: (o) => (o.field.type === "string" ? (o.field.placeholder ?? null) : null) }),
    multiline: t.boolean({ nullable: true, resolve: (o) => (o.field.type === "string" ? (o.field.multiline ?? false) : null) }),
    min: t.float({ nullable: true, resolve: (o) => (o.field.type === "number" ? (o.field.min ?? null) : null) }),
    max: t.float({ nullable: true, resolve: (o) => (o.field.type === "number" ? (o.field.max ?? null) : null) }),
    integer: t.boolean({ nullable: true, resolve: (o) => (o.field.type === "number" ? (o.field.integer ?? false) : null) }),
    defaultValue: t.field({ type: "JSON", nullable: true, resolve: (o) => ("default" in o.field ? (o.field.default ?? null) : null) }),
  }),
});

const isActive = async (provider: ShippingProvider) => (provider.isActive ? provider.isActive().catch(() => false) : true);

export const ShippingProviderRef = builder.objectRef<ShippingProvider>("ShippingProvider").implement({
  subGraphs: ADMIN,
  description: "A rate engine or carrier that shipping methods use: built in, or from a plugin.",
  fields: (t) => ({
    code: t.exposeString("code", { description: "What methods name in `provider`." }),
    title: t.exposeString("title"),
    description: t.string({ nullable: true, resolve: (p) => p.description ?? null }),
    plugin: t.string({ nullable: true, description: "The plugin it comes from; null for built-in providers.", resolve: (p) => p.plugin ?? null }),
    builtIn: t.boolean({ description: "Flat rate, table rate or free shipping: configured with `rate`, not `methodOptions`.", resolve: (p) => BUILT_IN_SHIPPING_KINDS.has(p.code) }),
    active: t.boolean({ description: "False while its plugin is disabled or not set up: its methods offer no rates.", resolve: isActive }),
    live: t.boolean({ description: "Asks a remote service for rates, which are cached for a few minutes.", resolve: (p) => isLiveProvider(p) }),
    canCreateShipment: t.boolean({ description: "Can buy labels when staff fulfil orders (orderFulfill createShipment).", resolve: (p) => !!p.createShipment }),
    methodOptions: t.field({
      type: [ShippingProviderOptionRef],
      description: "What each method using it sets in `rate.provider.options`.",
      resolve: (p) => Object.entries(p.methodOptions ?? {}).map(([key, field]) => ({ key, field })),
    }),
  }),
});

builder.node(ShippingMethodRef, {
  subGraphs: ADMIN,
  id: { resolve: (x) => x.id },
  loadMany: byIdFrom(listShippingMethods),
  fields: (t) => ({
    code: t.exposeString("code"),
    names: t.field({ type: [LocalizedStringRef], resolve: (m) => toLocalizedList(m.name) }),
    kind: t.field({ type: ShippingRateKind, nullable: true, description: "The built-in rate model; null for methods of other providers.", resolve: (m) => (isBuiltInConfig(m.config) ? m.config.kind : null) }),
    provider: t.string({ description: "The provider's code: flat_rate, table_rate, free, or a plugin's (see shippingProviders).", resolve: (m) => m.config.kind }),
    providerOptions: t.field({ type: "JSON", nullable: true, description: "The method's options for a plugin provider; null for built-in ones.", resolve: (m) => (isBuiltInConfig(m.config) ? null : (m.config.options ?? {})) }),
    config: t.field({ type: "JSON", description: "Amounts are minor units per currency.", resolve: (m) => m.config }),
    zone: t.field({ type: ShippingZoneRef, resolve: async (m, _a, ctx) => (await listShippingZones(ctx.db)).find((z) => z.id === m.zoneId)! }),
    channels: t.field({ type: [ChannelRef], resolve: async (m, _a, ctx) => (await ctx.db.query.channels.findMany()).filter((c) => m.channelIds.length === 0 || m.channelIds.includes(c.id)) }),
    allChannels: t.boolean({ description: "True when not restricted to particular channels; `channels` then lists every channel.", resolve: (m) => m.channelIds.length === 0 }),
    taxClass: t.field({ type: TaxClassRef, nullable: true, description: "Overrides the channel's shipping tax class.", resolve: async (m, _a, ctx) => (m.taxClassId ? ((await listTaxClasses(ctx.db)).find((c) => c.id === m.taxClassId) ?? null) : null) }),
    minDeliveryDays: t.exposeInt("minDeliveryDays", { nullable: true }),
    maxDeliveryDays: t.exposeInt("maxDeliveryDays", { nullable: true }),
    isActive: t.exposeBoolean("isActive"),
    position: t.exposeInt("position"),
  }),
});

builder.queryFields((t) => ({
  shippingZones: t.field({ type: [ShippingZoneRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listShippingZones(ctx.db) }),
  shippingMethods: t.field({ type: [ShippingMethodRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listShippingMethods(ctx.db) }),
  shippingProviders: t.field({
    type: [ShippingProviderRef],
    subGraphs: ADMIN,
    description: "Built-in providers first, then those of the configured plugins.",
    authScopes: { permission: "settings:read" },
    resolve: (_r, _a, ctx) => [...ctx.platform.shipping.values()],
  }),
}));

// ---------------------------------------------------------------- inputs

const ShippingRateTierInput = builder.inputType("ShippingRateTierInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ from: t.float({ required: true, description: "Grams, minor units or units, per the basis." }), prices: t.field({ type: [MoneyByCurrencyInput], required: true }) }),
});
const ShippingRateBasis = builder.enumType("ShippingRateBasis", { subGraphs: ADMIN, values: { WEIGHT: { value: "weight" }, SUBTOTAL: { value: "subtotal" }, QUANTITY: { value: "quantity" } } as const });

const ShippingRateConfigInput = builder.inputType("ShippingRateConfigInput", {
  subGraphs: ADMIN,
  isOneOf: true,
  description: "Exactly one rate model.",
  fields: (t) => ({
    flatRate: t.field({ type: builder.inputType("FlatRateInput", { subGraphs: ADMIN, fields: (f) => ({ prices: f.field({ type: [MoneyByCurrencyInput], required: true }), perItem: f.boolean() }) }) }),
    tableRate: t.field({ type: builder.inputType("TableRateInput", { subGraphs: ADMIN, fields: (f) => ({ basis: f.field({ type: ShippingRateBasis, required: true }), tiers: f.field({ type: [ShippingRateTierInput], required: true }) }) }) }),
    free: t.field({ type: builder.inputType("FreeShippingInput", { subGraphs: ADMIN, fields: (f) => ({ minimumSubtotals: f.field({ type: [MoneyByCurrencyInput], required: true }) }) }) }),
    provider: t.field({
      description: "Another provider (shippingProviders), e.g. a plugin's live carrier rates.",
      type: builder.inputType("ShippingProviderConfigInput", {
        subGraphs: ADMIN,
        fields: (f) => ({
          code: f.string({ required: true, description: "The provider's code." }),
          options: f.field({ type: "JSON", description: "Values for its methodOptions, by key." }),
        }),
      }),
    }),
  }),
});

const toShippingConfig = (input: {
  flatRate?: { prices: { currencyCode: string; amount: string }[]; perItem?: boolean | null } | null;
  tableRate?: { basis: "weight" | "subtotal" | "quantity"; tiers: { from: number; prices: { currencyCode: string; amount: string }[] }[] } | null;
  free?: { minimumSubtotals: { currencyCode: string; amount: string }[] } | null;
  provider?: { code: string; options?: unknown } | null;
}): ShippingMethodConfig => {
  if (input.flatRate) return { kind: "flat_rate", amounts: toAmounts(input.flatRate.prices), per: input.flatRate.perItem ? "item" : "order" };
  if (input.tableRate) return { kind: "table_rate", basis: input.tableRate.basis, tiers: input.tableRate.tiers.map((x) => ({ from: x.from, amounts: toAmounts(x.prices) })) };
  // Options are checked against the provider by the service.
  if (input.provider) return { kind: input.provider.code, options: (input.provider.options ?? {}) as Record<string, unknown> };
  return { kind: "free", minimumSubtotals: toAmounts(input.free!.minimumSubtotals) };
};

const ShippingMethodInput = builder.inputType("ShippingMethodInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    names: t.field({ type: [LocalizedStringInput], required: true }),
    zoneId: t.globalID({ for: [ShippingZoneRef], required: true }),
    channelIds: t.globalIDList({ for: [ChannelRef] }),
    rate: t.field({ type: ShippingRateConfigInput, required: true }),
    minDeliveryDays: t.int(),
    maxDeliveryDays: t.int(),
    taxClassId: t.globalID({ for: [TaxClassRef] }),
    isActive: t.boolean(),
    position: t.int(),
  }),
});
const ShippingMethodUpdateInput = builder.inputType("ShippingMethodUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    names: t.field({ type: [LocalizedStringInput] }),
    rate: t.field({ type: ShippingRateConfigInput }),
    channelIds: t.globalIDList({ for: [ChannelRef], description: "Empty means every channel." }),
    zoneId: t.globalID({ for: [ShippingZoneRef] }),
    taxClassId: t.globalID({ for: [TaxClassRef], description: "Null removes the override." }),
    minDeliveryDays: t.int(),
    maxDeliveryDays: t.int(),
    isActive: t.boolean(),
    position: t.int(),
  }),
});

const ShippingZonePayload = builder.simpleObject("ShippingZonePayload", { subGraphs: ADMIN, fields: (t) => ({ shippingZone: t.field({ type: ShippingZoneRef }) }) });
const ShippingMethodPayload = builder.simpleObject("ShippingMethodPayload", { subGraphs: ADMIN, fields: (t) => ({ shippingMethod: t.field({ type: ShippingMethodRef }) }) });

// ---------------------------------------------------------------- mutations

const write = { subGraphs: ADMIN, authScopes: { permission: "settings:write" }, errors: {} } as const;
const writeOrInvalid = { subGraphs: ADMIN, authScopes: { permission: "settings:write" as const }, errors: { types: [InvalidStateError] } };
const ids = (list: { id: string }[] | null | undefined) => (list ?? []).map(rawId);

builder.mutationFields((t) => ({
  shippingZoneCreate: t.field({
    ...write,
    type: ShippingZonePayload,
    args: { name: t.arg.string({ required: true }), countries: t.arg({ type: ["CountryCode"], required: true }) },
    resolve: async (_r, args, ctx) => ({ shippingZone: await createShippingZone(ctx.db, args) }),
  }),
  shippingZoneUpdate: t.field({
    ...write,
    type: ShippingZonePayload,
    args: { id: t.arg.globalID({ for: [ShippingZoneRef], required: true }), name: t.arg.string(), countries: t.arg({ type: ["CountryCode"] }) },
    resolve: async (_r, { id, name, countries }, ctx) => ({ shippingZone: await updateShippingZone(ctx.db, rawId(id), { ...(name != null ? { name } : {}), ...(countries ? { countries } : {}) }) }),
  }),
  shippingZoneDelete: t.field({
    ...writeOrInvalid,
    type: DeletePayload,
    description: "Fails while the zone has shipping methods.",
    args: { id: t.arg.globalID({ for: [ShippingZoneRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("ShippingZone", await deleteShippingZone(ctx.db, rawId(id))) }),
  }),
  shippingMethodCreate: t.field({
    ...write,
    type: ShippingMethodPayload,
    args: { input: t.arg({ type: ShippingMethodInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      shippingMethod: await createShippingMethod(ctx.db, {
        code: input.code,
        name: fromLocalizedList(input.names),
        zoneId: rawId(input.zoneId),
        channelIds: ids(input.channelIds),
        config: toShippingConfig(input.rate),
        minDeliveryDays: input.minDeliveryDays,
        maxDeliveryDays: input.maxDeliveryDays,
        taxClassId: input.taxClassId ? rawId(input.taxClassId) : null,
        isActive: input.isActive ?? true,
        position: input.position ?? 0,
      }, ctx.platform.shipping),
    }),
  }),
  shippingMethodUpdate: t.field({
    ...write,
    type: ShippingMethodPayload,
    args: { id: t.arg.globalID({ for: [ShippingMethodRef], required: true }), input: t.arg({ type: ShippingMethodUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({
      shippingMethod: await updateShippingMethod(ctx.db, rawId(id), {
        ...(input.names ? { name: fromLocalizedList(input.names) } : {}),
        ...(input.rate ? { config: toShippingConfig(input.rate) } : {}),
        ...(input.channelIds ? { channelIds: ids(input.channelIds) } : {}),
        ...(input.zoneId ? { zoneId: rawId(input.zoneId) } : {}),
        ...(input.taxClassId !== undefined ? { taxClassId: input.taxClassId ? rawId(input.taxClassId) : null } : {}),
        ...Object.fromEntries(Object.entries({ minDeliveryDays: input.minDeliveryDays, maxDeliveryDays: input.maxDeliveryDays, isActive: input.isActive, position: input.position }).filter(([, v]) => v != null)),
      }, ctx.platform.shipping),
    }),
  }),
  shippingMethodDelete: t.field({
    ...write,
    type: DeletePayload,
    description: "Existing orders keep their own copy of the method.",
    args: { id: t.arg.globalID({ for: [ShippingMethodRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("ShippingMethod", await deleteShippingMethod(ctx.db, rawId(id))) }),
  }),
}));
