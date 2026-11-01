import { eq } from "drizzle-orm";
import { adjustStockLevel, createStock, createStockLocation, getStockLocationIds, importStockLevels, listStockLocations, listStocks, setStockLevel, updateStock, updateStockLocation } from "../../modules/inventory/service.ts";
import { stockLocations } from "../../modules/inventory/tables.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import { ProductVariantRef, StockLevelRef, StockLocationRef, StockRef } from "../refs.ts";

builder.node(StockLocationRef, {
  subGraphs: ADMIN,
  id: { resolve: (l) => l.id },
  loadMany: async (ids, ctx) => {
    const rows = await listStockLocations(ctx.db);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    isActive: t.exposeBoolean("isActive"),
    city: t.string({ nullable: true, resolve: (l) => l.address.city ?? null }),
    postalCode: t.string({ nullable: true, resolve: (l) => l.address.postalCode ?? null }),
    countryCode: t.field({ type: "CountryCode", nullable: true, resolve: (l) => l.address.countryCode ?? null }),
  }),
});

builder.node(StockRef, {
  subGraphs: ADMIN,
  id: { resolve: (s) => s.id },
  loadMany: async (ids, ctx) => {
    const rows = await listStocks(ctx.db);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    locations: t.field({
      type: [StockLocationRef],
      description: "In sourcing priority order.",
      resolve: async (s, _a, ctx) => {
        const ids = await getStockLocationIds(ctx.db, s.id);
        const all = await listStockLocations(ctx.db);
        return ids.map((id) => all.find((l) => l.id === id)!).filter(Boolean);
      },
    }),
  }),
});

StockLevelRef.implement({
  subGraphs: ADMIN,
  description: "On-hand quantity of a variant at one location. Salable quantity also subtracts open reservations.",
  fields: (t) => ({
    quantity: t.exposeInt("quantity"),
    location: t.field({ type: StockLocationRef, resolve: async (l, _a, ctx) => (await ctx.db.query.stockLocations.findFirst({ where: eq(stockLocations.id, l.locationId) }))! }),
    variant: t.field({ type: ProductVariantRef, resolve: async (l, _a, ctx) => (await ctx.loaders.variant.load(l.variantId))! }),
    updatedAt: t.field({ type: "DateTime", resolve: (l) => l.updatedAt }),
  }),
});

builder.queryFields((t) => ({
  stockLocations: t.field({ type: [StockLocationRef], subGraphs: ADMIN, authScopes: { permission: "inventory:read" }, resolve: (_r, _a, ctx) => listStockLocations(ctx.db) }),
  stocks: t.field({ type: [StockRef], subGraphs: ADMIN, authScopes: { permission: "inventory:read" }, resolve: (_r, _a, ctx) => listStocks(ctx.db) }),
}));

const StockLocationInput = builder.inputType("StockLocationInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    name: t.string({ required: true }),
    city: t.string(),
    postalCode: t.string(),
    countryCode: t.field({ type: "CountryCode" }),
    isActive: t.boolean(),
  }),
});
const StockInput = builder.inputType("StockInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    name: t.string({ required: true }),
    locationIds: t.globalIDList({ for: [StockLocationRef], required: true, description: "In sourcing priority order." }),
  }),
});

const StockLocationPayload = builder.simpleObject("StockLocationPayload", { subGraphs: ADMIN, fields: (t) => ({ stockLocation: t.field({ type: StockLocationRef }) }) });
const StockPayload = builder.simpleObject("StockPayload", { subGraphs: ADMIN, fields: (t) => ({ stock: t.field({ type: StockRef }) }) });
const StockLevelPayload = builder.simpleObject("StockLevelPayload", { subGraphs: ADMIN, fields: (t) => ({ stockLevel: t.field({ type: StockLevelRef }) }) });
const StockLevelImportInput = builder.inputType("StockLevelImportInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ sku: t.string({ required: true }), locationCode: t.string({ required: true }), quantity: t.int({ required: true }) }),
});
const StockLevelImportResult = builder.simpleObject("StockLevelImportResult", {
  subGraphs: ADMIN,
  fields: (t) => ({ sku: t.string(), locationCode: t.string(), quantity: t.int(), error: t.string({ nullable: true, description: "Why the row was skipped; null when it was applied." }) }),
});
const StockLevelsImportPayload = builder.simpleObject("StockLevelsImportPayload", {
  subGraphs: ADMIN,
  fields: (t) => ({ applied: t.int(), results: t.field({ type: [StockLevelImportResult], description: "One per row, in input order." }) }),
});

