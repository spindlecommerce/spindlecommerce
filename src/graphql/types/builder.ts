import { inArray } from "drizzle-orm";
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { pickLocalized } from "../../lib/i18n.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { createComponent, deleteComponent, listComponents, loadDefinitions, syncComponents, toDefinition, updateComponent } from "../../modules/builder/components.ts";
import { categoryHref, deliverDocument, productHref, type Delivery } from "../../modules/builder/delivery.ts";
import { createFrontend, defaultFrontend, deleteFrontend, deployFrontend, getFrontend, listFrontends, updateFrontend } from "../../modules/builder/frontends.ts";
import { componentCodesIn, type ComponentDefinition, type TemplateFor } from "../../modules/builder/model.ts";
import {
  customizeTemplate,
  findCategoryTemplate,
  findProductTemplate,
  NO_TARGETS,
  previewTemplate,
  setTemplateTargets,
  templatePreviewTarget,
  templateTargetsByPage,
  type TemplateMatch,
  type TemplateTarget,
  type TemplateTargets,
} from "../../modules/builder/templates.ts";
import { ancestorIdsFromPath } from "../../modules/catalog/read.ts";
import {
  createPage,
  deletePage,
  discardPageDraft,
  duplicatePage,
  findPageByPath,
  findSingleton,
  getPage,
  listPages,
  listPageVersions,
  pagesNotReady,
  pageStatus,
  publishPage,
  restorePageVersion,
  savePageDraft,
  savePageVersion,
  schedulePage,
  unpublishPage,
  updatePageSettings,
  type BuilderPage,
} from "../../modules/builder/pages.ts";
import { createPreviewToken, previewUrl } from "../../modules/builder/preview.ts";
import { ensureSections, findSections, sectionsOwner, type SectionsOwner } from "../../modules/builder/sections.ts";
import { addPagesToRelease, assertPagesReady, createRelease, deleteRelease, listReleases, publishRelease, releasePageIds, removePagesFromRelease, updateRelease } from "../../modules/builder/releases.ts";
import { builderPages, builderReleasePages } from "../../modules/builder/tables.ts";
import { getStaffUser } from "../../modules/staff/service.ts";
import { ADMIN, builder, connectionComplexity, rawId, STOREFRONT } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { offsetConnection, offsetPage } from "../pagination.ts";
import { CategoryRef, ChannelRef, ComponentRef, FrontendRef, PageRef, PageVersionRef, ProductRef, ReleaseRef, StaffUserRef, WebhookSubscriptionRef, type PageView } from "../refs.ts";
import { categorySlugPath, categoryTranslation, isCategoryVisible, isProductVisible, notErrors, productTranslation } from "./catalog.ts";
import { documentOf, servedInChannel, viewFor, views } from "./builder-views.ts";
import { DeletePayload, FieldErrorRef, LocalizedStringInput, LocalizedStringRef, fromLocalizedList, toLocalizedList } from "./common.ts";

// ---------------------------------------------------------------- shared

const channelGid = (ctx: GraphQLContext) => toGlobalId("Channel", ctx.scope.channel.id);

const definitionsByContext = new WeakMap<GraphQLContext, Promise<Map<string, ComponentDefinition>>>();
const definitions = (ctx: GraphQLContext) => {
  let cached = definitionsByContext.get(ctx);
  if (!cached) definitionsByContext.set(ctx, (cached = loadDefinitions(ctx.db)));
  return cached;
};

type Delivered = Delivery & { pagePaths: Map<string, { path: string | null; title: string | null }> };
const deliveries = new WeakMap<PageView, Promise<Delivered>>();

/**
 * Once per page object and request, shared by `content`, `seo` and `references`. Fills in link
 * hrefs for the request locale.
 */
const delivered = (page: PageView, ctx: GraphQLContext): Promise<Delivered> => {
  let cached = deliveries.get(page);
  if (cached) return cached;
  cached = (async () => {
    const at = ctx.preview?.at ? new Date(ctx.preview.at) : new Date();
    const delivery = deliverDocument(documentOf(page), { components: await definitions(ctx), locale: ctx.scope.locale, fallbackLocale: ctx.scope.channel.defaultLocale, channelId: channelGid(ctx), now: at });
    const pageIds = delivery.references.pages.flatMap((gid) => (gid.startsWith("gid://ecom/Page/") ? [rawId(gid)] : []));
    const linked = pageIds.length ? await ctx.db.select().from(builderPages).where(inArray(builderPages.id, pageIds)) : [];
    const pagePaths = new Map(
      linked.map((p) => {
        const view = viewFor(ctx, p);
        const doc = view ? documentOf(view) : null;
        return [toGlobalId("Page", p.id), { path: view ? (view.view === "draft" ? p.path : p.publishedPath) : null, title: doc ? pickLocalized(doc.title, ctx.scope.locale, ctx.scope.channel.defaultLocale) : null }];
      }),
    );
    for (const link of delivery.links) {
      if (!link.id) continue;
      if (link.kind === "page") link.href = pagePaths.get(link.id)?.path ?? null;
      if (link.kind === "product") {
        const slug = (await productTranslation(ctx, rawId(link.id)))?.slug;
        link.href = slug ? productHref(slug) : null;
      }
      if (link.kind === "category") {
        const category = await ctx.loaders.category.load(rawId(link.id)).catch(() => null);
        link.href = category && isCategoryVisible(ctx, category) ? categoryHref(await categorySlugPath(ctx, category)) : null;
      }
    }
    return { ...delivery, pagePaths };
  })();
  deliveries.set(page, cached);
  return cached;
};

const staffUser = (ctx: GraphQLContext, id: string | null) => (id ? getStaffUser(ctx.db, id).then((u) => u ?? null) : null);

/** Per-request memo, so a list of pages or components does not repeat the same lookup per row. */
const perRequest = <T>(load: (ctx: GraphQLContext) => Promise<T>) => {
  const cache = new WeakMap<GraphQLContext, Promise<T>>();
  return (ctx: GraphQLContext) => {
    let value = cache.get(ctx);
    if (!value) cache.set(ctx, (value = load(ctx)));
    return value;
  };
};
const allChannels = perRequest((ctx) => ctx.db.query.channels.findMany());
const allTemplateTargets = perRequest((ctx) => templateTargetsByPage(ctx.db));
const templateKind = async (ctx: GraphQLContext, type: string) => (await definitions(ctx)).get(type)?.templateFor ?? null;
const sectionsKindOf = async (ctx: GraphQLContext, type: string) => (await definitions(ctx)).get(type)?.sectionsFor ?? null;

/** A product's or category's own sections: drafts for the admin and previews, else published. */
const sectionsView = async (ctx: GraphQLContext, owner: SectionsOwner) => {
  const page = await findSections(ctx.db, owner);
  return page && servedInChannel(ctx, page) ? viewFor(ctx, page) : null;
};

/**
 * The template a product or category renders with. Drafts count for the admin and previews, and a
 * template's own preview uses that template.
 */
