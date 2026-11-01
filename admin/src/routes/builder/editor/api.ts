import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import type { ComponentDef, FieldDefinition, Variation } from "../model";

/** Query keys share the admin's prefixes, so other screens' invalidations refresh them too. */

export const BUILDER_KEYS = {
  pages: ["pages"] as const,
  // Not under "pages": refreshing the list must not refetch the document being edited.
  page: (id: string) => ["page-editor", id] as const,
  pageMeta: (id: string) => ["page-editor-meta", id] as const,
  versions: (id: string) => ["page-editor-versions", id] as const,
  components: ["components", "builder-library"] as const,
  frontends: ["frontends", "builder"] as const,
  releases: ["releases", "builder-open"] as const,
};

// ---------------------------------------------------------------- library

export const ComponentsQuery = graphql(`
  query BuilderComponents {
    components {
      id
      code
      kind
      name
      description
      groupName
      icon
      previewImageUrl
      fields
      variations
      routable
      singleton
      templateFor
      sectionsFor
    }
  }
`);

type ComponentRow = NonNullable<ResultOf<typeof ComponentsQuery>["components"]>[number];

const toDefinition = (c: ComponentRow): ComponentDef => ({
  id: c.id,
  code: c.code ?? "",
  kind: c.kind === "CONTENT_TYPE" ? "CONTENT_TYPE" : "COMPONENT",
  name: c.name || c.code || "Component",
  description: c.description,
  groupName: c.groupName,
  icon: c.icon,
  previewImageUrl: c.previewImageUrl,
  fields: Array.isArray(c.fields) ? (c.fields as FieldDefinition[]) : [],
  variations: Array.isArray(c.variations) ? (c.variations as Variation[]) : [],
  // Templates and sections never have a path: product and category pages render with them.
  routable: c.kind === "CONTENT_TYPE" && !c.templateFor && !c.sectionsFor ? c.routable !== false : false,
  singleton: !!c.singleton && !c.templateFor && !c.sectionsFor,
  templateFor: c.templateFor ?? null,
  sectionsFor: c.kind === "CONTENT_TYPE" ? (c.sectionsFor ?? null) : null,
});

export type Library = {
  loading: boolean;
  error: unknown;
  list: ComponentDef[];
  /** By code. */
  defs: ReadonlyMap<string, ComponentDef>;
  contentTypes: ComponentDef[];
  components: ComponentDef[];
};

export const useLibrary = (): Library => {
  const query = useQuery({ queryKey: BUILDER_KEYS.components, queryFn: () => request(ComponentsQuery), staleTime: 60_000 });
  return useMemo(() => {
    const list = (query.data?.components ?? []).map(toDefinition).filter((c) => c.code);
    return {
      loading: query.isLoading,
      error: query.error,
      list,
      defs: new Map(list.map((c) => [c.code, c])),
      contentTypes: list.filter((c) => c.kind === "CONTENT_TYPE"),
      components: list.filter((c) => c.kind === "COMPONENT"),
    };
  }, [query.data, query.isLoading, query.error]);
};

export const FrontendsQuery = graphql(`
  query BuilderFrontends {
    frontends {
      id
      name
      url
      previewPath
      isDefault
      defaultChannel {
        id
      }
    }
  }
`);

export type Frontend = NonNullable<ResultOf<typeof FrontendsQuery>["frontends"]>[number];

export const storefrontUrl = (frontend: Pick<Frontend, "url"> | null | undefined, path: string | null | undefined) =>
  frontend?.url && path != null ? `${frontend.url.replace(/\/+$/, "")}${path}` : null;

/** Storefronts, and the one previews use: the default, or the only one. */
export const useFrontends = () => {
  const query = useQuery({ queryKey: BUILDER_KEYS.frontends, queryFn: () => request(FrontendsQuery), staleTime: 60_000 });
  return useMemo(() => {
    const list = query.data?.frontends ?? [];
    const preferred = list.find((f) => f.isDefault) ?? (list.length === 1 ? list[0]! : null);
    return { loading: query.isLoading, error: query.error, list, preferred };
  }, [query.data, query.isLoading, query.error]);
};

