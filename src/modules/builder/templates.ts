import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, notInArray, or, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import type { LocalizedText } from "../../lib/i18n.ts";
import { ancestorIdsFromPath } from "../catalog/read.ts";
import { categories, productCategories, products } from "../catalog/tables.ts";
import { emit } from "../integrations/outbox.ts";
import { loadDefinitions } from "./components.ts";
import { emptyNode, type PageDocument, type TemplateFor } from "./model.ts";
// Types only, to avoid an import cycle with pages.ts.
import type { Actor, BuilderPage } from "./pages.ts";
import { builderComponents, builderPages, builderTemplateTargets as targets } from "./tables.ts";

/** Product and category templates: builder pages whose content type has `templateFor`. */

export type TemplateTargets = { isDefault: boolean; productIds: string[]; categoryIds: string[] };
export type TemplateSource = "product" | "category" | "default";
export type TemplateMatch = { page: BuilderPage; source: TemplateSource; categoryId: string | null };
export type TemplateTarget = { productId: string } | { categoryId: string };

export type FindTemplateOptions = {
  /** Include never-published templates (the admin, previews). */
  drafts: boolean;
  /** Leave out templates restricted to other channels. */
  channelId?: string | null;
};

const DEFAULT_TARGET = and(isNull(targets.productId), isNull(targets.categoryId))!;

/** What pages of a content type are a template for, or null for ordinary pages. */
export const templateForType = async (db: Database, type: string): Promise<TemplateFor | null> =>
  (await db.select({ templateFor: builderComponents.templateFor }).from(builderComponents).where(eq(builderComponents.code, type)))[0]?.templateFor ?? null;

/** Newest first, so a draft waiting to take a target over comes before the template that has it. */
const candidates = (db: Database, templateFor: TemplateFor, where: SQL | undefined) =>
  db
    .select({ target: targets, page: builderPages })
    .from(targets)
    .innerJoin(builderPages, eq(builderPages.id, targets.pageId))
    .where(and(eq(targets.templateFor, templateFor), where))
    .orderBy(desc(targets.createdAt), desc(targets.id));

const usable = (page: BuilderPage, options: FindTemplateOptions) =>
  (options.drafts || page.published !== null) && (!options.channelId || page.channelIds.length === 0 || page.channelIds.includes(options.channelId));

/** The product's categories and every ancestor, with what ranks them: deeper is more specific. */
const categoriesAround = async (db: Database, productId: string) => {
  const assigned = await db.select({ path: categories.path }).from(productCategories).innerJoin(categories, eq(categories.id, productCategories.categoryId)).where(eq(productCategories.productId, productId));
  const ids = [...new Set(assigned.flatMap((c) => ancestorIdsFromPath(c.path)))];
  return ids.length ? db.select({ id: categories.id, depth: categories.depth, position: categories.position }).from(categories).where(inArray(categories.id, ids)) : [];
};

/** Its own template, else its deepest category's (ancestors included), else the default. */
export const findProductTemplate = async (db: Database, productId: string, options: FindTemplateOptions): Promise<TemplateMatch | null> => {
  const around = await categoriesAround(db, productId);
  const rows = (await candidates(db, "product", or(eq(targets.productId, productId), around.length ? inArray(targets.categoryId, around.map((c) => c.id)) : undefined, DEFAULT_TARGET))).filter((r) => usable(r.page, options));
  const own = rows.find((r) => r.target.productId === productId);
  if (own) return { page: own.page, source: "product", categoryId: null };
  const rank = new Map(around.map((c) => [c.id, c]));
  const nearest = rows
    .flatMap((r) => (r.target.categoryId && rank.has(r.target.categoryId) ? [{ row: r, category: rank.get(r.target.categoryId)! }] : []))
    // Array.sort is stable, so for the same category the newest assignment stays first.
    .sort((a, b) => b.category.depth - a.category.depth || a.category.position - b.category.position || a.category.id.localeCompare(b.category.id))[0];
  if (nearest) return { page: nearest.row.page, source: "category", categoryId: nearest.category.id };
  const fallback = rows.find((r) => !r.target.productId && !r.target.categoryId);
  return fallback ? { page: fallback.page, source: "default", categoryId: null } : null;
};

