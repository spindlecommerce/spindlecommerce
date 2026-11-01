import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type FieldError } from "../../lib/errors.ts";
import type { LocalizedText } from "../../lib/i18n.ts";
import { redirects } from "../catalog/tables.ts";
import { emit } from "../integrations/outbox.ts";
import { loadDefinitions } from "./components.ts";
import { emptyNode, normalizePath, pathProblem, validateDocument, type ComponentDefinition, type PageDocument, type ValidationIssue } from "./model.ts";
import { sectionsOwner } from "./sections.ts";
import { builderComponents, builderPages, builderPageVersions } from "./tables.ts";
import { claimTemplateTargets } from "./templates.ts";

export type BuilderPage = typeof builderPages.$inferSelect;
export type PageVersion = typeof builderPageVersions.$inferSelect;
export type PageStatus = "draft" | "published" | "changed" | "scheduled";
export type Actor = { staffId: string | null };

export const pageStatus = (page: BuilderPage): PageStatus => {
  if (page.scheduledAt) return "scheduled";
  if (page.publishedVersion == null) return "draft";
  return page.version > page.publishedVersion ? "changed" : "published";
};

/** Autosaves keep a restorable checkpoint at most this often. */
const CHECKPOINT_MS = 10 * 60_000;
const MAX_VERSIONS = 100;

const toFieldErrors = (issues: ValidationIssue[], prefix: string[] = []): FieldError[] => issues.map((i) => ({ path: [...prefix, ...i.path], message: i.message }));

/** What a template renders, or whose sections these are, so frontends know what to expire. */
const kindPayload = async (db: Database, page: Pick<BuilderPage, "type" | "productId" | "categoryId">, components?: Map<string, ComponentDefinition>) => {
  const definition = components
    ? components.get(page.type)
    : (await db.select({ templateFor: builderComponents.templateFor, sectionsFor: builderComponents.sectionsFor }).from(builderComponents).where(eq(builderComponents.code, page.type)))[0];
  if (definition?.templateFor) return { templateFor: definition.templateFor };
  if (definition?.sectionsFor) return { sectionsFor: definition.sectionsFor, ...sectionsOwner(page) };
  return {};
};

export const getPage = async (db: Database, id: string) => {
  const page = await db.query.builderPages.findFirst({ where: eq(builderPages.id, id) });
  if (!page) throw new NotFoundError("Page", id);
  return page;
};

const definitionFor = (components: Map<string, ComponentDefinition>, type: string) => {
  const definition = components.get(type);
  if (!definition || definition.kind !== "content_type") throw new ValidationError("Unknown content type", [{ path: ["input", "type"], message: `No content type ${type}` }]);
  return definition;
};

/** A path is taken when another page drafts or serves it. */
const assertPathFree = async (db: Database, path: string | null, exceptId: string | null, at: string[]) => {
  if (!path) return;
  const taken = await db
    .select({ id: builderPages.id })
    .from(builderPages)
    .where(and(or(eq(builderPages.path, path), eq(builderPages.publishedPath, path)), exceptId ? ne(builderPages.id, exceptId) : undefined))
    .limit(1);
  if (taken.length) throw new ValidationError("Path taken", [{ path: at, message: `Another page uses ${path}` }]);
};

const prepareDocument = (input: unknown, page: { type: string }, components: Map<string, ComponentDefinition>, mode: "draft" | "publish", prefix: string[]) => {
  const candidate = input && typeof input === "object" && typeof (input as { path?: unknown }).path === "string" ? { ...(input as object), path: normalizePath((input as { path: string }).path) } : input;
  const { document, issues } = validateDocument(candidate, { components, pageType: page.type, mode });
  if (!document) throw new ValidationError(mode === "publish" ? "The page is not ready to publish" : "The page document is invalid", toFieldErrors(issues, prefix));
  return document;
};

export type CreatePageInput = { type: string; title: LocalizedText; path?: string | null; channelIds?: string[] };