// ---------------------------------------------------------------- pages

export const PageStatusFields = graphql(`
  fragment BuilderPageStatus on Page {
    id
    version
    status
    path
    publishedPath
    publishedAt
    scheduledAt
    scheduleError
    draftUpdatedAt
    draftUpdatedBy {
      id
      name
      email
    }
  }
`);

/** Where a template is used. */
export const TemplateTargetsFields = graphql(`
  fragment BuilderTemplateTargets on TemplateTargets {
    isDefault
    products {
      id
      name
      status
      media {
        url
        kind
      }
    }
    categories {
      id
      name
    }
  }
`);

export const PageMetaFields = graphql(
  `
    fragment BuilderPageMeta on Page {
      ...BuilderPageStatus
      type
      title
      createdAt
      firstPublishedAt
      publishedBy {
        id
        name
        email
      }
      allChannels
      channels {
        id
        name
      }
      releases {
        id
        name
        status
        scheduledAt
      }
      templateFor
      templateTargets {
        ...BuilderTemplateTargets
      }
      sectionsFor
      product {
        id
        name
      }
      category {
        id
        name
      }
    }
  `,
  [PageStatusFields, TemplateTargetsFields],
);

export type PageStatusShape = ResultOf<typeof PageStatusFields>;
export type PageMetaShape = ResultOf<typeof PageMetaFields>;
export type PageStatus = NonNullable<PageStatusShape["status"]>;
export type TemplateTargets = ResultOf<typeof TemplateTargetsFields>;

export const PageEditorQuery = graphql(
  `
    query BuilderPageEditor($id: ID!) {
      page(id: $id) {
        ...BuilderPageMeta
        document
      }
    }
  `,
  [PageMetaFields],
);

export const PageMetaQuery = graphql(
  `
    query BuilderPageMetaPoll($id: ID!) {
      page(id: $id) {
        ...BuilderPageMeta
      }
    }
  `,
  [PageMetaFields],
);

/** `sort` defaults to PATH; UPDATED puts the latest draft saves first. */
export const PagesQuery = graphql(`
  query BuilderPages($first: Int, $after: String, $query: String, $type: String, $status: PageStatus, $sort: PageSort) {
    pages(first: $first, after: $after, query: $query, type: $type, status: $status, sort: $sort) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          type
          title
          path
          publishedPath
          status
          scheduledAt
          draftUpdatedAt
          draftUpdatedBy {
            id
            name
            email
          }
          allChannels
          channels {
            id
            name
          }
          templateFor
          templateTargets {
            isDefault
            products {
              id
              name
            }
            categories {
              id
              name
            }
          }
        }
      }
    }
  }
`);

export type PageRow = NonNullable<NonNullable<NonNullable<NonNullable<ResultOf<typeof PagesQuery>["pages"]>["edges"]>[number]>["node"]>;

export const SingletonPageQuery = graphql(`
  query BuilderSingletonPage($type: String!) {
    singletonPage(type: $type) {
      id
    }
  }
`);

export const PageByPathQuery = graphql(`
  query BuilderPageByPath($path: String!) {
    page(path: $path) {
      id
      title
      path
      type
    }
  }
`);

export const PageSearchQuery = graphql(`
  query BuilderPageSearch($query: String) {
    pages(query: $query, first: 20) {
      edges {
        node {
          id
          title
          path
          type
          status
        }
      }
    }
  }
`);

export const PageVersionsQuery = graphql(`
  query BuilderPageVersions($id: ID!) {
    page(id: $id) {
      id
      versions {
        id
        version
        kind
        label
        createdAt
        createdBy {
          id
          name
          email
        }
      }
    }
  }
`);

export type PageVersionRow = NonNullable<NonNullable<NonNullable<ResultOf<typeof PageVersionsQuery>["page"]>["versions"]>[number]>;