export const findCategoryTemplate = async (db: Database, categoryId: string, options: FindTemplateOptions): Promise<TemplateMatch | null> => {
  const rows = (await candidates(db, "category", or(eq(targets.categoryId, categoryId), DEFAULT_TARGET))).filter((r) => usable(r.page, options));
  const own = rows.find((r) => r.target.categoryId === categoryId);
  if (own) return { page: own.page, source: "category", categoryId };
  const fallback = rows.find((r) => !r.target.categoryId);
  return fallback ? { page: fallback.page, source: "default", categoryId: null } : null;
};

const toTargets = (rows: (typeof targets.$inferSelect)[]): TemplateTargets => ({
  isDefault: rows.some((r) => !r.productId && !r.categoryId),
  productIds: rows.flatMap((r) => (r.productId ? [r.productId] : [])),
  categoryIds: rows.flatMap((r) => (r.categoryId ? [r.categoryId] : [])),
});

export const NO_TARGETS: TemplateTargets = { isDefault: false, productIds: [], categoryIds: [] };

/** Every template's assignments by page id, oldest first. */
export const templateTargetsByPage = async (db: Database) => {
  const rows = await db.select().from(targets).orderBy(asc(targets.createdAt), asc(targets.id));
  const byPage = new Map<string, (typeof targets.$inferSelect)[]>();
  for (const row of rows) byPage.set(row.pageId, [...(byPage.get(row.pageId) ?? []), row]);
  return new Map([...byPage].map(([pageId, list]) => [pageId, toTargets(list)]));
};

const templatePage = async (db: Database, pageId: string) => {
  const page = await db.query.builderPages.findFirst({ where: eq(builderPages.id, pageId) });
  if (!page) throw new NotFoundError("Page", pageId);
  const templateFor = await templateForType(db, page.type);
  if (!templateFor) throw new InvalidStateError("Only product and category templates are assigned; this page has its own path");
  return { page, templateFor };
};

const assertExist = async (db: Database, table: typeof products | typeof categories, ids: string[], key: "productIds" | "categoryIds") => {
  if (!ids.length) return;
  const found = new Set((await db.select({ id: table.id }).from(table).where(inArray(table.id, ids))).map((r) => r.id));
  const missing = ids.flatMap((id, i) => (found.has(id) ? [] : [{ path: ["input", key, String(i)], message: `No ${key === "productIds" ? "product" : "category"} ${id}` }]));
  if (missing.length) throw new ValidationError(key === "productIds" ? "Unknown products" : "Unknown categories", missing);
};

/** A published template takes its targets from the other templates of its kind. */
export const claimTemplateTargets = async (db: Database, pageId: string, templateFor: TemplateFor) => {
  const { isDefault, productIds, categoryIds } = toTargets(await db.select().from(targets).where(eq(targets.pageId, pageId)));
  const others = and(eq(targets.templateFor, templateFor), ne(targets.pageId, pageId));
  if (isDefault) await db.delete(targets).where(and(others, DEFAULT_TARGET));
  if (productIds.length) await db.delete(targets).where(and(others, inArray(targets.productId, productIds)));
  if (categoryIds.length) await db.delete(targets).where(and(others, inArray(targets.categoryId, categoryIds)));
};

/**
 * Omitted keys stay as they are; lists replace the current ones. A published template takes its
 * targets at once, a draft one when it is published.
 */
export const setTemplateTargets = async (db: Database, pageId: string, input: Partial<TemplateTargets>) =>
  db.transaction(async (tx) => {
    const { page, templateFor } = await templatePage(tx, pageId);
    const productIds = input.productIds ? [...new Set(input.productIds)] : undefined;
    const categoryIds = input.categoryIds ? [...new Set(input.categoryIds)] : undefined;
    if (templateFor === "category" && productIds?.length) {
      throw new ValidationError("Category templates render category pages", [{ path: ["input", "productIds"], message: "Assign a category template to categories, or use a product template for products" }]);
    }
    await assertExist(tx, products, productIds ?? [], "productIds");
    await assertExist(tx, categories, categoryIds ?? [], "categoryIds");

    if (input.isDefault === true) await tx.insert(targets).values({ pageId, templateFor }).onConflictDoNothing();
    else if (input.isDefault === false) await tx.delete(targets).where(and(eq(targets.pageId, pageId), DEFAULT_TARGET));
    type Row = typeof targets.$inferInsert;
    for (const [ids, column, toRow] of [
      [productIds, targets.productId, (id: string): Row => ({ pageId, templateFor, productId: id })],
      [categoryIds, targets.categoryId, (id: string): Row => ({ pageId, templateFor, categoryId: id })],
    ] as const) {
      if (!ids) continue;
      await tx.delete(targets).where(and(eq(targets.pageId, pageId), isNotNull(column), ids.length ? notInArray(column, ids) : undefined));
      if (ids.length) await tx.insert(targets).values(ids.map(toRow)).onConflictDoNothing();
    }
    if (page.published) await claimTemplateTargets(tx, pageId, templateFor);
    await emit(tx, { type: "page.targets_updated", aggregateType: "Page", aggregateId: pageId, payload: { type: page.type, templateFor } });
    return page;
  });

