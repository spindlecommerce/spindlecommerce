import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LayoutTemplate, Paintbrush, Plus, Rows3, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog, Tooltip } from "@/components/ui/overlay";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { BUILDER_KEYS, PageSectionsCreateMutation, PageTemplateCustomizeMutation, PageTemplateTargetsMutation, rawIdOf, useLibrary } from "@/routes/builder/editor/api";
import { StatusBadge } from "@/routes/builder/editor/status";
import { TEMPLATE_KINDS, type TemplateFor } from "@/routes/builder/model";
import { CATALOG_KEYS } from "./shared";

/** The "Page design" card: which template a product or category page uses, and its own sections. */

const TemplateMatchFields = graphql(`
  fragment CatalogTemplateMatch on TemplateMatch {
    source
    category {
      id
      name
    }
    page {
      id
      title
      status
      publishedAt
      scheduledAt
      templateTargets {
        isDefault
        products {
          id
        }
        categories {
          id
        }
      }
    }
  }
`);

const OwnSectionsFields = graphql(`
  fragment CatalogOwnSections on Page {
    id
    title
    status
    scheduledAt
  }
`);

const ProductPageDesignQuery = graphql(
  `
    query ProductPageDesign($id: ID!) {
      product(id: $id) {
        id
        templateMatch {
          ...CatalogTemplateMatch
        }
        liveTemplate: templateMatch(live: true) {
          ...CatalogTemplateMatch
        }
        sections {
          ...CatalogOwnSections
        }
      }
    }
  `,
  [TemplateMatchFields, OwnSectionsFields],
);

const CategoryPageDesignQuery = graphql(
  `
    query CategoryPageDesign($id: ID!) {
      category(id: $id) {
        id
        templateMatch {
          ...CatalogTemplateMatch
        }
        liveTemplate: templateMatch(live: true) {
          ...CatalogTemplateMatch
        }
        sections {
          ...CatalogOwnSections
        }
      }
    }
  `,
  [TemplateMatchFields, OwnSectionsFields],
);

type Match = ResultOf<typeof TemplateMatchFields>;

const reasonOf = (kind: TemplateFor, match: Match) => {
  const names = TEMPLATE_KINDS[kind];
  if (match.source === kind) return `Its own template, assigned to this ${names.one} only.`;
  if (match.source === "CATEGORY") return `Via ${match.category?.name ?? "one of its categories"}: the nearest of its categories with a template.`;
  return `The default for ${names.pages}: no more specific template is assigned.`;
};

const describe = (match: Match) =>
  `${match.page?.title || "an untitled template"}${match.source === "DEFAULT" ? " (the default)" : match.source === "CATEGORY" && match.category?.name ? ` (via ${match.category.name})` : ""}`;

export const PageDesignCard = ({ kind, id, name }: { kind: TemplateFor; id: string; name: string }) => {
  const { can } = useAuth();
  if (!can("content:read")) return null;
  return <PageDesign kind={kind} id={id} name={name} write={can("content:write")} />;
};

