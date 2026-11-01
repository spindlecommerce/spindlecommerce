import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { InvalidStateError } from "../../lib/errors.ts";
import type { LocalizedText } from "../../lib/i18n.ts";
import { loadDefinitions } from "./components.ts";
import { emptyNode, type PageDocument, type TemplateFor } from "./model.ts";
import type { Actor, BuilderPage } from "./pages.ts";
import { builderPages } from "./tables.ts";

/** A product's or category's own sections: a builder page it owns, shown inside its template. */

export type SectionsOwner = { productId: string } | { categoryId: string };

export const sectionsKind = (owner: SectionsOwner): TemplateFor => ("productId" in owner ? "product" : "category");

/** The product or category whose sections a page holds; null for other pages. */
export const sectionsOwner = (page: Pick<BuilderPage, "productId" | "categoryId">): SectionsOwner | null =>
  page.productId ? { productId: page.productId } : page.categoryId ? { categoryId: page.categoryId } : null;

const belongsTo = (owner: SectionsOwner) => ("productId" in owner ? eq(builderPages.productId, owner.productId) : eq(builderPages.categoryId, owner.categoryId));

export const findSections = async (db: Database, owner: SectionsOwner): Promise<BuilderPage | null> =>
  (await db.query.builderPages.findFirst({ where: belongsTo(owner) })) ?? null;

/** The owner's sections page, created as an empty draft titled `label` if it has none. */
export const ensureSections = async (db: Database, owner: SectionsOwner, label: { name: string; locale: string }, actor: Actor): Promise<BuilderPage> =>
  db.transaction(async (tx) => {
    const existing = await findSections(tx, owner);
    if (existing) return existing;
    const kind = sectionsKind(owner);
    const type = [...(await loadDefinitions(tx)).values()].find((d) => d.kind === "content_type" && d.sectionsFor === kind);
    if (!type) throw new InvalidStateError(`The component library has no content type for ${kind} sections; add one that holds sections for ${kind}s`);
    const title: LocalizedText = { [label.locale]: label.name };
    const draft: PageDocument = { title, path: null, seo: {}, root: emptyNode(type, "root") };
    // Two editors adding sections at once: the second gets the first one's page.
    const [page] = await tx
      .insert(builderPages)
      .values({ type: type.code, path: null, title, channelIds: [], draft, draftUpdatedBy: actor.staffId, ...owner })
      .onConflictDoNothing()
      .returning();
    return page ?? (await findSections(tx, owner))!;
  });
