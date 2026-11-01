import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { addressSchema } from "../../lib/address.ts";
import { InsufficientStockError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { parseInput, patchSchema } from "../../lib/validation.ts";
import { productVariants } from "../catalog/tables.ts";
import { emit } from "../integrations/outbox.ts";
import { reindexProducts } from "../search/projector.ts";
import { getSalableQuantities } from "./stock.ts";
import { stockLevels, stockLocations, stockReservations, stocks, stockSources } from "./tables.ts";

export type StockLocation = typeof stockLocations.$inferSelect;
export type Stock = typeof stocks.$inferSelect;

const locationSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1),
  address: addressSchema.partial().default({}),
  isActive: z.boolean().default(true),
});

const stockSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1),
  locations: z.array(z.object({ locationId: z.uuid(), priority: z.number().int().default(0) })).default([]),
});

export const createStockLocation = async (db: Database, input: unknown) => {
  const [row] = await db.insert(stockLocations).values(parseInput(locationSchema, input)).returning();
  return row!;
};

export const createStock = async (db: Database, input: unknown) => {
  const data = parseInput(stockSchema, input);
  const [stock] = await db.insert(stocks).values({ code: data.code, name: data.name }).returning();
  if (data.locations.length > 0) {
    await db.insert(stockSources).values(data.locations.map((l) => ({ stockId: stock!.id, locationId: l.locationId, priority: l.priority })));
  }
  return stock!;
};

export const listStockLocations = (db: Database) => db.query.stockLocations.findMany({ orderBy: stockLocations.code });
export const listStocks = (db: Database) => db.query.stocks.findMany({ orderBy: stocks.code });
export const getStockLocationIds = async (db: Database, stockId: string) =>
  (await db.select().from(stockSources).where(eq(stockSources.stockId, stockId)).orderBy(stockSources.priority)).map((s) => s.locationId);

const productIdsOf = async (db: Database, variantIds: string[]) =>
  variantIds.length === 0
    ? []
    : [...new Set((await db.select({ productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, variantIds))).map((r) => r.productId))];

/** Absolute, as after a stock count. */
export const setStockLevel = async (db: Database, input: { variantId: string; locationId: string; quantity: number }) => {
  const location = await db.query.stockLocations.findFirst({ where: eq(stockLocations.id, input.locationId) });
  if (!location) throw new NotFoundError("StockLocation", input.locationId);
  const [row] = await db
    .insert(stockLevels)
    .values(input)
    .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { quantity: input.quantity, updatedAt: new Date() } })
    .returning();
  await afterLevelChange(db, [input.variantId], input.locationId);
  return row!;
};

const MAX_IMPORT_ROWS = 5000;

/**
 * Set counted quantities by SKU and location code. Rows that don't resolve are reported and
 * skipped; when a SKU and location repeat, the last row wins.
 */
export const importStockLevels = async (db: Database, rows: { sku: string; locationCode: string; quantity: number }[]) =>
  db.transaction(async (tx) => {
    if (rows.length === 0 || rows.length > MAX_IMPORT_ROWS) throw new ValidationError("Invalid rows", [{ path: ["levels"], message: `Between 1 and ${MAX_IMPORT_ROWS} rows` }]);
    const skus = [...new Set(rows.map((r) => r.sku.trim().toLowerCase()).filter(Boolean))];
    const variants = skus.length ? await tx.select({ id: productVariants.id, sku: productVariants.sku }).from(productVariants).where(inArray(sql`lower(${productVariants.sku})`, skus)) : [];
    const exact = new Map(variants.map((v) => [v.sku, v.id]));
    const anyCase = new Map(variants.map((v) => [v.sku.toLowerCase(), v.id]));
    const locations = new Map((await tx.select().from(stockLocations)).map((l) => [l.code.toLowerCase(), l.id]));
    const results = rows.map((row) => {
      const sku = row.sku.trim();
      const locationCode = row.locationCode.trim();
      const variantId = exact.get(sku) ?? anyCase.get(sku.toLowerCase());
      const locationId = locations.get(locationCode.toLowerCase());
      const error = !sku
        ? "Missing SKU"
        : !variantId
          ? "No variant with this SKU"
          : !locationId
            ? `Unknown location "${locationCode}"`
            : !Number.isInteger(row.quantity) || row.quantity < 0
              ? "Quantity must be a whole number of 0 or more"
              : null;
      return { sku, locationCode, quantity: row.quantity, error, variantId, locationId };
    });
    const levels = new Map<string, { variantId: string; locationId: string; quantity: number }>();
    for (const r of results) if (!r.error) levels.set(`${r.variantId}:${r.locationId}`, { variantId: r.variantId!, locationId: r.locationId!, quantity: r.quantity });
    if (levels.size) {
      await tx
        .insert(stockLevels)
        .values([...levels.values()])
        .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { quantity: sql`excluded.quantity`, updatedAt: new Date() } });
      for (const locationId of new Set([...levels.values()].map((l) => l.locationId))) {
        await afterLevelChange(tx, [...levels.values()].filter((l) => l.locationId === locationId).map((l) => l.variantId), locationId);
      }
    }
    return results.map(({ sku, locationCode, quantity, error }) => ({ sku, locationCode, quantity, error }));
  });