const PageDesign = ({ kind, id, name, write }: { kind: TemplateFor; id: string; name: string; write: boolean }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const library = useLibrary();
  const names = TEMPLATE_KINDS[kind];
  // Under the catalog keys, so saving the product's categories or moving categories refreshes it.
  const queryKey = kind === "PRODUCT" ? [...CATALOG_KEYS.products, "page-design", id] : [...CATALOG_KEYS.categories, "page-design", id];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => (kind === "PRODUCT" ? (await request(ProductPageDesignQuery, { id }, { signal })).product : (await request(CategoryPageDesignQuery, { id }, { signal })).category),
  });
  const [confirming, setConfirming] = useState(false);
  const match = query.data?.templateMatch ?? null;
  const live = query.data?.liveTemplate ?? null;
  const page = match?.page ?? null;
  const own = match?.source === kind;
  // The editor opens the template previewing this product or category.
  const preview = kind === "PRODUCT" ? { product: id } : { category: id };
  const openEditor = (pageId: string) => void navigate({ to: "/pages/$id", params: { id: rawIdOf(pageId) }, search: preview });

  const sections = query.data?.sections ?? null;
  // Sections need a content type that holds them; without one the block stays hidden.
  const sectionsType = library.contentTypes.find((c) => c.sectionsFor === kind) ?? null;
  const addSections = useAction(async () => unwrap((await request(PageSectionsCreateMutation, kind === "PRODUCT" ? { productId: id } : { categoryId: id })).pageSectionsCreate).page, {
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey });
      if (!created) return;
      toast.success(`Added sections to ${name || `this ${names.one}`}`, { description: "Add components, then publish them to show them on its page." });
      void navigate({ to: "/pages/$id", params: { id: rawIdOf(created.id) } });
    },
  });

  const customize = useAction(async () => unwrap((await request(PageTemplateCustomizeMutation, kind === "PRODUCT" ? { productId: id } : { categoryId: id })).pageTemplateCustomize).page, {
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.pages });
      if (!created) return;
      toast.success(`Created ${created.title || "a template"}`, { description: `A draft for this ${names.one} only. Visitors keep the current design until you publish it.` });
      openEditor(created.id);
    },
  });

  // Its own assignment goes; the template keeps its other products, categories and default.
  const share = useAction(
    async () => {
      const targets = page?.templateTargets;
      if (!page) throw new Error("No template to leave");
      const input = kind === "PRODUCT" ? { productIds: (targets?.products ?? []).map((p) => p.id).filter((x) => x !== id) } : { categoryIds: (targets?.categories ?? []).map((c) => c.id).filter((x) => x !== id) };
      return unwrap((await request(PageTemplateTargetsMutation, { id: page.id, input })).pageTemplateTargetsUpdate);
    },
    {
      invalidate: [queryKey, BUILDER_KEYS.pages],
      onSuccess: () => {
        setConfirming(false);
        toast.success("Now uses the shared design", { description: `${page?.title || "The template"} stays in Pages, so you can assign it again.` });
      },
    },
  );

  const others = page ? (kind === "PRODUCT" ? (page.templateTargets?.products ?? []) : (page.templateTargets?.categories ?? [])).filter((t) => t.id !== id).length : 0;
  // Visitors only get published templates: say what they see while this one is not.
  const visitorsSee =
    page && live?.page?.id !== page.id
      ? live?.page
        ? `This template is not published, so visitors see ${describe(live)} for now.`
        : `This template is not published, so visitors see the storefront's built-in ${names.one} page for now.`
      : page?.status === "CHANGED"
        ? "Visitors see the published version; its latest changes are not published yet."
        : null;
  // Without a template content type of this kind there is nothing to customize from.
  const designable = !!page || library.contentTypes.some((c) => c.templateFor === kind);

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>Page design</CardTitle>
          <CardDescription>The page builder template this {names.one}&apos;s storefront page renders with, and any sections of its own.</CardDescription>
        </div>
        {page ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/pages/$id" params={{ id: rawIdOf(page.id) }} search={preview}>
              <Paintbrush />
              Edit design
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {query.isLoading ? (
          <Skeleton className="h-16" />
        ) : query.error ? (
          <p className="text-[13px] text-destructive">{query.error instanceof Error ? query.error.message : "Could not load the page design"}</p>
        ) : match && page ? (
          <>
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-info/12 text-info">
                <LayoutTemplate className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <Link to="/pages/$id" params={{ id: rawIdOf(page.id) }} search={preview} className="truncate text-sm font-medium hover:underline">
                    {page.title || "Untitled template"}
                  </Link>
                  <StatusBadge status={page.status} scheduledAt={page.scheduledAt} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{reasonOf(kind, match)}</p>
              </div>
            </div>
            {visitorsSee ? <p className="text-xs text-warning">{visitorsSee}</p> : null}
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            No template applies, so the storefront shows its built-in {names.one} page.
            {!designable && !library.loading ? (
              <>
                {" "}
                To design {names.pages}, add a content type that is a template for {names.many} in{" "}
                <Link to="/components" className="text-primary hover:underline">
                  Components
                </Link>
                .
              </>
            ) : null}
          </p>
        )}
        {write && designable && !query.isLoading && !query.error ? (
          <div className="flex flex-wrap gap-2">
            {own ? (
              <Tooltip content={`Stop using its own template; it goes back to ${kind === "PRODUCT" ? "its category's template or the default" : "the default template"}.`}>
                <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                  <Undo2 />
                  Use the shared design
                </Button>
              </Tooltip>
            ) : (
              <Tooltip content={`A draft copy of ${page ? `“${page.title || "the template"}”` : "an empty template"} for this ${names.one} only, opened in the editor. Visitors keep the current design until you publish it.`}>
                <Button variant="outline" size="sm" loading={customize.isPending} onClick={() => customize.mutate(undefined)}>
                  <LayoutTemplate />
                  Customize for this {names.one}
                </Button>
              </Tooltip>
            )}
          </div>
        ) : null}
        {!query.isLoading && !query.error && (sections || sectionsType) ? (
          <div className="grid gap-2 border-t pt-3">
            <p className="text-[13px] font-medium">Its own sections</p>
            {sections ? (
              <>
                <div className="flex items-start gap-3 rounded-lg border p-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-info/12 text-info">
                    <Rows3 className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <Link to="/pages/$id" params={{ id: rawIdOf(sections.id) }} className="truncate text-sm font-medium hover:underline">
                        {sections.title || names.sections}
                      </Link>
                      <StatusBadge status={sections.status} scheduledAt={sections.scheduledAt} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Components for this {names.one} only, shown where its template places its sections.</p>
                  </div>
                </div>
                {sections.status === "DRAFT" || sections.status === "SCHEDULED" ? (
                  <p className="text-xs text-warning">Not published yet, so visitors don&apos;t see them.</p>
                ) : sections.status === "CHANGED" ? (
                  <p className="text-xs text-warning">Visitors see the published version; its latest changes are not published yet.</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/pages/$id" params={{ id: rawIdOf(sections.id) }}>
                      <Paintbrush />
                      Edit sections
                    </Link>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-[13px] text-muted-foreground">
                  Add components to this {names.one}&apos;s page only, such as a story, a size guide or a video. They show where its template places its sections.
                </p>
                {write ? (
                  <div className="flex flex-wrap gap-2">
                    <Tooltip content={`An empty draft of ${sectionsType?.name ?? names.sections}, opened in the editor. Nothing changes for visitors until you publish it.`}>
                      <Button variant="outline" size="sm" loading={addSections.isPending} onClick={() => addSections.mutate(undefined)}>
                        <Plus />
                        Add sections
                      </Button>
                    </Tooltip>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Use the shared design?"
        description={
          <>
            {name || `This ${names.one}`} stops using {page?.title ? `“${page.title}”` : "its own template"} and renders with {kind === "PRODUCT" ? "its category's template or the default" : "the default template"}, at once
            {page?.publishedAt ? ", for visitors too" : ""}. The template stays in Pages{others ? `, still assigned to ${others} other ${others === 1 ? names.one : names.many}` : ""}, so you can assign it again.
          </>
        }
        confirmLabel="Use the shared design"
        loading={share.isPending}
        onConfirm={() => share.mutate(undefined)}
      />
    </Card>
  );
};