const templateView = async (ctx: GraphQLContext, kind: TemplateFor, find: (options: { drafts: boolean; channelId: string | null }) => Promise<TemplateMatch | null>) => {
  const previewing = ctx.preview?.templateId ? await previewTemplate(ctx.db, ctx.preview.templateId, kind) : null;
  const page = previewing ?? (await find({ drafts: ctx.api === "admin" || !!ctx.preview, channelId: ctx.api === "admin" ? null : ctx.scope.channel.id }))?.page;
  return page ? viewFor(ctx, page) : null;
};

const slugIn = (translations: { locale: string; slug: string }[], locale: string) =>
  (translations.find((t) => t.locale === locale) ?? translations.find((t) => t.locale.split("-")[0] === locale.split("-")[0]) ?? translations[0])?.slug ?? null;

/** The storefront path of the product or category a template preview opens, in the preview's locale. */
const templatePreviewPath = async (ctx: GraphQLContext, target: TemplateTarget | null, locale: string) => {
  if (!target) return null;
  if ("productId" in target) {
    const slug = slugIn(await ctx.loaders.productTranslations.load(target.productId), locale);
    return slug ? productHref(slug) : null;
  }
  const category = await ctx.loaders.category.load(target.categoryId).catch(() => null);
  if (!category) return null;
  const slugs = await Promise.all(ancestorIdsFromPath(category.path).map(async (id) => slugIn(await ctx.loaders.categoryTranslations.load(id), locale) ?? id));
  return categoryHref(slugs.join("/"));
};
/** How many pages use each component (in the draft or the published version), from one scan. */
const usageCounts = perRequest(async (ctx) => {
  const counts = new Map<string, number>();
  for (const page of await ctx.db.select({ type: builderPages.type, draft: builderPages.draft, published: builderPages.published }).from(builderPages)) {
    const codes = new Set([page.type, ...componentCodesIn(page.draft), ...componentCodesIn(page.published)]);
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
});

// ---------------------------------------------------------------- enums and small types

const ComponentKindEnum = builder.enumType("ComponentKind", {
  values: {
    CONTENT_TYPE: { value: "content_type", description: "The root of a page, e.g. a landing page or the site header." },
    COMPONENT: { value: "component", description: "Nests inside a content type's or component's blocks fields." },
  } as const,
});
const ComponentSourceEnum = builder.enumType("ComponentSource", {
  subGraphs: ADMIN,
  values: { ADMIN: { value: "admin", description: "Created or last edited in the admin." }, CODE: { value: "code", description: "Deployed from a frontend's code with componentsSync." } } as const,
});
const PageStatusEnum = builder.enumType("PageStatus", {
  values: {
    DRAFT: { value: "draft", description: "Never published." },
    PUBLISHED: { value: "published", description: "Live, with no unpublished changes." },
    CHANGED: { value: "changed", description: "Live, with draft changes not yet published." },
    SCHEDULED: { value: "scheduled", description: "Will publish at scheduledAt." },
  } as const,
});
const PageSortEnum = builder.enumType("PageSort", {
  values: { PATH: { value: "path", description: "By path (the site's structure)." }, UPDATED: { value: "updated", description: "Most recently changed first (admin: draft saves; storefront: publishes)." } } as const,
});
const PageVersionKindEnum = builder.enumType("PageVersionKind", {
  subGraphs: ADMIN,
  values: { PUBLISH: { value: "publish" }, SAVE: { value: "save" }, RESTORE: { value: "restore" }, AUTOSAVE: { value: "autosave" } } as const,
});
const ReleaseStatusEnum = builder.enumType("ReleaseStatus", {
  subGraphs: ADMIN,
  values: { OPEN: { value: "open" }, SCHEDULED: { value: "scheduled" }, PUBLISHED: { value: "published" }, FAILED: { value: "failed", description: "The scheduled publish failed; see error." } } as const,
});
const TemplateForEnum = builder.enumType("TemplateFor", {
  description: "What a template renders: product pages or category pages.",
  values: { PRODUCT: { value: "product" }, CATEGORY: { value: "category" } } as const,
});
const TemplateSourceEnum = builder.enumType("TemplateSource", {
  subGraphs: ADMIN,
  values: {
    PRODUCT: { value: "product", description: "Assigned to this product." },
    CATEGORY: { value: "category", description: "Assigned to a category: for a product, the nearest of its categories and their parents; for a category, this one." },
    DEFAULT: { value: "default", description: "The default template." },
  } as const,
});

const TemplateTargetsRef = builder.objectRef<TemplateTargets>("TemplateTargets").implement({
  subGraphs: ADMIN,
  description: "What a template is assigned to. Each product, category and the default has one published template; a draft takes over its assignments when published.",
  fields: (t) => ({
    isDefault: t.exposeBoolean("isDefault", { description: "Renders every product (or category) page no other template is assigned to." }),
    products: t.field({ type: [ProductRef], description: "Product templates: these products.", resolve: async (s, _a, ctx) => notErrors(await ctx.loaders.product.loadMany(s.productIds)) }),
    categories: t.field({
      type: [CategoryRef],
      description: "Product templates: the products in these categories and their subcategories. Category templates: these category pages.",
      resolve: async (s, _a, ctx) => notErrors(await ctx.loaders.category.loadMany(s.categoryIds)),
    }),
  }),
});

const TemplateMatchRef = builder.objectRef<TemplateMatch>("TemplateMatch").implement({
  subGraphs: ADMIN,
  description: "The template a product or category page renders with, and why.",
  fields: (t) => ({
    page: t.field({ type: PageRef, resolve: (m) => views.draft(m.page) }),
    source: t.field({ type: TemplateSourceEnum, resolve: (m) => m.source }),
    category: t.field({ type: CategoryRef, nullable: true, description: "The category the template is assigned to, when source is CATEGORY.", resolve: (m, _a, ctx) => (m.categoryId ? ctx.loaders.category.load(m.categoryId) : null) }),
  }),
});

const LIVE_DESCRIPTION = "Only count published templates: what visitors see now. By default unpublished ones count too.";

type ImageShape = { url: string; alt: string | null; width: number | null; height: number | null };
const PageImageRef = builder.objectRef<ImageShape>("PageImage").implement({
  fields: (t) => ({
    url: t.exposeString("url"),
    alt: t.exposeString("alt", { nullable: true }),
    width: t.exposeInt("width", { nullable: true }),
    height: t.exposeInt("height", { nullable: true }),
  }),
});
type SeoShape = { title: string | null; description: string | null; image: ImageShape | null; noIndex: boolean };
const PageSeoRef = builder.objectRef<SeoShape>("PageSeo").implement({
  description: "Search and sharing metadata, in the request locale.",
  fields: (t) => ({
    title: t.exposeString("title", { nullable: true, description: "Falls back to nothing; frontends usually use the page title." }),
    description: t.exposeString("description", { nullable: true }),
    image: t.field({ type: PageImageRef, nullable: true, resolve: (s) => s.image }),
    noIndex: t.exposeBoolean("noIndex"),
  }),
});
type PageLinkShape = { id: string; path: string | null; title: string | null };
const PageLinkRef = builder.objectRef<PageLinkShape>("PageLink").implement({
  description: "A page linked from content: where it is served and its title.",
  fields: (t) => ({ id: t.exposeID("id"), path: t.exposeString("path", { nullable: true }), title: t.exposeString("title", { nullable: true }) }),
});
type ReferencesShape = { page: PageView };
const PageReferencesRef = builder.objectRef<ReferencesShape>("PageReferences").implement({
  description: "Objects the content refers to by id, so one request renders the whole page.",
  fields: (t) => ({
    products: t.field({
      type: [ProductRef],
      description: "Products the storefront may show; unpublished ones are left out (render nothing for them).",
      resolve: async ({ page }, _a, ctx) => {
        const ids = (await delivered(page, ctx)).references.products.map(rawId);
        const products = notErrors(await ctx.loaders.product.loadMany(ids));
        const visible = await Promise.all(products.map(async (p) => ((await isProductVisible(ctx, p)) ? p : null)));
        return visible.filter((p) => p !== null);
      },
    }),
    categories: t.field({
      type: [CategoryRef],
      resolve: async ({ page }, _a, ctx) => notErrors(await ctx.loaders.category.loadMany((await delivered(page, ctx)).references.categories.map(rawId))).filter((c) => isCategoryVisible(ctx, c)),
    }),
    pages: t.field({
      type: [PageLinkRef],
      resolve: async ({ page }, _a, ctx) => [...(await delivered(page, ctx)).pagePaths.entries()].map(([id, p]) => ({ id, ...p })),
    }),
  }),
});

// ---------------------------------------------------------------- pages

builder.node(PageRef, {
  description: "A page built from components. Storefronts get the published version, or the draft with a preview token.",
  id: { resolve: (p) => p.id },
  loadMany: async (ids, ctx) => {
    const rows = await ctx.db.select().from(builderPages).where(inArray(builderPages.id, [...ids]));
    return ids.map((id) => {
      const row = rows.find((r) => r.id === id) ?? null;
      return row && servedInChannel(ctx, row) ? viewFor(ctx, row) : null;
    });
  },
  fields: (t) => ({
    type: t.exposeString("type", { description: "The content type's code, e.g. landing_page." }),
    path: t.string({ nullable: true, description: "Where the page is served; null for content types without paths (header, footer, templates).", resolve: (p) => (p.view === "draft" ? p.draft.path : p.publishedPath) }),
    templateFor: t.field({
      type: TemplateForEnum,
      nullable: true,
      description: "Set for templates: product or category pages render with this page, with the product or category as data for its components.",
      resolve: (p, _a, ctx) => templateKind(ctx, p.type),
    }),
    sectionsFor: t.field({
      type: TemplateForEnum,
      nullable: true,
      description: "Set for a product's or category's own sections (Product.sections, Category.sections): which of the two they belong to.",
      resolve: (p, _a, ctx) => sectionsKindOf(ctx, p.type),
    }),
    product: t.field({
      type: ProductRef,
      subGraphs: ADMIN,
      nullable: true,
      description: "Sections only: the product whose own sections this page holds.",
      resolve: (p, _a, ctx) => (p.productId ? ctx.loaders.product.load(p.productId).catch(() => null) : null),
    }),
    category: t.field({
      type: CategoryRef,
      subGraphs: ADMIN,
      nullable: true,
      description: "Sections only: the category whose own sections this page holds.",
      resolve: (p, _a, ctx) => (p.categoryId ? ctx.loaders.category.load(p.categoryId).catch(() => null) : null),
    }),
    title: t.string({ nullable: true, resolve: (p, _a, ctx) => pickLocalized(documentOf(p).title, ctx.scope.locale, ctx.scope.channel.defaultLocale) }),
    seo: t.field({ type: PageSeoRef, resolve: async (p, _a, ctx) => (await delivered(p, ctx)).seo }),
    content: t.field({
      type: "JSON",
      description:
        "The component tree in the request locale: { id, component, variation, fields }, with blocks fields holding child nodes and list fields holding { id, fields } items. " +
        "Hidden components and those not targeted at this channel, locale or time are left out. Links are { kind, href, id, newTab }; products and categories are global ids, resolved in references.",
      resolve: async (p, _a, ctx) => (await delivered(p, ctx)).root,
    }),
    references: t.field({ type: PageReferencesRef, resolve: (page) => ({ page }) }),
    publishedAt: t.field({ type: "DateTime", nullable: true, resolve: (p) => p.publishedAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (p) => (p.view === "draft" ? p.draftUpdatedAt : (p.publishedAt ?? p.updatedAt)) }),
    isPreview: t.boolean({ subGraphs: STOREFRONT, description: "True when this is unpublished draft content, served for a preview token.", resolve: (p) => p.view === "draft" }),

    status: t.field({ type: PageStatusEnum, subGraphs: ADMIN, resolve: (p) => pageStatus(p) }),
    version: t.exposeInt("version", { subGraphs: ADMIN, description: "Increments on every draft save; pass it back as baseVersion." }),
    document: t.field({ type: "JSON", subGraphs: ADMIN, description: "The draft as stored: every locale, hidden components and targeting included.", resolve: (p) => p.draft }),
    publishedDocument: t.field({ type: "JSON", subGraphs: ADMIN, nullable: true, resolve: (p) => p.published }),
    publishedPath: t.exposeString("publishedPath", { subGraphs: ADMIN, nullable: true }),
    titles: t.field({ type: [LocalizedStringRef], subGraphs: ADMIN, resolve: (p) => toLocalizedList(p.draft.title) }),
    channels: t.field({
      type: [ChannelRef],
      subGraphs: ADMIN,
      resolve: async (p, _a, ctx) => (await allChannels(ctx)).filter((c) => p.channelIds.length === 0 || p.channelIds.includes(c.id)),
    }),
    allChannels: t.boolean({ subGraphs: ADMIN, resolve: (p) => p.channelIds.length === 0 }),
    templateTargets: t.field({
      type: TemplateTargetsRef,
      subGraphs: ADMIN,
      nullable: true,
      description: "Templates only: the products and categories it is assigned to, and whether it is the default.",
      resolve: async (p, _a, ctx) => ((await templateKind(ctx, p.type)) ? ((await allTemplateTargets(ctx)).get(p.id) ?? NO_TARGETS) : null),
    }),
    contentType: t.field({ type: ComponentRef, subGraphs: ADMIN, nullable: true, resolve: async (p, _a, ctx) => (await listComponents(ctx.db)).find((c) => c.code === p.type) ?? null }),
    draftUpdatedAt: t.field({ type: "DateTime", subGraphs: ADMIN, resolve: (p) => p.draftUpdatedAt }),
    draftUpdatedBy: t.field({ type: StaffUserRef, subGraphs: ADMIN, nullable: true, resolve: (p, _a, ctx) => staffUser(ctx, p.draftUpdatedBy) }),
    publishedBy: t.field({ type: StaffUserRef, subGraphs: ADMIN, nullable: true, resolve: (p, _a, ctx) => staffUser(ctx, p.publishedBy) }),
    firstPublishedAt: t.field({ type: "DateTime", subGraphs: ADMIN, nullable: true, resolve: (p) => p.firstPublishedAt }),
    scheduledAt: t.field({ type: "DateTime", subGraphs: ADMIN, nullable: true, resolve: (p) => p.scheduledAt }),
    scheduleError: t.exposeString("scheduleError", { subGraphs: ADMIN, nullable: true, description: "Why the last scheduled publish failed." }),
    createdAt: t.field({ type: "DateTime", subGraphs: ADMIN, resolve: (p) => p.createdAt }),
    versions: t.field({ type: [PageVersionRef], subGraphs: ADMIN, description: "Newest first.", resolve: (p, _a, ctx) => listPageVersions(ctx.db, p.id) }),
    releases: t.field({
      type: [ReleaseRef],
      subGraphs: ADMIN,
      resolve: async (p, _a, ctx) => {
        const ids = (await ctx.db.select({ releaseId: builderReleasePages.releaseId }).from(builderReleasePages).where(inArray(builderReleasePages.pageId, [p.id]))).map((r) => r.releaseId);
        return (await listReleases(ctx.db)).filter((r) => ids.includes(r.id));
      },
    }),
  }),
});

builder.objectType(PageVersionRef, {
  subGraphs: ADMIN,
  fields: (t) => ({
    id: t.id({ resolve: (v) => toGlobalId("PageVersion", v.id) }),
    version: t.exposeInt("version"),
    kind: t.field({ type: PageVersionKindEnum, resolve: (v) => v.kind }),
    label: t.exposeString("label", { nullable: true }),
    createdAt: t.field({ type: "DateTime", resolve: (v) => v.createdAt }),
    createdBy: t.field({ type: StaffUserRef, nullable: true, resolve: (v, _a, ctx) => staffUser(ctx, v.createdBy) }),
    document: t.field({ type: "JSON", resolve: (v) => v.document }),
  }),
});

// ---------------------------------------------------------------- templates

builder.objectFields(ProductRef, (t) => ({
  template: t.field({
    type: PageRef,
    nullable: true,
    description:
      "The page builder template for this product's page: the one assigned to the product, else its nearest category's, else the default. " +
      "Render its content with the product as data. Null means none: use your built-in layout. Drafts appear only with a preview token.",
    resolve: (p, _a, ctx) => templateView(ctx, "product", (options) => findProductTemplate(ctx.db, p.id, options)),
  }),
  sections: t.field({
    type: PageRef,
    nullable: true,
    description:
      "This product's own sections, to render with the product as data where its template places the product sections component. " +
      "Null when it has none. Drafts appear only with a preview token.",
    resolve: (p, _a, ctx) => sectionsView(ctx, { productId: p.id }),
  }),
  templateMatch: t.field({
    type: TemplateMatchRef,
    subGraphs: ADMIN,
    nullable: true,
    args: { live: t.arg.boolean({ description: LIVE_DESCRIPTION }) },
    resolve: (p, { live }, ctx) => findProductTemplate(ctx.db, p.id, { drafts: !live }),
  }),
}));

builder.objectFields(CategoryRef, (t) => ({
  template: t.field({
    type: PageRef,
    nullable: true,
    description:
      "The page builder template for this category's page: the one assigned to the category, else the default. " +
      "Render its content with the category as data. Null means none: use your built-in layout. Drafts appear only with a preview token.",
    resolve: (c, _a, ctx) => templateView(ctx, "category", (options) => findCategoryTemplate(ctx.db, c.id, options)),
  }),
  sections: t.field({
    type: PageRef,
    nullable: true,
    description:
      "This category's own sections, to render with the category as data where its template places the category sections component. " +
      "Null when it has none. Drafts appear only with a preview token.",
    resolve: (c, _a, ctx) => sectionsView(ctx, { categoryId: c.id }),
  }),
  templateMatch: t.field({
    type: TemplateMatchRef,
    subGraphs: ADMIN,
    nullable: true,
    args: { live: t.arg.boolean({ description: LIVE_DESCRIPTION }) },
    resolve: (c, { live }, ctx) => findCategoryTemplate(ctx.db, c.id, { drafts: !live }),
  }),
}));

// ---------------------------------------------------------------- components

builder.node(ComponentRef, {
  subGraphs: ADMIN,
  description: "A component or content type in the page builder's library.",
  id: { resolve: (c) => c.id },
  loadMany: async (ids, ctx) => {
    const all = await listComponents(ctx.db);
    return ids.map((id) => all.find((c) => c.id === id) ?? null);
  },
  fields: (t) => ({
    code: t.exposeString("code", { description: "Stable identifier; pages and frontends refer to components by code." }),
    kind: t.field({ type: ComponentKindEnum, resolve: (c) => c.kind }),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    groupName: t.exposeString("groupName", { nullable: true }),
    icon: t.exposeString("icon", { nullable: true, description: "A lucide icon name." }),
    previewImageUrl: t.exposeString("previewImageUrl", { nullable: true }),
    fields: t.field({ type: "JSON", description: "Field definitions: { key, type, label, required, localized, options, allowedComponents, fields, … }.", resolve: (c) => c.fields }),
    variations: t.field({ type: "JSON", resolve: (c) => c.variations }),
    routable: t.exposeBoolean("routable"),
    singleton: t.exposeBoolean("singleton"),
    templateFor: t.field({
      type: TemplateForEnum,
      nullable: true,
      description: "Content types: its pages are product or category templates. Components: shows that object's data, so it only fits those templates (and that kind's sections).",
      resolve: (c) => c.templateFor ?? null,
    }),
    sectionsFor: t.field({
      type: TemplateForEnum,
      nullable: true,
      description: "Content types only: its pages are one product's or category's own sections, which templates show where they place a sections component.",
      resolve: (c) => c.sectionsFor ?? null,
    }),
    source: t.field({ type: ComponentSourceEnum, resolve: (c) => c.source }),
    revision: t.exposeInt("revision"),
    usageCount: t.int({ description: "Pages whose draft or published version uses it.", resolve: async (c, _a, ctx) => (await usageCounts(ctx)).get(c.code) ?? 0 }),
    definition: t.field({ type: "JSON", description: "The definition as componentsSync accepts it.", resolve: (c) => toDefinition(c) }),
    createdAt: t.field({ type: "DateTime", resolve: (c) => c.createdAt }),
    updatedAt: t.field({ type: "DateTime", resolve: (c) => c.updatedAt }),
  }),
});

// ---------------------------------------------------------------- releases and frontends

builder.node(ReleaseRef, {
  subGraphs: ADMIN,
  description: "Pages to publish together, now or at a scheduled time.",
  id: { resolve: (r) => r.id },
  loadMany: async (ids, ctx) => {
    const all = await listReleases(ctx.db);
    return ids.map((id) => all.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    status: t.field({ type: ReleaseStatusEnum, resolve: (r) => r.status }),
    scheduledAt: t.field({ type: "DateTime", nullable: true, resolve: (r) => r.scheduledAt }),
    publishedAt: t.field({ type: "DateTime", nullable: true, resolve: (r) => r.publishedAt }),
    error: t.exposeString("error", { nullable: true }),
    problems: t.field({
      type: [FieldErrorRef],
      description: "What would stop the release from publishing now (a dry run): paths are [pages, pageId, …]. Empty when ready.",
      resolve: async (r, _a, ctx) => (r.status === "published" ? [] : pagesNotReady(ctx.db, await releasePageIds(ctx.db, r.id))),
    }),
    pages: t.field({
      type: [PageRef],
      resolve: async (r, _a, ctx) => {
        const ids = await releasePageIds(ctx.db, r.id);
        if (!ids.length) return [];
        const rows = await ctx.db.select().from(builderPages).where(inArray(builderPages.id, ids));
        return ids.flatMap((id) => rows.filter((p) => p.id === id).map(views.draft));
      },
    }),
    createdBy: t.field({ type: StaffUserRef, nullable: true, resolve: (r, _a, ctx) => staffUser(ctx, r.createdBy) }),
    publishedBy: t.field({ type: StaffUserRef, nullable: true, resolve: (r, _a, ctx) => staffUser(ctx, r.publishedBy) }),
    createdAt: t.field({ type: "DateTime", resolve: (r) => r.createdAt }),
  }),
});

builder.node(FrontendRef, {
  subGraphs: ADMIN,
  description: "A storefront app the builder previews in and deploys to.",
  id: { resolve: (f) => f.id },
  loadMany: async (ids, ctx) => {
    const all = await listFrontends(ctx.db);
    return ids.map((id) => all.find((f) => f.id === id) ?? null);
  },
  fields: (t) => ({
    name: t.exposeString("name"),
    url: t.exposeString("url", { description: "Base URL, e.g. https://shop.example.com." }),
    previewPath: t.exposeString("previewPath", { description: "Route that turns on draft mode, e.g. /api/draft." }),
    revalidatePath: t.exposeString("revalidatePath", { nullable: true, description: "Route that receives signed publish and catalog events." }),
    webhookSubscription: t.field({
      type: WebhookSubscriptionRef,
      nullable: true,
      resolve: async (f, _a, ctx) => (f.webhookSubscriptionId ? ((await ctx.db.query.webhookSubscriptions.findFirst({ where: (w, { eq }) => eq(w.id, f.webhookSubscriptionId!) })) ?? null) : null),
    }),
    hasDeployHook: t.boolean({ resolve: (f) => !!f.deployHookUrl }),
    deployHookHost: t.string({ nullable: true, description: "The deploy hook's host; the URL itself is a secret.", resolve: (f) => (f.deployHookUrl ? new URL(f.deployHookUrl).host : null) }),
    defaultChannel: t.field({ type: ChannelRef, nullable: true, resolve: async (f, _a, ctx) => (f.defaultChannelId ? ((await ctx.db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, f.defaultChannelId!) })) ?? null) : null) }),
    isDefault: t.exposeBoolean("isDefault"),
    lastDeployAt: t.field({ type: "DateTime", nullable: true, resolve: (f) => f.lastDeployAt }),
    lastDeployStatus: t.exposeString("lastDeployStatus", { nullable: true }),
  }),
});

