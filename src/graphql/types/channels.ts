import { createChannel, deleteExchangeRate, listChannels, listExchangeRates, setExchangeRate, updateChannel } from "../../modules/channels/service.ts";
import type { exchangeRates } from "../../modules/channels/tables.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import { ChannelRef, StockRef, TaxClassRef } from "../refs.ts";

const countryName = (code: string, locale: string) => {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

const CountryRef = builder.objectRef<{ code: string }>("Country").implement({
  fields: (t) => ({
    code: t.field({ type: "CountryCode", resolve: (c) => c.code }),
    name: t.string({ description: "In the request locale.", resolve: (c, _a, ctx) => countryName(c.code, ctx.scope.locale) }),
  }),
});

builder.node(ChannelRef, {
  id: { resolve: (c) => c.id },
  loadMany: async (ids, ctx) => {
    const rows = await listChannels(ctx.db);
    return ids.map((id) => rows.find((c) => c.id === id && (ctx.api === "admin" || c.id === ctx.scope.channel.id)) ?? null);
  },
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    defaultLocale: t.field({ type: "LocaleCode", resolve: (c) => c.defaultLocale }),
    locales: t.field({ type: ["LocaleCode"], resolve: (c) => c.locales }),
    defaultCurrency: t.field({ type: "CurrencyCode", resolve: (c) => c.defaultCurrency }),
    currencies: t.field({ type: ["CurrencyCode"], resolve: (c) => c.currencies }),
    countries: t.field({ type: [CountryRef], description: "Countries this channel sells to.", resolve: (c) => c.countries.map((code) => ({ code })) }),
    pricesIncludeTax: t.exposeBoolean("pricesIncludeTax"),
    isActive: t.exposeBoolean("isActive", { subGraphs: ADMIN }),
    orderNumberPrefix: t.exposeString("orderNumberPrefix", { subGraphs: ADMIN }),
    stock: t.field({ type: StockRef, nullable: true, subGraphs: ADMIN, resolve: (c, _a, ctx) => (c.stockId ? ctx.db.query.stocks.findFirst({ where: (s, { eq }) => eq(s.id, c.stockId!) }).then((s) => s ?? null) : null) }),
    shippingTaxClass: t.field({ type: TaxClassRef, nullable: true, subGraphs: ADMIN, resolve: (c, _a, ctx) => (c.shippingTaxClassId ? ctx.db.query.taxClasses.findFirst({ where: (x, { eq }) => eq(x.id, c.shippingTaxClassId!) }).then((x) => x ?? null) : null) }),
  }),
});

const LocalizationRef = builder.objectRef<{ ok: true }>("Localization").implement({
  description: "The scope this request runs in, set with @inContext or the X-Channel / Accept-Language / X-Currency headers.",
  fields: (t) => ({
    channel: t.field({ type: ChannelRef, resolve: (_l, _a, ctx) => ctx.scope.channel }),
    locale: t.field({ type: "LocaleCode", resolve: (_l, _a, ctx) => ctx.scope.locale }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (_l, _a, ctx) => ctx.scope.currency }),
  }),
});

builder.queryFields((t) => ({
  localization: t.field({ type: LocalizationRef, resolve: () => ({ ok: true as const }) }),
  channels: t.field({
    type: [ChannelRef],
    subGraphs: ADMIN,
    authScopes: { permission: "settings:read" },
    resolve: (_root, _args, ctx) => listChannels(ctx.db),
  }),
}));

const ChannelInput = builder.inputType("ChannelInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    name: t.string({ required: true }),
    defaultLocale: t.field({ type: "LocaleCode", required: true }),
    locales: t.field({ type: ["LocaleCode"], required: true }),
    defaultCurrency: t.field({ type: "CurrencyCode", required: true }),
    currencies: t.field({ type: ["CurrencyCode"], required: true }),
    countries: t.field({ type: ["CountryCode"], required: true }),
    stockId: t.globalID({ for: [StockRef] }),
    pricesIncludeTax: t.boolean(),
    shippingTaxClassId: t.globalID({ for: [TaxClassRef] }),
    orderNumberPrefix: t.string(),
    isActive: t.boolean(),
  }),
});

