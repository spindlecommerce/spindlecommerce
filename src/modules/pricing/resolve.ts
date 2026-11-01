import { and, inArray, eq } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { convert } from "../../lib/money.ts";
import { getExchangeRate } from "../channels/service.ts";
import { variantPrices } from "./tables.ts";

export type PriceRow = typeof variantPrices.$inferSelect;

export type PriceContext = {
  channelId: string;
  currency: string;
  /** Channel default currency, used with an exchange rate when no price exists in `currency`. */
  defaultCurrency: string;
  customerGroupId: string | null;
  at: Date;
};

export type ResolvedPrice = {
  currency: string;
  amount: number;
  /** Strike-through price: explicit compare-at, or the list price when a lower price applies. */
  compareAtAmount: number | null;
  tierPrices: { minQuantity: number; amount: number }[];
  /** From the default currency, by exchange rate. */
  converted: boolean;
};

const isActive = (row: PriceRow, at: Date) => (!row.startsAt || row.startsAt <= at) && (!row.endsAt || row.endsAt > at);

/** The lowest applicable of list, active special, customer-group and quantity tier prices. */
export const selectPrice = (
  rows: PriceRow[],
  ctx: Pick<PriceContext, "customerGroupId" | "at">,
  quantity = 1,
): Omit<ResolvedPrice, "currency" | "converted"> | null => {
  const eligible = rows.filter((r) => isActive(r, ctx.at) && (r.customerGroupId === null || r.customerGroupId === ctx.customerGroupId));
  const list = eligible
    .filter((r) => r.customerGroupId === null && r.minQuantity <= 1 && !r.startsAt && !r.endsAt)
    .sort((a, b) => a.amount - b.amount)[0];
  const candidates = eligible.filter((r) => r.minQuantity <= quantity);
  if (candidates.length === 0) return null;
  const best = candidates.reduce((min, r) => (r.amount < min.amount ? r : min));
  const compareAt = list?.compareAtAmount ?? best.compareAtAmount ?? (list && best.amount < list.amount ? list.amount : null);
  const tiers = new Map<number, number>();
  for (const r of eligible) {
    if (r.minQuantity > 1) tiers.set(r.minQuantity, Math.min(tiers.get(r.minQuantity) ?? Infinity, r.amount));
  }
  return {
    amount: best.amount,
    compareAtAmount: compareAt !== null && compareAt > best.amount ? compareAt : null,
    tierPrices: [...tiers].sort((a, b) => a[0] - b[0]).map(([minQuantity, amount]) => ({ minQuantity, amount })),
  };
};

export const getPriceRows = async (db: Database, variantIds: readonly string[], channelId?: string) => {
  if (variantIds.length === 0) return [];
  const where = channelId
    ? and(inArray(variantPrices.variantId, [...variantIds]), eq(variantPrices.channelId, channelId))
    : inArray(variantPrices.variantId, [...variantIds]);
  return db.select().from(variantPrices).where(where);
};

export const resolveVariantPrices = async (
  db: Database,
  variantIds: readonly string[],
  ctx: PriceContext,
  quantities: Map<string, number> = new Map(),
): Promise<Map<string, ResolvedPrice>> => {
  const rows = await getPriceRows(db, variantIds, ctx.channelId);
  const byVariant = new Map<string, PriceRow[]>();
  for (const row of rows) byVariant.set(row.variantId, [...(byVariant.get(row.variantId) ?? []), row]);
  const result = new Map<string, ResolvedPrice>();
  let rate: number | null | undefined;
  for (const variantId of variantIds) {
    const variantRows = byVariant.get(variantId) ?? [];
    const quantity = quantities.get(variantId) ?? 1;
    const inCurrency = selectPrice(variantRows.filter((r) => r.currency === ctx.currency), ctx, quantity);
    if (inCurrency) {
      result.set(variantId, { ...inCurrency, currency: ctx.currency, converted: false });
      continue;
    }
    if (ctx.currency === ctx.defaultCurrency) continue;
    const base = selectPrice(variantRows.filter((r) => r.currency === ctx.defaultCurrency), ctx, quantity);
    if (!base) continue;
    rate ??= await getExchangeRate(db, ctx.defaultCurrency, ctx.currency);
    if (rate === null) continue;
    const c = (minor: number) => convert(minor, ctx.defaultCurrency, ctx.currency, rate!);
    result.set(variantId, {
      currency: ctx.currency,
      amount: c(base.amount),
      compareAtAmount: base.compareAtAmount === null ? null : c(base.compareAtAmount),
      tierPrices: base.tierPrices.map((t) => ({ minQuantity: t.minQuantity, amount: c(t.amount) })),
      converted: true,
    });
  }
  return result;
};
