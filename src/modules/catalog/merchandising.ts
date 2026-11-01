import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { NotFoundError, ValidationError, type FieldError } from "../../lib/errors.ts";
import { parseInput } from "../../lib/validation.ts";
import { emit } from "../integrations/outbox.ts";
import { reindexProducts } from "../search/projector.ts";
import { getDescendantCategoryIds } from "./read.ts";
import { categories, categoryMerchandising, productCategories, products } from "./tables.ts";

export type MerchandisingItem = { productId: string; pinned: boolean; hidden: boolean };

export const MAX_PINNED_PRODUCTS = 250;

const merchandisingSchema = z.object({
  pinned: z.array(z.uuid()).max(MAX_PINNED_PRODUCTS),
  hidden: z.array(z.uuid()).max(1000),
});

const findCategory = async (db: Database, id: string) => {
  const category = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!category) throw new NotFoundError("Category", id);
  return category;
};

/**
 * Pinned products in order, then hidden ones, then the rest newest first (the FEATURED sort).
 * Includes subcategories' products, and drafts so they can be pinned before going live.
 */
export const getCategoryMerchandising = async (db: Database, categoryId: string, limit: number): Promise<{ items: MerchandisingItem[]; totalCount: number }> => {
  const category = await findCategory(db, categoryId);
  const assigned = db.select({ id: productCategories.productId }).from(productCategories).where(inArray(productCategories.categoryId, await getDescendantCategoryIds(db, category)));
  const inListing = and(inArray(products.id, assigned), ne(products.status, "archived"));
  const [rows, totalCount] = await Promise.all([
    db
      .select({ productId: products.id, pinPosition: categoryMerchandising.pinPosition, hidden: categoryMerchandising.hidden })
      .from(products)
      .leftJoin(categoryMerchandising, and(eq(categoryMerchandising.categoryId, categoryId), eq(categoryMerchandising.productId, products.id)))
      .where(inListing)
      .orderBy(sql`${categoryMerchandising.pinPosition} asc nulls last`, sql`coalesce(${categoryMerchandising.hidden}, false) desc`, desc(products.createdAt), desc(products.id))
      .limit(limit),
    db.$count(products, inListing),
  ]);
  return { items: rows.map((r) => ({ productId: r.productId, pinned: r.pinPosition !== null, hidden: r.hidden ?? false })), totalCount };
};

/**
 * Replace a category's pins and hides. Products named in neither go back to the automatic order.
 * Each must be in the category or a subcategory, and named once.
 */
export const setCategoryMerchandising = async (db: Database, categoryId: string, input: unknown): Promise<void> =>
  db.transaction(async (tx) => {
    const category = await findCategory(tx, categoryId);
    const data = parseInput(merchandisingSchema, input);
    const named = [
      ...data.pinned.map((id, i) => ({ id, path: ["input", "pinned", String(i)] })),
      ...data.hidden.map((id, i) => ({ id, path: ["input", "hidden", String(i)] })),
    ];
    const ids = [...new Set(named.map((n) => n.id))];
    const assigned = ids.length
      ? await tx
          .select({ id: productCategories.productId })
          .from(productCategories)
          .where(and(inArray(productCategories.productId, ids), inArray(productCategories.categoryId, await getDescendantCategoryIds(tx, category))))
      : [];
    const inListing = new Set(assigned.map((r) => r.id));
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    for (const { id, path } of named) {
      if (seen.has(id)) errors.push({ path, message: "Named twice: a product is pinned or hidden, once" });
      else if (!inListing.has(id)) errors.push({ path, message: "Not in this category or a category below it" });
      seen.add(id);
    }
    if (errors.length) throw new ValidationError("The merchandising is invalid", errors);

    const previous = await tx.select({ productId: categoryMerchandising.productId }).from(categoryMerchandising).where(eq(categoryMerchandising.categoryId, categoryId));
    await tx.delete(categoryMerchandising).where(eq(categoryMerchandising.categoryId, categoryId));
    const rows = [
      ...data.pinned.map((productId, pinPosition) => ({ categoryId, productId, pinPosition, hidden: false })),
      ...data.hidden.map((productId) => ({ categoryId, productId, pinPosition: null, hidden: true })),
    ];
    if (rows.length) await tx.insert(categoryMerchandising).values(rows);
    // Listings read pins and hides from the search projection.
    await reindexProducts(tx, [...previous.map((r) => r.productId), ...ids]);
    await emit(tx, { type: "category.updated", aggregateType: "Category", aggregateId: categoryId });
  });
