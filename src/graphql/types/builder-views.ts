import type { BuilderPage } from "../../modules/builder/pages.ts";
import type { GraphQLContext } from "../context.ts";
import type { PageView } from "../refs.ts";

/** A builder page as each audience sees it. */
export const views = {
  draft: (page: BuilderPage): PageView => ({ ...page, view: "draft" }),
  published: (page: BuilderPage): PageView => ({ ...page, view: "published" }),
};

/** Admin callers and storefront previews see drafts; everyone else the published version, if any. */
export const viewFor = (ctx: GraphQLContext, page: BuilderPage | null): PageView | null => {
  if (!page) return null;
  if (ctx.api === "admin" || ctx.preview) return views.draft(page);
  return page.published ? views.published(page) : null;
};

export const documentOf = (page: PageView) => (page.view === "published" && page.published ? page.published : page.draft);

/** A page with no channels is served in every channel. */
export const servedInChannel = (ctx: GraphQLContext, page: BuilderPage) => ctx.api === "admin" || page.channelIds.length === 0 || page.channelIds.includes(ctx.scope.channel.id);

export const isPageView = (value: object): value is PageView => "view" in value && "draft" in value;