export const PageCreateMutation = graphql(
  `
    mutation BuilderPageCreate($input: PageCreateInput!) {
      pageCreate(input: $input) {
        __typename
        ... on PagePayload {
          page {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const PageSaveDraftMutation = graphql(
  `
    mutation BuilderPageSaveDraft($id: ID!, $baseVersion: Int!, $document: JSON!) {
      pageSaveDraft(id: $id, baseVersion: $baseVersion, document: $document) {
        __typename
        ... on PagePayload {
          page {
            ...BuilderPageStatus
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, PageStatusFields],
);

export const PagePublishMutation = graphql(
  `
    mutation BuilderPagePublish($id: ID!, $version: Int) {
      pagePublish(id: $id, version: $version) {
        __typename
        ... on PagePayload {
          page {
            ...BuilderPageStatus
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, PageStatusFields],
);

export const PageUnpublishMutation = graphql(
  `
    mutation BuilderPageUnpublish($id: ID!) {
      pageUnpublish(id: $id) {
        __typename
        ... on PagePayload {
          page {
            ...BuilderPageStatus
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, PageStatusFields],
);

export const PageScheduleMutation = graphql(
  `
    mutation BuilderPageSchedule($id: ID!, $at: DateTime) {
      pageSchedule(id: $id, at: $at) {
        __typename
        ... on PagePayload {
          page {
            ...BuilderPageStatus
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, PageStatusFields],
);

export const PageDiscardMutation = graphql(
  `
    mutation BuilderPageDiscard($id: ID!) {
      pageDiscardDraft(id: $id) {
        __typename
        ... on PagePayload {
          page {
            ...BuilderPageMeta
            document
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, PageMetaFields],
);

export const PageDuplicateMutation = graphql(
  `
    mutation BuilderPageDuplicate($id: ID!) {
      pageDuplicate(id: $id) {
        __typename
        ... on PagePayload {
          page {
            id
            path
            title
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const PageDeleteMutation = graphql(
  `
    mutation BuilderPageDelete($id: ID!) {
      pageDelete(id: $id) {
        __typename
        ... on DeletePayload {
          deletedId
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const PageSettingsMutation = graphql(
  `
    mutation BuilderPageSettings($id: ID!, $channelIds: [ID!]) {
      pageSettingsUpdate(id: $id, channelIds: $channelIds) {
        __typename
        ... on PagePayload {
          page {
            id
            allChannels
            channels {
              id
              name
            }
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** Assign a template: omitted keys stay as they are, lists replace its products or categories. */
export const PageTemplateTargetsMutation = graphql(
  `
    mutation BuilderPageTemplateTargets($id: ID!, $input: TemplateTargetsInput!) {
      pageTemplateTargetsUpdate(id: $id, input: $input) {
        __typename
        ... on PagePayload {
          page {
            id
            templateTargets {
              ...BuilderTemplateTargets
            }
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, TemplateTargetsFields],
);

/** A product or category's own template: a draft copy of the one it uses, or its existing own one. */
export const PageTemplateCustomizeMutation = graphql(
  `
    mutation BuilderPageTemplateCustomize($productId: ID, $categoryId: ID) {
      pageTemplateCustomize(productId: $productId, categoryId: $categoryId) {
        __typename
        ... on PagePayload {
          page {
            id
            title
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** A product or category's own sections: an empty draft (or the sections it has already). */
export const PageSectionsCreateMutation = graphql(
  `
    mutation BuilderPageSectionsCreate($productId: ID, $categoryId: ID) {
      pageSectionsCreate(productId: $productId, categoryId: $categoryId) {
        __typename
        ... on PagePayload {
          page {
            id
            title
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const PageVersionSaveMutation = graphql(
  `
    mutation BuilderPageVersionSave($id: ID!, $label: String) {
      pageVersionSave(id: $id, label: $label) {
        __typename
        ... on PagePayload {
          page {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const PageVersionRestoreMutation = graphql(
  `
    mutation BuilderPageVersionRestore($id: ID!, $versionId: ID!) {
      pageVersionRestore(id: $id, versionId: $versionId) {
        __typename
        ... on PagePayload {
          page {
            ...BuilderPageMeta
            document
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, PageMetaFields],
);

// ---------------------------------------------------------------- releases and previews

export const OpenReleasesQuery = graphql(`
  query BuilderOpenReleases {
    releases {
      id
      name
      description
      status
      scheduledAt
    }
  }
`);

export const ReleaseCreateMutation = graphql(
  `
    mutation BuilderReleaseCreate($input: ReleaseInput!, $pageIds: [ID!]) {
      releaseCreate(input: $input, pageIds: $pageIds) {
        __typename
        ... on ReleasePayload {
          release {
            id
            name
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const ReleaseAddPagesMutation = graphql(
  `
    mutation BuilderReleaseAddPages($id: ID!, $pageIds: [ID!]!) {
      releaseAddPages(id: $id, pageIds: $pageIds) {
        __typename
        ... on ReleasePayload {
          release {
            id
            name
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const PreviewSessionMutation = graphql(
  `
    mutation BuilderPreviewSession($frontendId: ID, $pageId: ID, $path: String, $locale: LocaleCode, $channelId: ID, $productId: ID, $categoryId: ID) {
      previewSessionCreate(frontendId: $frontendId, pageId: $pageId, path: $path, locale: $locale, channelId: $channelId, productId: $productId, categoryId: $categoryId) {
        __typename
        ... on PreviewSessionPayload {
          session {
            url
            path
            expiresAt
            adminOrigin
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** What a storefront path shows, to name the product or category a template preview is on. */
export const PreviewRouteQuery = graphql(`
  query BuilderPreviewRoute($path: String!) {
    route(path: $path) {
      __typename
      ... on Product {
        id
        name
        media {
          url
          kind
        }
      }
      ... on Category {
        id
        name
      }
    }
  }
`);

// ---------------------------------------------------------------- references in content

export const ProductSearchQuery = graphql(`
  query BuilderProductSearch($query: String) {
    products(query: $query, first: 15) {
      edges {
        node {
          id
          name
          status
          media {
            url
            kind
          }
        }
      }
    }
  }
`);

export const NodeNamesQuery = graphql(`
  query BuilderNodeNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Page {
        id
        title
        path
      }
      ... on Product {
        id
        name
        status
        media {
          url
          kind
        }
      }
      ... on Category {
        id
        name
      }
    }
  }
`);

export type ReferenceSummary = { id: string; label: string; hint?: string; image?: string | null; missing?: boolean };

/** Names (and thumbnails) for pages, products and categories referenced by id. */
export const useReferenceNames = (ids: readonly string[]) => {
  const sorted = useMemo(() => [...new Set(ids.filter(Boolean))].sort(), [ids]);
  const query = useQuery({
    queryKey: ["builder-reference-names", sorted],
    queryFn: () => request(NodeNamesQuery, { ids: sorted }),
    enabled: sorted.length > 0,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const names = new Map<string, ReferenceSummary>();
    for (const node of query.data?.nodes ?? []) {
      if (!node) continue;
      if (node.__typename === "Page" && "path" in node) names.set(node.id, { id: node.id, label: node.title || node.path || "Untitled page", hint: node.path ?? undefined });
      if (node.__typename === "Product" && "name" in node && "status" in node) {
        const image = (node.media ?? []).find((m) => m.kind !== "VIDEO")?.url ?? null;
        names.set(node.id, { id: node.id, label: node.name || "Untitled product", hint: node.status && node.status !== "ACTIVE" ? node.status.toLowerCase() : undefined, image });
      }
      if (node.__typename === "Category" && "name" in node) names.set(node.id, { id: node.id, label: node.name || "Untitled category" });
    }
    // Ids the API didn't return were deleted or aren't visible.
    if (query.data) for (const id of sorted) if (!names.has(id)) names.set(id, { id, label: "Not found", missing: true });
    return { names, loading: query.isLoading };
  }, [query.data, query.isLoading, sorted]);
};

/** The raw UUID of a global id, for prettier URLs ("gid://ecom/Page/0192…" → "0192…"). */
export const rawIdOf = (gid: string) => (gid.startsWith("gid://") ? (gid.split("/").pop() ?? gid) : gid);
export const pageGid = (id: string) => (id.startsWith("gid://") ? id : `gid://ecom/Page/${id}`);