/**
 * Give a product or category its own template: a draft copy of its current one, or an empty one.
 * If it already has its own, returns that.
 */
export const customizeTemplate = async (db: Database, target: TemplateTarget, label: { name: string; locale: string }, actor: Actor) =>
  db.transaction(async (tx) => {
    const templateFor: TemplateFor = "productId" in target ? "product" : "category";
    const match = "productId" in target ? await findProductTemplate(tx, target.productId, { drafts: true }) : await findCategoryTemplate(tx, target.categoryId, { drafts: true });
    if (match && match.source === templateFor) return match.page;
    const components = await loadDefinitions(tx);
    const type = match?.page.type ?? [...components.values()].find((d) => d.kind === "content_type" && d.templateFor === templateFor)?.code;
    if (!type) throw new InvalidStateError(`The component library has no ${templateFor} template; add a content type that is a template for ${templateFor}s`);
    const base = match?.page.draft;
    const titled = Object.entries(base?.title ?? {}).filter(([, text]) => text.trim());
    const title: LocalizedText = titled.length ? Object.fromEntries(titled.map(([locale, text]) => [locale, `${text} · ${label.name}`])) : { [label.locale]: label.name };
    const draft: PageDocument = base ? { ...base, title, path: null } : { title, path: null, seo: {}, root: emptyNode(components.get(type)!, "root") };
    const [page] = await tx
      .insert(builderPages)
      .values({ type, path: null, title, channelIds: match?.page.channelIds ?? [], draft, draftUpdatedBy: actor.staffId })
      .returning();
    // Unclaimed until the draft is published.
    await tx.insert(targets).values({ pageId: page!.id, templateFor, ...target });
    await emit(tx, { type: "page.targets_updated", aggregateType: "Page", aggregateId: page!.id, payload: { type, templateFor } });
    return page!;
  });

/** A product or category to preview a template with: one it is assigned to, else any active one. */
export const templatePreviewTarget = async (db: Database, pageId: string, templateFor: TemplateFor): Promise<TemplateTarget | null> => {
  const own = await db.select().from(targets).where(eq(targets.pageId, pageId)).orderBy(asc(targets.createdAt), asc(targets.id));
  if (templateFor === "category") {
    const assigned = own.find((r) => r.categoryId);
    if (assigned) return { categoryId: assigned.categoryId! };
    const [first] = await db.select({ id: categories.id }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.depth), asc(categories.position)).limit(1);
    return first ? { categoryId: first.id } : null;
  }
  const assigned = own.find((r) => r.productId);
  if (assigned) return { productId: assigned.productId! };
  const viaCategory = own.find((r) => r.categoryId);
  if (viaCategory) {
    const [category] = await db.select({ path: categories.path }).from(categories).where(eq(categories.id, viaCategory.categoryId!));
    const [inside] = category
      ? await db
          .select({ id: products.id })
          .from(productCategories)
          .innerJoin(categories, eq(categories.id, productCategories.categoryId))
          .innerJoin(products, eq(products.id, productCategories.productId))
          .where(and(like(categories.path, `${category.path}%`), eq(products.status, "active")))
          .orderBy(asc(productCategories.position), desc(products.createdAt))
          .limit(1)
      : [];
    if (inside) return { productId: inside.id };
  }
  const [newest] = await db.select({ id: products.id }).from(products).where(eq(products.status, "active")).orderBy(desc(products.createdAt)).limit(1);
  return newest ? { productId: newest.id } : null;
};

/** The template a preview is editing, if it still exists and renders this kind of page. */
export const previewTemplate = async (db: Database, pageId: string, templateFor: TemplateFor) => {
  const page = await db.query.builderPages.findFirst({ where: eq(builderPages.id, pageId) });
  return page && (await templateForType(db, page.type)) === templateFor ? page : null;
};