builder.mutationFields((t) => ({
  stockLocationCreate: t.field({
    type: StockLocationPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: { input: t.arg({ type: StockLocationInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      stockLocation: await createStockLocation(ctx.db, {
        code: input.code,
        name: input.name,
        isActive: input.isActive ?? true,
        address: Object.fromEntries(Object.entries({ city: input.city, postalCode: input.postalCode, countryCode: input.countryCode }).filter(([, v]) => v != null)),
      }),
    }),
  }),
  stockCreate: t.field({
    type: StockPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: { input: t.arg({ type: StockInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      stock: await createStock(ctx.db, { code: input.code, name: input.name, locations: input.locationIds.map((l, priority) => ({ locationId: rawId(l), priority })) }),
    }),
  }),
  stockLevelSet: t.field({
    type: StockLevelPayload,
    subGraphs: ADMIN,
    description: "Set the counted on-hand quantity of a variant at a location.",
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: {
      variantId: t.arg.globalID({ for: [ProductVariantRef], required: true }),
      locationId: t.arg.globalID({ for: [StockLocationRef], required: true }),
      quantity: t.arg.int({ required: true }),
    },
    resolve: async (_r, args, ctx) => ({ stockLevel: await setStockLevel(ctx.db, { variantId: rawId(args.variantId), locationId: rawId(args.locationId), quantity: args.quantity }) }),
  }),
  stockLevelsImport: t.field({
    type: StockLevelsImportPayload,
    subGraphs: ADMIN,
    description: "Set counted on-hand quantities by SKU and location code, up to 5000 rows. Unresolved rows are skipped and reported; the rest apply in one transaction.",
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: { levels: t.arg({ type: [StockLevelImportInput], required: true }) },
    resolve: async (_r, { levels }, ctx) => {
      const results = await importStockLevels(ctx.db, levels);
      return { applied: results.filter((r) => !r.error).length, results };
    },
  }),
  stockLevelAdjust: t.field({
    type: StockLevelPayload,
    subGraphs: ADMIN,
    description: "Add (receiving) or remove (damage, shrinkage) on-hand stock at a location.",
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: {
      variantId: t.arg.globalID({ for: [ProductVariantRef], required: true }),
      locationId: t.arg.globalID({ for: [StockLocationRef], required: true }),
      delta: t.arg.int({ required: true }),
    },
    resolve: async (_r, args, ctx) => ({ stockLevel: await adjustStockLevel(ctx.db, { variantId: rawId(args.variantId), locationId: rawId(args.locationId), delta: args.delta }) }),
  }),
}));

const StockLocationUpdateInput = builder.inputType("StockLocationUpdateInput", {
  subGraphs: ADMIN,
  description: "The code is fixed once created.",
  fields: (t) => ({ name: t.string(), city: t.string(), postalCode: t.string(), countryCode: t.field({ type: "CountryCode" }), isActive: t.boolean() }),
});
const StockUpdateInput = builder.inputType("StockUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ name: t.string(), locationIds: t.globalIDList({ for: [StockLocationRef], description: "Replaces the locations, in sourcing priority order." }) }),
});

builder.mutationFields((t) => ({
  stockLocationUpdate: t.field({
    type: StockLocationPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [StockLocationRef], required: true }), input: t.arg({ type: StockLocationUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      const existing = (await listStockLocations(ctx.db)).find((l) => l.id === rawId(id));
      const address = { ...(existing?.address ?? {}), ...Object.fromEntries(Object.entries({ city: input.city, postalCode: input.postalCode, countryCode: input.countryCode }).filter(([, v]) => v !== undefined)) };
      return {
        stockLocation: await updateStockLocation(ctx.db, rawId(id), {
          ...(input.name != null ? { name: input.name } : {}),
          ...(input.isActive != null ? { isActive: input.isActive } : {}),
          address: Object.fromEntries(Object.entries(address).filter(([, v]) => v != null)),
        }),
      };
    },
  }),
  stockUpdate: t.field({
    type: StockPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "inventory:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [StockRef], required: true }), input: t.arg({ type: StockUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({
      stock: await updateStock(ctx.db, rawId(id), { ...(input.name != null ? { name: input.name } : {}), ...(input.locationIds ? { locationIds: input.locationIds.map(rawId) } : {}) }),
    }),
  }),
}));
