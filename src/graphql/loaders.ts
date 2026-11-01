import DataLoader from "dataloader";
import { asc, inArray } from "drizzle-orm";
import { categories } from "../modules/catalog/tables.ts";
import type { Database } from "../db/client.ts";
import type { ResolvedScope } from "../modules/channels/service.ts";
import { buildQuote, type Quote, type QuoteProviders } from "../modules/carts/quote.ts";
import {
  getCategoriesByIds,
  getCategoryIdsByProductIds,
  getCategoryTranslations,
  getListingsByProductIds,
  getMediaByProductIds,
  getProductsByIds,
  getProductTypesByIds,
  getTranslationsByProductIds,
  getVariantsByIds,
  getVariantsByProductIds,
  listAttributeDefinitions,
  type AttributeDefinition,
} from "../modules/catalog/read.ts";
import { customerAddresses, customerGroups, customers } from "../modules/customers/tables.ts";
import { getSalableQuantities, getStockLevelsByVariantIds } from "../modules/inventory/stock.ts";
import { getEventsByOrderIds, getFulfillmentsByOrderIds, getInvoicesByOrderIds, getLinesByOrderIds, getOrdersByIds, getRefundsByOrderIds } from "../modules/orders/read.ts";
import { getPriceRows, resolveVariantPrices, type ResolvedPrice } from "../modules/pricing/resolve.ts";
import { getCouponsByPromotionIds } from "../modules/promotions/service.ts";
import { promotions } from "../modules/promotions/tables.ts";

const byId = <T extends { id: string }>(load: (ids: readonly string[]) => Promise<T[]>) =>
  new DataLoader<string, T | null>(async (ids) => {
    const rows = new Map((await load(ids)).map((r) => [r.id, r]));
    return ids.map((id) => rows.get(id) ?? null);
  });

const grouped = <T>(load: (ids: readonly string[]) => Promise<Map<string, T[]>>) =>
  new DataLoader<string, T[]>(async (ids) => {
    const rows = await load(ids);
    return ids.map((id) => rows.get(id) ?? []);
  });

/** One set per request so every relation is batched (no N+1) and cached for the request only. */
export const createLoaders = (db: Database, scope: ResolvedScope, pricing: { customerGroupId: string | null }, providers?: QuoteProviders) => {
  let attributeDefinitions: Promise<Map<string, AttributeDefinition>> | undefined;
  return {
    product: byId((ids) => getProductsByIds(db, ids)),
    productTranslations: grouped((ids) => getTranslationsByProductIds(db, ids)),
    productVariants: grouped((ids) => getVariantsByProductIds(db, ids)),
    variant: byId((ids) => getVariantsByIds(db, ids)),
    productType: byId((ids) => getProductTypesByIds(db, ids)),
    productMedia: grouped((ids) => getMediaByProductIds(db, ids)),
    productCategoryIds: new DataLoader<string, string[]>(async (ids) => {
      const map = await getCategoryIdsByProductIds(db, ids);
      return ids.map((id) => map.get(id) ?? []);
    }),
    productListings: grouped((ids) => getListingsByProductIds(db, ids)),
    category: byId((ids) => getCategoriesByIds(db, ids)),
    categoryTranslations: grouped((ids) => getCategoryTranslations(db, ids)),
    categoryChildren: grouped(async (ids) => {
      const map = new Map<string, (typeof categories.$inferSelect)[]>();
      const rows = await db.select().from(categories).where(inArray(categories.parentId, [...ids])).orderBy(asc(categories.position), asc(categories.id));
      for (const row of rows) map.set(row.parentId!, [...(map.get(row.parentId!) ?? []), row]);
      return map;
    }),
    /** Price for the request's channel, currency and customer group at quantity 1. */
    price: new DataLoader<string, ResolvedPrice | null>(async (ids) => {
      const prices = await resolveVariantPrices(db, ids, {
        channelId: scope.channel.id,
        currency: scope.currency,
        defaultCurrency: scope.channel.defaultCurrency,
        customerGroupId: pricing.customerGroupId,
        at: new Date(),
      });
      return ids.map((id) => prices.get(id) ?? null);
    }),
    priceRows: grouped(async (ids) => {
      const map = new Map<string, Awaited<ReturnType<typeof getPriceRows>>>();
      for (const row of await getPriceRows(db, ids)) map.set(row.variantId, [...(map.get(row.variantId) ?? []), row]);
      return map;
    }),
    salable: new DataLoader<string, number>(async (ids) => {
      const map = await getSalableQuantities(db, scope.channel.stockId, ids);
      return ids.map((id) => map.get(id) ?? 0);
    }),
    stockLevels: grouped(async (ids) => {
      const map = new Map<string, Awaited<ReturnType<typeof getStockLevelsByVariantIds>>>();
      for (const row of await getStockLevelsByVariantIds(db, ids)) map.set(row.variantId, [...(map.get(row.variantId) ?? []), row]);
      return map;
    }),
    attributeDefinitions: () => (attributeDefinitions ??= listAttributeDefinitions(db).then((defs) => new Map(defs.map((d) => [d.code, d])))),
    customer: byId((ids) => db.select().from(customers).where(inArray(customers.id, [...ids]))),
    customerAddresses: grouped(async (ids) => {
      const map = new Map<string, (typeof customerAddresses.$inferSelect)[]>();
      for (const row of await db.select().from(customerAddresses).where(inArray(customerAddresses.customerId, [...ids])).orderBy(customerAddresses.id)) {
        map.set(row.customerId, [...(map.get(row.customerId) ?? []), row]);
      }
      return map;
    }),
    customerGroup: byId((ids) => db.select().from(customerGroups).where(inArray(customerGroups.id, [...ids]))),
    order: byId((ids) => getOrdersByIds(db, ids)),
    orderLines: grouped((ids) => getLinesByOrderIds(db, ids)),
    orderInvoices: grouped((ids) => getInvoicesByOrderIds(db, ids)),
    orderFulfillments: grouped((ids) => getFulfillmentsByOrderIds(db, ids)),
    orderRefunds: grouped((ids) => getRefundsByOrderIds(db, ids)),
    orderEvents: grouped((ids) => getEventsByOrderIds(db, ids)),
    promotion: byId((ids) => db.select().from(promotions).where(inArray(promotions.id, [...ids]))),
    coupons: grouped(async (ids) => {
      const map = new Map<string, Awaited<ReturnType<typeof getCouponsByPromotionIds>>>();
      for (const row of await getCouponsByPromotionIds(db, ids)) map.set(row.promotionId, [...(map.get(row.promotionId) ?? []), row]);
      return map;
    }),
    /** Priced cart. Cart mutations clear it so the payload reflects the new state. */
    quote: new DataLoader<string, Quote>((ids) => Promise.all(ids.map((id) => buildQuote(db, id, providers))), { batch: false }),
  };
};

export type Loaders = ReturnType<typeof createLoaders>;
