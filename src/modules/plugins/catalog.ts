/** PluginServices.catalog: products as a guest sees them on the channel's storefront. */
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { isUuid } from "../../lib/ids.ts";
import type { CatalogScope, PluginProduct } from "../../plugins/sdk.ts";
import { resolveCustomerPricingGroup } from "../carts/quote.ts";
import {
  ancestorIdsFromPath,
  getCategoriesByIds,
  getCategoryIdsByProductIds,
  getCategoryTranslations,
  getListingsByProductIds,
  getMediaByProductIds,
  getProductsByIds,
  getProductTypesByIds,
  getTranslationsByProductIds,
  getVariantsByProductIds,
  listAttributeDefinitions,
  listProductIdsSoldIn,
} from "../catalog/read.ts";
import {
  formatAttributeValue,
  isSoldIn,
  isVariantAvailable,
  localizedText,
  pickTranslation,
  priceRange,
  productAttributes,
  variantName,
  variantOptions,
  type ViewLocale,
} from "../catalog/view.ts";
import { resolveScope, type ResolvedScope } from "../channels/service.ts";
import { channels } from "../channels/tables.ts";
import { getSalableQuantities } from "../inventory/stock.ts";
import { resolveVariantPrices } from "../pricing/resolve.ts";
import { storefrontUrlOf } from "./channels.ts";

const PAGE_SIZE = 100;

type Scope = ResolvedScope & { customerGroupId: string | null; storefrontUrl: string | null };

/** Storefront API rules for locale and currency. NotFoundError for unknown or inactive channels. */
const resolveCatalogScope = async (db: Database, scope: CatalogScope): Promise<Scope> => {
  const channel = isUuid(scope.channelId) ? await db.query.channels.findFirst({ where: eq(channels.id, scope.channelId) }) : undefined;
  if (!channel) throw new NotFoundError("Channel", scope.channelId);
  const resolved = await resolveScope(db, { channel: channel.code, locale: scope.locale, currency: scope.currency });
  const [guest, storefrontUrl] = await Promise.all([resolveCustomerPricingGroup(db, null), storefrontUrlOf(db, channel)]);
  return { ...resolved, customerGroupId: guest.groupId, storefrontUrl };
};