const ChannelUpdateInput = builder.inputType("ChannelUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string(),
    locales: t.field({ type: ["LocaleCode"] }),
    defaultLocale: t.field({ type: "LocaleCode" }),
    currencies: t.field({ type: ["CurrencyCode"] }),
    defaultCurrency: t.field({ type: "CurrencyCode" }),
    countries: t.field({ type: ["CountryCode"] }),
    stockId: t.globalID({ for: [StockRef] }),
    pricesIncludeTax: t.boolean(),
    shippingTaxClassId: t.globalID({ for: [TaxClassRef] }),
    orderNumberPrefix: t.string(),
    isActive: t.boolean(),
  }),
});

const ChannelPayload = builder.simpleObject("ChannelPayload", { subGraphs: ADMIN, fields: (t) => ({ channel: t.field({ type: ChannelRef }) }) });
const ExchangeRatePayload = builder.simpleObject("ExchangeRatePayload", {
  subGraphs: ADMIN,
  fields: (t) => ({ baseCurrency: t.field({ type: "CurrencyCode" }), quoteCurrency: t.field({ type: "CurrencyCode" }), rate: t.float() }),
});

const toChannelData = <T extends { stockId?: { id: string } | null; shippingTaxClassId?: { id: string } | null }>(input: T) => {
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));
  if (input.stockId !== undefined) data.stockId = input.stockId ? rawId(input.stockId) : null;
  if (input.shippingTaxClassId !== undefined) data.shippingTaxClassId = input.shippingTaxClassId ? rawId(input.shippingTaxClassId) : null;
  return data;
};

builder.mutationFields((t) => ({
  channelCreate: t.field({
    type: ChannelPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "settings:write" },
    errors: {},
    args: { input: t.arg({ type: ChannelInput, required: true }) },
    resolve: async (_root, { input }, ctx) => ({ channel: await createChannel(ctx.db, toChannelData(input)) }),
  }),
  channelUpdate: t.field({
    type: ChannelPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "settings:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [ChannelRef], required: true }), input: t.arg({ type: ChannelUpdateInput, required: true }) },
    resolve: async (_root, { id, input }, ctx) => ({ channel: await updateChannel(ctx.db, rawId(id), toChannelData(input)) }),
  }),
  exchangeRateSet: t.field({
    type: ExchangeRatePayload,
    subGraphs: ADMIN,
    description: "Rate used to convert default-currency prices when a variant has no price in the requested currency.",
    authScopes: { permission: "settings:write" },
    errors: {},
    args: { baseCurrency: t.arg({ type: "CurrencyCode", required: true }), quoteCurrency: t.arg({ type: "CurrencyCode", required: true }), rate: t.arg.float({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await setExchangeRate(ctx.db, args.baseCurrency, args.quoteCurrency, args.rate);
      return args;
    },
  }),
}));

const ExchangeRateRef = builder.objectRef<typeof exchangeRates.$inferSelect>("ExchangeRate").implement({
  subGraphs: ADMIN,
  description: "1 unit of the base currency in the quote currency.",
  fields: (t) => ({
    baseCurrency: t.field({ type: "CurrencyCode", resolve: (r) => r.baseCurrency }),
    quoteCurrency: t.field({ type: "CurrencyCode", resolve: (r) => r.quoteCurrency }),
    rate: t.float({ resolve: (r) => Number(r.rate) }),
    updatedAt: t.field({ type: "DateTime", resolve: (r) => r.updatedAt }),
  }),
});

builder.queryFields((t) => ({
  exchangeRates: t.field({ type: [ExchangeRateRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listExchangeRates(ctx.db) }),
}));

builder.mutationFields((t) => ({
  exchangeRateDelete: t.field({
    type: ExchangeRatePayload,
    subGraphs: ADMIN,
    authScopes: { permission: "settings:write" },
    errors: {},
    args: { baseCurrency: t.arg({ type: "CurrencyCode", required: true }), quoteCurrency: t.arg({ type: "CurrencyCode", required: true }) },
    resolve: async (_root, args, ctx) => {
      const row = await deleteExchangeRate(ctx.db, args.baseCurrency, args.quoteCurrency);
      return { baseCurrency: row.baseCurrency, quoteCurrency: row.quoteCurrency, rate: Number(row.rate) };
    },
  }),
}));