export const createPage = async (db: Database, input: CreatePageInput, actor: Actor) =>
  db.transaction(async (tx) => {
    const components = await loadDefinitions(tx);
    const definition = definitionFor(components, input.type);
    if (definition.sectionsFor) throw new InvalidStateError(`${definition.name} belong to one ${definition.sectionsFor}: add them from the ${definition.sectionsFor}'s screen`);
    if (definition.singleton && (await tx.$count(builderPages, eq(builderPages.type, definition.code)))) {
      throw new InvalidStateError(`There is already a ${definition.name}; there can only be one`);
    }
    const path = definition.routable === false ? null : normalizePath(input.path ?? "");
    if (definition.routable !== false) {
      const problem = pathProblem(path!);
      if (problem) throw new ValidationError("Invalid path", [{ path: ["input", "path"], message: problem }]);
    }
    await assertPathFree(tx, path, null, ["input", "path"]);
    const draft: PageDocument = { title: input.title, path, seo: {}, root: emptyNode(definition, "root") };
    prepareDocument(draft, { type: definition.code }, components, "draft", ["input"]);
    const [page] = await tx
      .insert(builderPages)
      .values({ type: definition.code, path, title: input.title, channelIds: input.channelIds ?? [], draft, draftUpdatedBy: actor.staffId })
      .returning();
    return page!;
  });

/** Refused if the page moved past `baseVersion`, the version the editor loaded. */
export const savePageDraft = async (db: Database, id: string, input: { baseVersion: number; document: unknown }, actor: Actor) =>
  db.transaction(async (tx) => {
    // Row lock: two saves of the same page queue up instead of both passing the version check.
    const [page] = await tx.select().from(builderPages).where(eq(builderPages.id, id)).for("update");
    if (!page) throw new NotFoundError("Page", id);
    if (page.version !== input.baseVersion) throw new ConflictError(`The page changed since you opened it (version ${page.version}, yours ${input.baseVersion}); reload to see the latest`);
    const components = await loadDefinitions(tx);
    const document = prepareDocument(input.document, page, components, "draft", ["document"]);
    await assertPathFree(tx, document.path, id, ["document", "path"]);
    const now = new Date();
    const [updated] = await tx
      .update(builderPages)
      .set({ draft: document, path: document.path, title: document.title, version: page.version + 1, draftUpdatedAt: now, draftUpdatedBy: actor.staffId, updatedAt: now })
      .where(eq(builderPages.id, id))
      .returning();
    const [last] = await tx.select({ createdAt: builderPageVersions.createdAt }).from(builderPageVersions).where(eq(builderPageVersions.pageId, id)).orderBy(desc(builderPageVersions.createdAt)).limit(1);
    if (!last || now.getTime() - last.createdAt.getTime() > CHECKPOINT_MS) await recordVersion(tx, updated!, "autosave", actor);
    return updated!;
  });

const recordVersion = async (db: Database, page: BuilderPage, kind: PageVersion["kind"], actor: Actor, label?: string | null) => {
  await db.insert(builderPageVersions).values({ pageId: page.id, version: page.version, kind, document: page.draft, label: label ?? null, createdBy: actor.staffId });
  // Keep history bounded; publishes and labelled saves outlive autosaves.
  await db.execute(sql`
    delete from ${builderPageVersions} where ${builderPageVersions.id} in (
      select id from ${builderPageVersions}
      where ${builderPageVersions.pageId} = ${page.id} and ${builderPageVersions.kind} = 'autosave'
      order by ${builderPageVersions.createdAt} desc offset ${MAX_VERSIONS}
    )`);
};

