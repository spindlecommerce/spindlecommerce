import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { stockLevels, stockReservations, stockSources } from "./tables.ts";

/** Salable quantity per variant for a stock: Σ levels at the stock's locations + Σ reservations. */
export const getSalableQuantities = async (db: Database, stockId: string | null, variantIds: readonly string[]): Promise<Map<string, number>> => {
  const result = new Map<string, number>(variantIds.map((id) => [id, 0]));
  if (!stockId || variantIds.length === 0) return result;
  const ids = [...variantIds];
  // Sequential: called inside checkout transactions, which run one query at a time.
  const levels = await db
    .select({ variantId: stockLevels.variantId, quantity: sql<number>`sum(${stockLevels.quantity})::int` })
    .from(stockLevels)
    .innerJoin(stockSources, eq(stockSources.locationId, stockLevels.locationId))
    .where(and(eq(stockSources.stockId, stockId), inArray(stockLevels.variantId, ids)))
    .groupBy(stockLevels.variantId);
  const reservations = await db
    .select({ variantId: stockReservations.variantId, quantity: sql<number>`sum(${stockReservations.quantity})::int` })
    .from(stockReservations)
    .where(and(eq(stockReservations.stockId, stockId), inArray(stockReservations.variantId, ids)))
    .groupBy(stockReservations.variantId);
  for (const row of [...levels, ...reservations]) result.set(row.variantId, (result.get(row.variantId) ?? 0) + Number(row.quantity));
  return result;
};

export const getStockLevelsByVariantIds = async (db: Database, variantIds: readonly string[]) =>
  variantIds.length === 0 ? [] : db.select().from(stockLevels).where(inArray(stockLevels.variantId, [...variantIds]));

export type StockPolicy = { trackInventory: boolean; allowBackorder: boolean };

export const isAvailable = (variant: StockPolicy, salable: number, quantity = 1) =>
  !variant.trackInventory || variant.allowBackorder || salable >= quantity;