/** For receiving, damage and corrections. */
export const adjustStockLevel = async (db: Database, input: { variantId: string; locationId: string; delta: number }) => {
  const [row] = await db
    .insert(stockLevels)
    .values({ variantId: input.variantId, locationId: input.locationId, quantity: input.delta })
    .onConflictDoUpdate({
      target: [stockLevels.variantId, stockLevels.locationId],
      set: { quantity: sql`${stockLevels.quantity} + ${input.delta}`, updatedAt: new Date() },
    })
    .returning();
  await afterLevelChange(db, [input.variantId], input.locationId);
  return row!;
};

const afterLevelChange = async (db: Database, variantIds: string[], locationId: string) => {
  await reindexProducts(db, await productIdsOf(db, variantIds));
  await emit(db, ...variantIds.map((variantId) => ({ type: "inventory.level_changed" as const, aggregateType: "ProductVariant", aggregateId: variantId, payload: { locationId } })));
};

export type ReservationLine = { variantId: string; sku: string; quantity: number; trackInventory: boolean; allowBackorder: boolean };

/**
 * Transaction-scoped advisory locks per (stock, variant), taken in sorted order, serialize
 * concurrent checkouts of the same item without locking level rows.
 */
export const reserveStock = async (db: Database, stockId: string, lines: ReservationLine[], orderId: string) => {
  const tracked = lines.filter((l) => l.trackInventory).sort((a, b) => a.variantId.localeCompare(b.variantId));
  for (const line of tracked) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${stockId}:${line.variantId}`}, 0))`);
  }
  const salable = await getSalableQuantities(db, stockId, tracked.map((l) => l.variantId));
  for (const line of tracked) {
    const available = salable.get(line.variantId) ?? 0;
    if (!line.allowBackorder && available < line.quantity) {
      throw new InsufficientStockError({ variantId: line.variantId, sku: line.sku, requested: line.quantity, available });
    }
  }
  if (tracked.length > 0) {
    await db.insert(stockReservations).values(tracked.map((l) => ({ stockId, variantId: l.variantId, quantity: -l.quantity, reason: "order_placed" as const, referenceId: orderId })));
  }
};

/** For cancellation, or a refund before shipping. */
export const compensateReservations = async (
  db: Database,
  stockId: string,
  lines: { variantId: string; quantity: number }[],
  reason: "order_canceled" | "order_refunded",
  orderId: string,
) => {
  const rows = lines.filter((l) => l.quantity > 0);
  if (rows.length === 0) return;
  await db.insert(stockReservations).values(rows.map((l) => ({ stockId, variantId: l.variantId, quantity: l.quantity, reason, referenceId: orderId })));
};

/** Deducts on-hand and adds a compensating reservation, so salable quantity is unchanged. */
export const deductStockForFulfillment = async (
  db: Database,
  input: { stockId: string; locationId: string; lines: { variantId: string; quantity: number }[]; orderId: string },
) => {
  for (const line of input.lines) {
    await db
      .insert(stockLevels)
      .values({ variantId: line.variantId, locationId: input.locationId, quantity: -line.quantity })
      .onConflictDoUpdate({
        target: [stockLevels.variantId, stockLevels.locationId],
        set: { quantity: sql`${stockLevels.quantity} - ${line.quantity}`, updatedAt: new Date() },
      });
  }
  await db.insert(stockReservations).values(
    input.lines.map((l) => ({ stockId: input.stockId, variantId: l.variantId, quantity: l.quantity, reason: "order_fulfilled" as const, referenceId: input.orderId })),
  );
  // On-hand changed even though salable did not; low-stock alerts watch on-hand.
  await emit(db, ...input.lines.map((l) => ({ type: "inventory.level_changed" as const, aggregateType: "ProductVariant", aggregateId: l.variantId, payload: { locationId: input.locationId } })));
};

/** Put returned items back on hand at a location. */
export const restock = async (db: Database, locationId: string, lines: { variantId: string; quantity: number }[]) => {
  for (const line of lines) await adjustStockLevel(db, { variantId: line.variantId, locationId, delta: line.quantity });
};

export const updateStockLocation = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(patchSchema(locationSchema.omit({ code: true })), input);
  const [row] = await db.update(stockLocations).set({ ...data, updatedAt: new Date() }).where(eq(stockLocations.id, id)).returning();
  if (!row) throw new NotFoundError("StockLocation", id);
  return row;
};

/** `locationIds` replaces the locations; its order is the sourcing priority. */
export const updateStock = async (db: Database, id: string, input: unknown) =>
  db.transaction(async (tx) => {
    const data = parseInput(z.object({ name: z.string().min(1).optional(), locationIds: z.array(z.uuid()).optional() }), input);
    const [stock] = data.name ? await tx.update(stocks).set({ name: data.name }).where(eq(stocks.id, id)).returning() : await tx.select().from(stocks).where(eq(stocks.id, id));
    if (!stock) throw new NotFoundError("Stock", id);
    if (data.locationIds) {
      await tx.delete(stockSources).where(eq(stockSources.stockId, id));
      if (data.locationIds.length) await tx.insert(stockSources).values(data.locationIds.map((locationId, priority) => ({ stockId: id, locationId, priority })));
    }
    return stock;
  });