/** Validate and publish inside the caller's transaction. */
export const publishPageInTransaction = async (tx: Database, page: BuilderPage, components: Map<string, ComponentDefinition>, actor: Actor, prefix: string[] = []) => {
  const document = prepareDocument(page.draft, page, components, "publish", prefix);
  if (document.path) {
    const taken = await tx.select({ id: builderPages.id }).from(builderPages).where(and(eq(builderPages.publishedPath, document.path), ne(builderPages.id, page.id))).limit(1);
    if (taken.length) throw new ValidationError("Path taken", [{ path: [...prefix, "path"], message: `Another published page is served at ${document.path}` }]);
  }
  const previousPath = page.publishedPath;
  const now = new Date();
  const [published] = await tx
    .update(builderPages)
    .set({
      published: document,
      publishedPath: document.path,
      publishedVersion: page.version,
      publishedAt: now,
      publishedBy: actor.staffId,
      firstPublishedAt: page.firstPublishedAt ?? now,
      scheduledAt: null,
      scheduleError: null,
      updatedAt: now,
    })
    .where(eq(builderPages.id, page.id))
    .returning();
  // Redirect the previous path so old links keep working.
  if (previousPath && document.path && previousPath !== document.path) {
    await tx.delete(redirects).where(eq(redirects.fromPath, document.path));
    const existing = await tx.query.redirects.findFirst({ where: eq(redirects.fromPath, previousPath) });
    if (existing) await tx.update(redirects).set({ toPath: document.path }).where(eq(redirects.id, existing.id));
    else await tx.insert(redirects).values({ fromPath: previousPath, toPath: document.path, statusCode: 301 });
  }
  // A template takes over what it was assigned while it was a draft.
  const templateFor = components.get(page.type)?.templateFor;
  if (templateFor) await claimTemplateTargets(tx, page.id, templateFor);
  await recordVersion(tx, published!, "publish", actor);
  await emit(tx, { type: "page.published", aggregateType: "Page", aggregateId: page.id, payload: { type: page.type, path: document.path, previousPath, ...(await kindPayload(tx, page, components)) } });
  return published!;
};

export const publishPage = async (db: Database, id: string, actor: Actor, options: { version?: number | null } = {}) =>
  db.transaction(async (tx) => {
    const page = await getPage(tx, id);
    if (options.version != null && options.version !== page.version) throw new ConflictError(`The page changed since you opened it (version ${page.version}, yours ${options.version}); reload before publishing`);
    return publishPageInTransaction(tx, page, await loadDefinitions(tx), actor);
  });

export const unpublishPage = async (db: Database, id: string, actor: Actor) =>
  db.transaction(async (tx) => {
    const page = await getPage(tx, id);
    if (!page.published) throw new InvalidStateError("The page is not published");
    const [row] = await tx
      .update(builderPages)
      .set({ published: null, publishedPath: null, publishedVersion: null, publishedAt: null, publishedBy: actor.staffId, scheduledAt: null, updatedAt: new Date() })
      .where(eq(builderPages.id, id))
      .returning();
    await emit(tx, { type: "page.unpublished", aggregateType: "Page", aggregateId: id, payload: { type: page.type, path: page.publishedPath, ...(await kindPayload(tx, page)) } });
    return row!;
  });

/** Reset the draft to the published version. */
export const discardPageDraft = async (db: Database, id: string, actor: Actor) =>
  db.transaction(async (tx) => {
    const page = await getPage(tx, id);
    if (!page.published) throw new InvalidStateError("The page has never been published; delete it instead");
    // The discarded draft stays in history, so discarding can be undone.
    if (page.version !== page.publishedVersion) await recordVersion(tx, page, "save", actor, "Before discarding changes");
    const [row] = await tx
      .update(builderPages)
      .set({ draft: page.published, path: page.published.path, title: page.published.title, version: page.version + 1, publishedVersion: page.version + 1, draftUpdatedAt: new Date(), draftUpdatedBy: actor.staffId, updatedAt: new Date() })
      .where(eq(builderPages.id, id))
      .returning();
    return row!;
  });

export const schedulePage = async (db: Database, id: string, at: Date | null, actor: Actor) =>
  db.transaction(async (tx) => {
    const page = await getPage(tx, id);
    if (at) {
      if (at.getTime() <= Date.now()) throw new ValidationError("Schedule in the future", [{ path: ["at"], message: "Pick a time in the future, or publish now" }]);
      // Fail now rather than at the scheduled time.
      prepareDocument(page.draft, page, await loadDefinitions(tx), "publish", []);
    }
    const [row] = await tx.update(builderPages).set({ scheduledAt: at, scheduleError: null, draftUpdatedBy: actor.staffId, updatedAt: new Date() }).where(eq(builderPages.id, id)).returning();
    return row!;
  });

export const deletePage = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const page = await getPage(tx, id);
    await tx.delete(builderPages).where(eq(builderPages.id, id));
    if (page.published) await emit(tx, { type: "page.unpublished", aggregateType: "Page", aggregateId: id, payload: { type: page.type, path: page.publishedPath, deleted: true, ...(await kindPayload(tx, page)) } });
    return id;
  });