type PreviewSessionShape = { token: string; expiresAt: Date; url: string | null; adminOrigin: string | null; at: string | null; path: string | null };
const PreviewSessionRef = builder.objectRef<PreviewSessionShape>("PreviewSession").implement({
  description: "A preview of draft content. In the storefront API this describes the request's x-preview-token.",
  fields: (t) => ({
    token: t.exposeString("token", { subGraphs: ADMIN, description: "Send as x-preview-token. Read-only access to drafts; expires." }),
    expiresAt: t.field({ type: "DateTime", resolve: (s) => s.expiresAt }),
    url: t.exposeString("url", { subGraphs: ADMIN, nullable: true, description: "The frontend's preview route for the page; frame it for visual editing." }),
    adminOrigin: t.exposeString("adminOrigin", { nullable: true, description: "The admin's origin: the only window the visual editing bridge talks to." }),
    at: t.exposeString("at", { nullable: true, description: "Scheduled content is shown as of this time." }),
    path: t.exposeString("path", { subGraphs: ADMIN, nullable: true, description: "The storefront path the preview opens; for a template, the product or category page it renders." }),
  }),
});

const adminOrigin = (ctx: GraphQLContext) => {
  try {
    return new URL(ctx.platform.config.admin.url).origin;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- queries

const read = { authScopes: (_p: unknown, _a: unknown, ctx: GraphQLContext) => (ctx.api === "admin" ? { permission: "content:read" } : true) };

builder.queryFields((t) => ({
  page: t.field({
    type: PageRef,
    nullable: true,
    description: "Storefront: the page served at a path (draft content with a preview token). Admin: by id or path.",
    args: { path: t.arg.string(), id: t.arg.globalID({ for: [PageRef] }) },
    ...read,
    resolve: async (_r, { path, id }, ctx) => {
      const page = id ? await getPage(ctx.db, rawId(id)).catch(() => null) : path != null ? await findPageByPath(ctx.db, path, { preview: ctx.api === "admin" || !!ctx.preview }) : null;
      return page && servedInChannel(ctx, page) ? viewFor(ctx, page) : null;
    },
  }),
  singletonPage: t.field({
    type: PageRef,
    nullable: true,
    description: "The one page of a singleton content type, e.g. site_header or site_footer.",
    args: { type: t.arg.string({ required: true }) },
    ...read,
    resolve: async (_r, { type }, ctx) => {
      const page = await findSingleton(ctx.db, type, { preview: ctx.api === "admin" || !!ctx.preview });
      return page && servedInChannel(ctx, page) ? viewFor(ctx, page) : null;
    },
  }),
  pages: t.connection({
    type: PageRef,
    description: "Pages by path. Storefront: published pages served in the channel (e.g. for a sitemap or a journal index). Admin: every page; status filters the admin list.",
    args: {
      type: t.arg.string({ description: "A content type's code." }),
      query: t.arg.string({ description: "Part of the path or title." }),
      status: t.arg({ type: PageStatusEnum, description: "Admin only; the storefront lists published pages." }),
      sort: t.arg({ type: PageSortEnum, description: "Defaults to PATH." }),
    },
    complexity: connectionComplexity,
    ...read,
    resolve: async (_r, args, ctx) => {
      const page = offsetPage(args);
      const storefront = ctx.api === "storefront";
      const { rows, total } = await listPages(ctx.db, { type: args.type, query: args.query, status: storefront ? null : args.status, publishedOnly: storefront && !ctx.preview, sort: args.sort }, page);
      const visible = rows.filter((r) => servedInChannel(ctx, r)).flatMap((r) => viewFor(ctx, r) ?? []);
      return offsetConnection(page, visible, total);
    },
  }),
  previewSession: t.field({
    type: PreviewSessionRef,
    nullable: true,
    subGraphs: STOREFRONT,
    description: "The request's preview, from its x-preview-token header; null without one. Frontends call it to validate a token before enabling draft mode.",
    resolve: (_r, _a, ctx) => (ctx.preview ? { token: "", expiresAt: ctx.preview.expiresAt, url: null, adminOrigin: adminOrigin(ctx), at: ctx.preview.at, path: null } : null),
  }),
  components: t.field({
    type: [ComponentRef],
    subGraphs: ADMIN,
    authScopes: { permission: "content:read" },
    args: { kind: t.arg({ type: ComponentKindEnum }) },
    resolve: async (_r, { kind }, ctx) => (await listComponents(ctx.db)).filter((c) => !kind || c.kind === kind),
  }),
  component: t.field({
    type: ComponentRef,
    nullable: true,
    subGraphs: ADMIN,
    authScopes: { permission: "content:read" },
    args: { id: t.arg.globalID({ for: [ComponentRef] }), code: t.arg.string() },
    resolve: async (_r, { id, code }, ctx) => (await listComponents(ctx.db)).find((c) => (id ? c.id === rawId(id) : c.code === code)) ?? null,
  }),
  releases: t.field({ type: [ReleaseRef], subGraphs: ADMIN, authScopes: { permission: "content:read" }, resolve: (_r, _a, ctx) => listReleases(ctx.db) }),
  frontends: t.field({ type: [FrontendRef], subGraphs: ADMIN, authScopes: { permission: "content:read" }, resolve: (_r, _a, ctx) => listFrontends(ctx.db) }),
}));

// ---------------------------------------------------------------- mutations

/** Every mutation returns a result union of its payload and typed errors. */
const write = { subGraphs: ADMIN, authScopes: { permission: "content:write" }, errors: {} } as const;
const settingsWrite = { subGraphs: ADMIN, authScopes: { permission: "settings:write" }, errors: {} } as const;
const writeOrConflict = { ...write, errors: { types: [ConflictError, InvalidStateError] } };
const writeOrInvalid = { ...write, errors: { types: [InvalidStateError] } };
const actorOf = (ctx: GraphQLContext) => ({ staffId: ctx.staff?.id ?? null });
const pagePayload = (page: BuilderPage) => ({ page: views.draft(page) });

const PagePayload = builder.simpleObject("PagePayload", { subGraphs: ADMIN, fields: (t) => ({ page: t.field({ type: PageRef }) }) });
const ComponentPayload = builder.simpleObject("ComponentPayload", { subGraphs: ADMIN, fields: (t) => ({ component: t.field({ type: ComponentRef }) }) });
const ReleasePayload = builder.simpleObject("ReleasePayload", { subGraphs: ADMIN, fields: (t) => ({ release: t.field({ type: ReleaseRef }) }) });
const FrontendPayload = builder.simpleObject("FrontendPayload", {
  subGraphs: ADMIN,
  fields: (t) => ({
    frontend: t.field({ type: FrontendRef }),
    revalidateSecret: t.string({ nullable: true, description: "Shown once, when revalidation is first set up: the storefront verifies webhook signatures with it." }),
  }),
});
const ComponentsSyncPayload = builder.simpleObject("ComponentsSyncPayload", {
  subGraphs: ADMIN,
  fields: (t) => ({ created: t.stringList(), updated: t.stringList(), unchanged: t.stringList(), removed: t.stringList() }),
});
const PreviewSessionPayload = builder.simpleObject("PreviewSessionPayload", { subGraphs: ADMIN, fields: (t) => ({ session: t.field({ type: PreviewSessionRef }) }) });

const ComponentInput = builder.inputType("ComponentInput", {
  subGraphs: ADMIN,
  description: "A definition. fields and variations take the JSON shapes Component returns.",
  fields: (t) => ({
    code: t.string({ description: "Required when creating; fixed afterwards." }),
    kind: t.field({ type: ComponentKindEnum, description: "Required when creating; fixed afterwards." }),
    name: t.string(),
    description: t.string(),
    groupName: t.string(),
    icon: t.string(),
    previewImageUrl: t.string(),
    fields: t.field({ type: "JSON" }),
    variations: t.field({ type: "JSON" }),
    routable: t.boolean(),
    singleton: t.boolean(),
    templateFor: t.field({ type: TemplateForEnum, description: "Content types: make its pages product or category templates. Components: shows that object's data. Fixed while pages use it." }),
    sectionsFor: t.field({
      type: TemplateForEnum,
      description: "Content types: its pages are one product's or category's own sections, which templates show where they place a sections component. Fixed while pages use it.",
    }),
  }),
});
const TemplateTargetsInput = builder.inputType("TemplateTargetsInput", {
  subGraphs: ADMIN,
  description: "Omitted fields are unchanged; lists replace the template's products or categories. A published template takes them over at once, a draft one when published.",
  fields: (t) => ({
    isDefault: t.boolean({ description: "Make this the default template of its kind (the current default stops being one once this template is published), or stop being the default." }),
    productIds: t.globalIDList({ for: [ProductRef], description: "Product templates only." }),
    categoryIds: t.globalIDList({ for: [CategoryRef], description: "Product templates: the products in these categories and their subcategories. Category templates: these category pages." }),
  }),
});
const PageCreateInput = builder.inputType("PageCreateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    type: t.string({ required: true, description: "A content type's code." }),
    titles: t.field({ type: [LocalizedStringInput], required: true }),
    path: t.string({ description: "Required for routable content types." }),
    channelIds: t.globalIDList({ for: [ChannelRef], description: "Empty means every channel." }),
  }),
});
const ReleaseInput = builder.inputType("ReleaseInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string(),
    description: t.string(),
    scheduledAt: t.field({ type: "DateTime", description: "Null unschedules." }),
  }),
});
const FrontendInput = builder.inputType("FrontendInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    name: t.string(),
    url: t.string(),
    previewPath: t.string(),
    revalidatePath: t.string({ description: "Null turns revalidation off." }),
    deployHookUrl: t.string({ description: "Null removes the deploy hook." }),
    defaultChannelId: t.globalID({ for: [ChannelRef] }),
    isDefault: t.boolean(),
  }),
});