/** Those of `ids` sold in the channel, in the order given. */
const loadProducts = async (db: Database, ids: readonly string[], scope: Scope): Promise<PluginProduct[]> => {
  if (ids.length === 0) return [];
  const [rows, listings] = await Promise.all([getProductsByIds(db, ids), getListingsByProductIds(db, ids)]);
  const byId = new Map(rows.map((p) => [p.id, p]));
  const sold = ids.flatMap((id) => {
    const product = byId.get(id);
    return product && isSoldIn(product, listings.get(id) ?? [], scope.channel.id) ? [product] : [];
  });
  if (sold.length === 0) return [];

  const soldIds = sold.map((p) => p.id);
  const [translations, variantsByProduct, mediaByProduct, categoryIdsByProduct, types, definitions] = await Promise.all([
    getTranslationsByProductIds(db, soldIds),
    getVariantsByProductIds(db, soldIds),
    getMediaByProductIds(db, soldIds),
    getCategoryIdsByProductIds(db, soldIds),
    getProductTypesByIds(db, [...new Set(sold.map((p) => p.productTypeId))]),
    listAttributeDefinitions(db),
  ]);
  const typesById = new Map(types.map((t) => [t.id, t]));
  const defs = new Map(definitions.map((d) => [d.code, d]));
  const activeVariants = (productId: string) => (variantsByProduct.get(productId) ?? []).filter((v) => v.isActive);
  const variantIds = sold.flatMap((p) => activeVariants(p.id).map((v) => v.id));
  const [prices, salable] = await Promise.all([
    resolveVariantPrices(db, variantIds, {
      channelId: scope.channel.id,
      currency: scope.currency,
      defaultCurrency: scope.channel.defaultCurrency,
      customerGroupId: scope.customerGroupId,
      at: new Date(),
    }),
    getSalableQuantities(db, scope.channel.stockId, variantIds),
  ]);

  // A category's path holds the ids from the top down to itself.
  const productCategories = await getCategoriesByIds(db, [...new Set([...categoryIdsByProduct.values()].flat())]);
  const pathIds = [...new Set(productCategories.flatMap((c) => ancestorIdsFromPath(c.path)))];
  const categoryTranslations = await getCategoryTranslations(db, pathIds);
  const categoriesById = new Map(productCategories.map((c) => [c.id, c]));

  const view: ViewLocale = { locale: scope.locale, fallbackLocale: scope.channel.defaultLocale };
  const categoryText = (id: string) => pickTranslation(categoryTranslations.get(id) ?? [], view);

  return sold.map((product): PluginProduct => {
    const translation = pickTranslation(translations.get(product.id) ?? [], view);
    const slug = translation?.slug ?? product.id;
    const path = `/products/${slug}`;
    const type = typesById.get(product.productTypeId);
    const variants = activeVariants(product.id);
    const variantPrices = variants.map((v) => prices.get(v.id)).filter((p) => p !== undefined);
    const range = priceRange(variantPrices);
    const pluginVariants = variants.map((v) => {
      const price = prices.get(v.id) ?? null;
      const options = variantOptions(v, type?.variantAttributeCodes ?? [], defs, view);
      const quantity = salable.get(v.id) ?? 0;
      return {
        id: v.id,
        sku: v.sku,
        name: variantName(translation?.name ?? v.sku, options),
        barcode: v.barcode,
        weightGrams: v.weightGrams,
        options: options.map(({ attribute, name, value, label }) => ({ attribute, name, value, label })),
        price: price?.amount ?? null,
        compareAtPrice: price?.compareAtAmount ?? null,
        available: isVariantAvailable(v, quantity),
        quantityAvailable: v.trackInventory ? Math.max(0, quantity) : null,
      };
    });
    return {
      id: product.id,
      channelId: scope.channel.id,
      locale: scope.locale,
      currency: scope.currency,
      pricesIncludeTax: scope.channel.pricesIncludeTax,
      name: translation?.name ?? "",
      slug,
      description: translation?.description ?? null,
      seo: { title: translation?.metaTitle ?? translation?.name ?? null, description: translation?.metaDescription ?? null },
      path,
      url: scope.storefrontUrl ? `${scope.storefrontUrl}${path}` : null,
      visibleInListings: (listings.get(product.id) ?? []).find((l) => l.channelId === scope.channel.id)?.visibleInListings ?? true,
      productType: { code: type?.code ?? "", name: type?.name ?? "", isShippable: type?.isShippable ?? true },
      attributes: productAttributes(product, type?.attributeCodes ?? [], defs).map(({ def, raw }) => ({
        code: def.code,
        name: localizedText(def.label, view) ?? def.code,
        value: formatAttributeValue(def, raw, view),
        raw,
      })),
      categories: (categoryIdsByProduct.get(product.id) ?? []).flatMap((id) => {
        const category = categoriesById.get(id);
        if (!category?.isActive) return [];
        const ancestors = ancestorIdsFromPath(category.path);
        return [
          {
            id,
            name: categoryText(id)?.name ?? "",
            slug: categoryText(id)?.slug ?? id,
            path: ancestors.map((a) => categoryText(a)?.name ?? ""),
            slugPath: ancestors.map((a) => categoryText(a)?.slug ?? a).join("/"),
          },
        ];
      }),
      media: (mediaByProduct.get(product.id) ?? []).map((m) => ({ url: m.url, alt: localizedText(m.alt, view), kind: m.kind, variantId: m.variantId })),
      priceRange: range && { min: range.min, max: range.max, compareAtMin: range.compareAtMin },
      available: variants.some((v) => isVariantAvailable(v, salable.get(v.id) ?? 0)),
      variants: pluginVariants,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  });
};

export const getPluginProduct = async (db: Database, id: string, scope: CatalogScope): Promise<PluginProduct | null> => {
  const resolved = await resolveCatalogScope(db, scope);
  if (!isUuid(id)) return null;
  return (await loadProducts(db, [id], resolved))[0] ?? null;
};

export const listPluginProducts = async (db: Database, scope: CatalogScope & { first?: number; after?: string | null }) => {
  const first = Math.min(Math.max(Math.trunc(scope.first ?? PAGE_SIZE) || PAGE_SIZE, 1), PAGE_SIZE);
  if (scope.after && !isUuid(scope.after)) throw new ValidationError("Invalid cursor", [{ path: ["after"], message: "Pass the `next` of the previous page" }]);
  const resolved = await resolveCatalogScope(db, scope);
  const ids = await listProductIdsSoldIn(db, resolved.channel.id, { limit: first + 1, afterId: scope.after ?? null });
  const page = ids.slice(0, first);
  return { products: await loadProducts(db, page, resolved), next: ids.length > first ? page.at(-1)! : null };
};