/** Copy a page as a new draft at a free path ("/sale" → "/sale-copy", "/sale-copy-2"…). */
export const duplicatePage = async (db: Database, id: string, actor: Actor) =>
  db.transaction(async (tx) => {
    const source = await getPage(tx, id);
    const components = await loadDefinitions(tx);
    const definition = definitionFor(components, source.type);
    if (definition.singleton) throw new InvalidStateError(`There can only be one ${definition.name}`);
    if (definition.sectionsFor) throw new InvalidStateError(`${definition.name} belong to one ${definition.sectionsFor} and cannot be copied`);
    let path: string | null = null;
    if (source.draft.path) {
      const base = source.draft.path === "/" ? "/home" : source.draft.path;
      for (let n = 1; ; n++) {
        const candidate = `${base}-copy${n > 1 ? `-${n}` : ""}`;
        const taken = await tx.select({ id: builderPages.id }).from(builderPages).where(or(eq(builderPages.path, candidate), eq(builderPages.publishedPath, candidate))).limit(1);
        if (!taken.length) {
          path = candidate;
          break;
        }
      }
    }
    const title = Object.fromEntries(Object.entries(source.draft.title).map(([locale, text]) => [locale, `${text} (copy)`]));
    const draft: PageDocument = { ...source.draft, title, path };
    const [page] = await tx.insert(builderPages).values({ type: source.type, path, title, channelIds: source.channelIds, draft, draftUpdatedBy: actor.staffId }).returning();
    return page!;
  });

export const updatePageSettings = async (db: Database, id: string, input: { channelIds?: string[] }) => {
  const [row] = await db.update(builderPages).set({ ...(input.channelIds ? { channelIds: input.channelIds } : {}), updatedAt: new Date() }).where(eq(builderPages.id, id)).returning();
  if (!row) throw new NotFoundError("Page", id);
  return row;
};

export const listPageVersions = (db: Database, pageId: string) =>
  db.select().from(builderPageVersions).where(eq(builderPageVersions.pageId, pageId)).orderBy(desc(builderPageVersions.createdAt)).limit(MAX_VERSIONS * 2);

/** Name the current draft so it survives autosave pruning. */
export const savePageVersion = async (db: Database, pageId: string, label: string | null, actor: Actor) => {
  const page = await getPage(db, pageId);
  await recordVersion(db, page, "save", actor, label);
  return page;
};

/** Load an old version into the draft (publish to make it live). */
export const restorePageVersion = async (db: Database, pageId: string, versionId: string, actor: Actor) =>
  db.transaction(async (tx) => {
    const page = await getPage(tx, pageId);
    const version = await tx.query.builderPageVersions.findFirst({ where: and(eq(builderPageVersions.id, versionId), eq(builderPageVersions.pageId, pageId)) });
    if (!version) throw new NotFoundError("PageVersion", versionId);
    const components = await loadDefinitions(tx);
    // Old versions may use fields or components that changed since.
    const document = prepareDocument(version.document, page, components, "draft", ["version"]);
    await assertPathFree(tx, document.path, pageId, ["version", "path"]);
    // The draft being replaced stays in history, so restoring can be undone.
    await recordVersion(tx, page, "save", actor, `Before restoring ${version.label ?? `version ${version.version}`}`);
    const [row] = await tx
      .update(builderPages)
      .set({ draft: document, path: document.path, title: document.title, version: page.version + 1, draftUpdatedAt: new Date(), draftUpdatedBy: actor.staffId, updatedAt: new Date() })
      .where(eq(builderPages.id, pageId))
      .returning();
    await recordVersion(tx, row!, "restore", actor, `Restored ${version.label ?? `version ${version.version}`}`);
    return row!;
  });

export type PageFilter = { query?: string | null; type?: string | null; status?: PageStatus | null; publishedOnly?: boolean; sort?: "path" | "updated" | null };