/** Keep keys the caller sent, mapping null to null (clear) and dropping undefined. */
const sent = <T extends Record<string, unknown>>(input: T) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

builder.mutationFields((t) => ({
  componentCreate: t.field({
    ...write,
    type: ComponentPayload,
    args: { input: t.arg({ type: ComponentInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({ component: await createComponent(ctx.db, sent({ ...input, fields: input.fields ?? [], variations: input.variations ?? [] })) }),
  }),
  componentUpdate: t.field({
    ...write,
    type: ComponentPayload,
    args: { id: t.arg.globalID({ for: [ComponentRef], required: true }), input: t.arg({ type: ComponentInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({ component: await updateComponent(ctx.db, rawId(id), sent({ ...input, code: undefined, kind: undefined })) }),
  }),
  componentDelete: t.field({
    ...writeOrInvalid,
    type: DeletePayload,
    description: "Refused while pages use the component or other components allow it.",
    args: { id: t.arg.globalID({ for: [ComponentRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Component", await deleteComponent(ctx.db, rawId(id))) }),
  }),
  componentsSync: t.field({
    ...writeOrInvalid,
    type: ComponentsSyncPayload,
    description: "Deploy component definitions from a frontend: upserted by code and marked as managed in code. prune deletes code-managed components not in the set (refused while used).",
    args: { definitions: t.arg({ type: "JSON", required: true }), prune: t.arg.boolean() },
    resolve: (_r, { definitions, prune }, ctx) => syncComponents(ctx.db, definitions, { prune: prune ?? false }),
  }),

  pageCreate: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    args: { input: t.arg({ type: PageCreateInput, required: true }) },
    resolve: async (_r, { input }, ctx) =>
      pagePayload(await createPage(ctx.db, { type: input.type, title: fromLocalizedList(input.titles), path: input.path, channelIds: input.channelIds?.map(rawId) }, actorOf(ctx))),
  }),
  pageSaveDraft: t.field({
    ...writeOrConflict,
    type: PagePayload,
    description: "Save the whole draft document. baseVersion is the version you loaded; a newer one means someone else saved first (ConflictError).",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), baseVersion: t.arg.int({ required: true }), document: t.arg({ type: "JSON", required: true }) },
    resolve: async (_r, { id, baseVersion, document }, ctx) => pagePayload(await savePageDraft(ctx.db, rawId(id), { baseVersion, document }, actorOf(ctx))),
  }),
  pagePublish: t.field({
    ...writeOrConflict,
    type: PagePayload,
    description: "Validate the draft (required fields, counts, path) and make it live. Pass version to publish only what you saw.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), version: t.arg.int() },
    resolve: async (_r, { id, version }, ctx) => pagePayload(await publishPage(ctx.db, rawId(id), actorOf(ctx), { version })),
  }),
  pageUnpublish: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    args: { id: t.arg.globalID({ for: [PageRef], required: true }) },
    resolve: async (_r, { id }, ctx) => pagePayload(await unpublishPage(ctx.db, rawId(id), actorOf(ctx))),
  }),
  pageDiscardDraft: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    description: "Replace the draft with the published version.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }) },
    resolve: async (_r, { id }, ctx) => pagePayload(await discardPageDraft(ctx.db, rawId(id), actorOf(ctx))),
  }),
  pageSchedule: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    description: "Publish the draft at a time; null unschedules. The draft is checked now so the schedule does not fail later.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), at: t.arg({ type: "DateTime" }) },
    resolve: async (_r, { id, at }, ctx) => pagePayload(await schedulePage(ctx.db, rawId(id), at ?? null, actorOf(ctx))),
  }),
  pageDuplicate: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    args: { id: t.arg.globalID({ for: [PageRef], required: true }) },
    resolve: async (_r, { id }, ctx) => pagePayload(await duplicatePage(ctx.db, rawId(id), actorOf(ctx))),
  }),
  pageDelete: t.field({
    ...write,
    type: DeletePayload,
    description: "Delete the page and its history; a published page goes offline.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Page", await deletePage(ctx.db, rawId(id))) }),
  }),
  pageSettingsUpdate: t.field({
    ...write,
    type: PagePayload,
    description: "Settings that apply immediately rather than on publish.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), channelIds: t.arg.globalIDList({ for: [ChannelRef], description: "Empty means every channel." }) },
    resolve: async (_r, { id, channelIds }, ctx) => pagePayload(await updatePageSettings(ctx.db, rawId(id), { channelIds: channelIds?.map(rawId) })),
  }),
  pageTemplateTargetsUpdate: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    description: "Assign a template to products and categories, or make it the default. A published template takes over at once; a draft one when published, and visitors keep the current design until then.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), input: t.arg({ type: TemplateTargetsInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) =>
      pagePayload(await setTemplateTargets(ctx.db, rawId(id), { isDefault: input.isDefault ?? undefined, productIds: input.productIds?.map(rawId), categoryIds: input.categoryIds?.map(rawId) })),
  }),
  pageTemplateCustomize: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    description:
      "Give one product or category its own template: a draft copy of its current one (or an empty one), assigned to it. " +
      "The page keeps its current template until the copy is published. Returns the existing one unchanged if it has one.",
    args: { productId: t.arg.globalID({ for: [ProductRef] }), categoryId: t.arg.globalID({ for: [CategoryRef] }) },
    resolve: async (_r, { productId, categoryId }, ctx) => {
      if (!productId === !categoryId) throw new ValidationError("Pass a product or a category", [{ path: [], message: "Pass exactly one of productId and categoryId" }]);
      const target: TemplateTarget = productId ? { productId: rawId(productId) } : { categoryId: rawId(categoryId!) };
      const exists = "productId" in target ? await ctx.loaders.product.load(target.productId).catch(() => null) : await ctx.loaders.category.load(target.categoryId).catch(() => null);
      if (!exists) throw new NotFoundError(productId ? "Product" : "Category", (productId ?? categoryId!).id);
      const name = ("productId" in target ? (await productTranslation(ctx, target.productId))?.name : (await categoryTranslation(ctx, target.categoryId))?.name) ?? (productId ? "Product" : "Category");
      return pagePayload(await customizeTemplate(ctx.db, target, { name, locale: ctx.scope.locale }, actorOf(ctx)));
    },
  }),
  pageSectionsCreate: t.field({
    ...writeOrInvalid,
    type: PagePayload,
    description:
      "Give one product or category its own sections: an empty draft page of the library's sections content type, shown where its template places a sections component. " +
      "Returns existing sections unchanged. Edit and publish them like any page.",
    args: { productId: t.arg.globalID({ for: [ProductRef] }), categoryId: t.arg.globalID({ for: [CategoryRef] }) },
    resolve: async (_r, { productId, categoryId }, ctx) => {
      if (!productId === !categoryId) throw new ValidationError("Pass a product or a category", [{ path: [], message: "Pass exactly one of productId and categoryId" }]);
      const owner: SectionsOwner = productId ? { productId: rawId(productId) } : { categoryId: rawId(categoryId!) };
      const exists = "productId" in owner ? await ctx.loaders.product.load(owner.productId).catch(() => null) : await ctx.loaders.category.load(owner.categoryId).catch(() => null);
      if (!exists) throw new NotFoundError(productId ? "Product" : "Category", (productId ?? categoryId!).id);
      const name = ("productId" in owner ? (await productTranslation(ctx, owner.productId))?.name : (await categoryTranslation(ctx, owner.categoryId))?.name) ?? (productId ? "Product" : "Category");
      return pagePayload(await ensureSections(ctx.db, owner, { name, locale: ctx.scope.locale }, actorOf(ctx)));
    },
  }),
  pageVersionSave: t.field({
    ...write,
    type: PagePayload,
    description: "Keep the current draft as a named version.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), label: t.arg.string() },
    resolve: async (_r, { id, label }, ctx) => pagePayload(await savePageVersion(ctx.db, rawId(id), label ?? null, actorOf(ctx))),
  }),
  pageVersionRestore: t.field({
    ...write,
    type: PagePayload,
    description: "Load an old version into the draft; publish to make it live.",
    args: { id: t.arg.globalID({ for: [PageRef], required: true }), versionId: t.arg.globalID({ for: [PageVersionRef], required: true }) },
    resolve: async (_r, { id, versionId }, ctx) => pagePayload(await restorePageVersion(ctx.db, rawId(id), rawId(versionId), actorOf(ctx))),
  }),

  releaseCreate: t.field({
    ...write,
    type: ReleasePayload,
    args: { input: t.arg({ type: ReleaseInput, required: true }), pageIds: t.arg.globalIDList({ for: [PageRef] }) },
    resolve: async (_r, { input, pageIds }, ctx) => {
      if (input.scheduledAt && pageIds?.length) await assertPagesReady(ctx.db, pageIds.map(rawId));
      const release = await createRelease(ctx.db, { name: input.name ?? "", description: input.description, scheduledAt: input.scheduledAt ?? null }, actorOf(ctx));
      if (pageIds?.length) await addPagesToRelease(ctx.db, release.id, pageIds.map(rawId));
      return { release };
    },
  }),
  releaseUpdate: t.field({
    ...writeOrInvalid,
    type: ReleasePayload,
    args: { id: t.arg.globalID({ for: [ReleaseRef], required: true }), input: t.arg({ type: ReleaseInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => ({ release: await updateRelease(ctx.db, rawId(id), { name: input.name ?? undefined, description: input.description, scheduledAt: input.scheduledAt }) }),
  }),
  releaseAddPages: t.field({
    ...writeOrInvalid,
    type: ReleasePayload,
    args: { id: t.arg.globalID({ for: [ReleaseRef], required: true }), pageIds: t.arg.globalIDList({ for: [PageRef], required: true }) },
    resolve: async (_r, { id, pageIds }, ctx) => ({ release: await addPagesToRelease(ctx.db, rawId(id), pageIds.map(rawId)) }),
  }),
  releaseRemovePages: t.field({
    ...writeOrInvalid,
    type: ReleasePayload,
    args: { id: t.arg.globalID({ for: [ReleaseRef], required: true }), pageIds: t.arg.globalIDList({ for: [PageRef], required: true }) },
    resolve: async (_r, { id, pageIds }, ctx) => ({ release: await removePagesFromRelease(ctx.db, rawId(id), pageIds.map(rawId)) }),
  }),
  releasePublish: t.field({
    ...writeOrInvalid,
    type: ReleasePayload,
    description: "Publish every page in the release together. If any page is not ready, nothing is published and fieldErrors name each page (path [pages, id, …]).",
    args: { id: t.arg.globalID({ for: [ReleaseRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ release: await publishRelease(ctx.db, rawId(id), actorOf(ctx)) }),
  }),
  releaseDelete: t.field({
    ...write,
    type: DeletePayload,
    description: "Delete the release; its pages are untouched.",
    args: { id: t.arg.globalID({ for: [ReleaseRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Release", await deleteRelease(ctx.db, rawId(id))) }),
  }),

  frontendCreate: t.field({
    ...settingsWrite,
    type: FrontendPayload,
    args: { input: t.arg({ type: FrontendInput, required: true }) },
    resolve: (_r, { input }, ctx) => createFrontend(ctx.db, sent({ ...input, defaultChannelId: input.defaultChannelId ? rawId(input.defaultChannelId) : input.defaultChannelId })),
  }),
  frontendUpdate: t.field({
    ...settingsWrite,
    type: FrontendPayload,
    args: { id: t.arg.globalID({ for: [FrontendRef], required: true }), input: t.arg({ type: FrontendInput, required: true }) },
    resolve: (_r, { id, input }, ctx) => updateFrontend(ctx.db, rawId(id), sent({ ...input, defaultChannelId: input.defaultChannelId ? rawId(input.defaultChannelId) : input.defaultChannelId })),
  }),
  frontendDelete: t.field({
    ...settingsWrite,
    type: DeletePayload,
    args: { id: t.arg.globalID({ for: [FrontendRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Frontend", await deleteFrontend(ctx.db, rawId(id))) }),
  }),
  frontendDeploy: t.field({
    ...write,
    type: FrontendPayload,
    description: "Call the storefront's deploy hook to rebuild a statically generated site. The result is in lastDeployStatus.",
    args: { id: t.arg.globalID({ for: [FrontendRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ frontend: await deployFrontend(ctx.db, rawId(id)), revalidateSecret: null }),
  }),
  previewSessionCreate: t.field({
    subGraphs: ADMIN,
    authScopes: { permission: "content:read" },
    errors: {},
    type: PreviewSessionPayload,
    description:
      "A preview token for draft content and, given a page or path, the frontend URL to frame (default: the default frontend). " +
      "A template's preview opens a product or category page rendered with it (see productId and categoryId).",
    args: {
      frontendId: t.arg.globalID({ for: [FrontendRef] }),
      pageId: t.arg.globalID({ for: [PageRef] }),
      path: t.arg.string(),
      locale: t.arg({ type: "LocaleCode" }),
      channelId: t.arg.globalID({ for: [ChannelRef] }),
      at: t.arg({ type: "DateTime", description: "Show scheduled content as of this time." }),
      productId: t.arg.globalID({ for: [ProductRef], description: "Product templates: preview with this product. Default: one the template is assigned to, else the newest product." }),
      categoryId: t.arg.globalID({ for: [CategoryRef], description: "Category templates: preview with this category. Default: one the template is assigned to, else the first category." }),
    },
    resolve: async (_r, args, ctx) => {
      if (!ctx.staff) throw new ValidationError("Previews are for staff", [{ path: [], message: "Sign in as a staff user; API keys cannot open previews" }]);
      const frontend = args.frontendId ? await getFrontend(ctx.db, rawId(args.frontendId)) : await defaultFrontend(ctx.db);
      const page = args.pageId ? await getPage(ctx.db, rawId(args.pageId)) : null;
      const kind = page ? await templateKind(ctx, page.type) : null;
      const channel = args.channelId ? await ctx.db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, rawId(args.channelId!)) }) : frontend?.defaultChannelId ? await ctx.db.query.channels.findFirst({ where: (c, { eq }) => eq(c.id, frontend.defaultChannelId!) }) : null;
      // A template's preview renders every product (or category) page with that template.
      const { token, expiresAt } = await createPreviewToken(ctx.platform.config, { staffId: ctx.staff.id, at: args.at?.toISOString() ?? null, templateId: kind ? page!.id : null });
      let path = args.path ?? null;
      // A product's or category's own sections preview on its page.
      const owner = page ? sectionsOwner(page) : null;
      if (!path && owner) path = await templatePreviewPath(ctx, owner, args.locale ?? channel?.defaultLocale ?? ctx.scope.locale);
      if (!path && page && kind) {
        const chosen: TemplateTarget | null =
          kind === "product" && args.productId ? { productId: rawId(args.productId) } : kind === "category" && args.categoryId ? { categoryId: rawId(args.categoryId) } : await templatePreviewTarget(ctx.db, page.id, kind);
        path = await templatePreviewPath(ctx, chosen, args.locale ?? channel?.defaultLocale ?? ctx.scope.locale);
      }
      path ??= page?.draft.path ?? "/";
      return {
        session: {
          token,
          expiresAt,
          url: frontend ? previewUrl(frontend, { token, path, locale: args.locale, channel: channel?.code }) : null,
          adminOrigin: adminOrigin(ctx),
          at: args.at?.toISOString() ?? null,
          path,
        },
      };
    },
  }),
}));