/** Leaves out sections pages: they are reached from their product or category. */
export const listPages = async (db: Database, filter: PageFilter, page: { limit: number; offset: number }) => {
  const conditions: SQL[] = [isNull(builderPages.productId), isNull(builderPages.categoryId)];
  if (filter.type) conditions.push(eq(builderPages.type, filter.type));
  if (filter.publishedOnly) conditions.push(isNotNull(builderPages.published));
  if (filter.query?.trim()) {
    const pattern = `%${filter.query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(builderPages.path, pattern), sql`${builderPages.title}::text ilike ${pattern}`)!);
  }
  if (filter.status === "draft") conditions.push(isNull(builderPages.publishedVersion), isNull(builderPages.scheduledAt));
  if (filter.status === "published") conditions.push(sql`${builderPages.version} = ${builderPages.publishedVersion}`, isNull(builderPages.scheduledAt));
  if (filter.status === "changed") conditions.push(sql`${builderPages.version} > ${builderPages.publishedVersion}`, isNull(builderPages.scheduledAt));
  if (filter.status === "scheduled") conditions.push(isNotNull(builderPages.scheduledAt));
  const where = and(...conditions);
  const pathColumn = filter.publishedOnly ? builderPages.publishedPath : builderPages.path;
  const order =
    filter.sort === "updated"
      ? [desc(filter.publishedOnly ? builderPages.publishedAt : builderPages.draftUpdatedAt), asc(builderPages.id)]
      : [sql`${pathColumn} asc nulls last`, asc(builderPages.type), asc(builderPages.id)];
  const rows = await db.select().from(builderPages).where(where).orderBy(...order).limit(page.limit).offset(page.offset);
  return { rows, total: await db.$count(builderPages, where) };
};

/** The published page at a path; in preview, the draft at that path first. */
export const findPageByPath = async (db: Database, path: string, options: { preview: boolean }) => {
  const normalized = normalizePath(path);
  if (options.preview) {
    const draft = await db.query.builderPages.findFirst({ where: eq(builderPages.path, normalized) });
    if (draft) return draft;
  }
  return (await db.query.builderPages.findFirst({ where: and(eq(builderPages.publishedPath, normalized), isNotNull(builderPages.published)) })) ?? null;
};

/** The one page of a singleton type such as the site header. */
export const findSingleton = async (db: Database, type: string, options: { preview: boolean }) => {
  const page = await db.query.builderPages.findFirst({ where: eq(builderPages.type, type) });
  return page && (options.preview || page.published) ? page : null;
};

/** Publish pages whose scheduled time has come; failures are recorded on the page. */
export const publishDuePages = async (db: Database, now = new Date()) => {
  const due = await db.select({ id: builderPages.id }).from(builderPages).where(and(isNotNull(builderPages.scheduledAt), lte(builderPages.scheduledAt, now))).limit(50);
  let published = 0;
  for (const { id } of due) {
    try {
      await db.transaction(async (tx) => {
        const page = await getPage(tx, id);
        if (!page.scheduledAt || page.scheduledAt > now) return;
        await publishPageInTransaction(tx, page, await loadDefinitions(tx), { staffId: page.draftUpdatedBy });
      });
      published++;
    } catch (error) {
      const message = error instanceof ValidationError ? `${error.message}: ${error.fieldErrors.map((f) => f.message).join("; ")}` : error instanceof Error ? error.message : "Publishing failed";
      await db.update(builderPages).set({ scheduledAt: null, scheduleError: message.slice(0, 1000) }).where(eq(builderPages.id, id));
    }
  }
  return published;
};

/** What would stop each page from publishing now, for releases and schedules. */
export const pagesNotReady = async (db: Database, pageIds: string[]) => {
  if (!pageIds.length) return [];
  const components = await loadDefinitions(db);
  const pages = await db.select().from(builderPages).where(inArray(builderPages.id, pageIds));
  const problems: FieldError[] = [];
  for (const page of pages) {
    try {
      const document = prepareDocument(page.draft, page, components, "publish", ["pages", page.id]);
      if (document.path) {
        const taken = await db.select({ id: builderPages.id }).from(builderPages).where(and(eq(builderPages.publishedPath, document.path), ne(builderPages.id, page.id))).limit(1);
        if (taken.length) problems.push({ path: ["pages", page.id, "path"], message: `Another published page is served at ${document.path}` });
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      problems.push(...error.fieldErrors);
    }
  }
  return problems;
};

/** Content types that exist, for validating a page's type in the API. */
export const contentTypeCodes = async (db: Database) => (await db.select({ code: builderComponents.code }).from(builderComponents).where(eq(builderComponents.kind, "content_type"))).map((r) => r.code);
