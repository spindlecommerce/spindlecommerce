import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Info, LayoutTemplate, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { Tooltip } from "@/components/ui/overlay";
import { graphql, type VariablesOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { useCategoryOptions } from "@/routes/catalog/shared";
import { TEMPLATE_KINDS, targetsSummary, type TemplateFor } from "../model";
import { BUILDER_KEYS, PageTemplateTargetsMutation, PreviewRouteQuery, useReferenceNames, type TemplateTargets } from "./api";
import { FieldShell } from "./fields";
import { CategoryPicker, ProductSearchPopover, Thumb } from "./pickers";
import { useEditor, useEditorState } from "./store";

/** Templates in the editor: where one is used, its top bar badge and what its preview shows. */

/** /products/<slug> or /categories/<slug path>, optionally after a language prefix (/de/…). */
export const isTemplatePath = (kind: TemplateFor, path: string) =>
  (kind === "PRODUCT" ? /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/products\/[^/]+\/?$/ : /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/categories\/[^/]/).test(path);

/** The selection path that opens the template settings tab. */
export const TEMPLATE_FOCUS = "@template";

// ---------------------------------------------------------------- top bar

/** "Product template · Default · 2 categories": opens the template settings. */
export const TemplateBadge = ({ onOpen }: { onOpen: () => void }) => {
  const { contentType, actions, store } = useEditor();
  const targets = useEditorState((s) => s.meta.templateTargets);
  const kind = contentType.templateFor;
  if (!kind) return null;
  const names = TEMPLATE_KINDS[kind];
  return (
    <Tooltip content={`You are editing a template: it has no path, and ${names.pages} render with it where it applies. Click to change where it is used.`}>
      <button
        type="button"
        onClick={() => {
          onOpen();
          actions.select({ nodeId: store.get().doc.root.id, path: [TEMPLATE_FOCUS] }, { focus: "reveal" });
        }}
        className="flex min-w-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Badge variant="info" className="max-w-full min-w-0 shrink py-0 text-[11px] leading-4 hover:bg-info/20">
          <LayoutTemplate className="shrink-0" />
          <span className="truncate">
            {names.template} · {targetsSummary(targets)}
          </span>
        </Badge>
      </button>
    </Tooltip>
  );
};

// ---------------------------------------------------------------- where it is used

type Targets = { isDefault: boolean; productIds: string[]; categoryIds: string[] };
type TargetsInput = VariablesOf<typeof PageTemplateTargetsMutation>["input"];

const toTargets = (stored: TemplateTargets | null | undefined): Targets => ({
  isDefault: !!stored?.isDefault,
  productIds: (stored?.products ?? []).map((p) => p.id),
  categoryIds: (stored?.categories ?? []).map((c) => c.id),
});

/** Templates of a kind, with what they are assigned to, to say what an assignment takes over. */
const TemplatePagesQuery = graphql(`
  query BuilderTemplatePages($type: String!) {
    pages(type: $type, first: 100) {
      edges {
        node {
          id
          title
          status
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
    }
  }
`);

type Owner = { title: string; published: boolean };
/** Of two templates assigned the same thing, the published one serves it; a draft waits. */
const serving = (current: Owner | null | undefined, next: Owner) => (!current || (next.published && !current.published) ? next : current);
const ownerLabel = (owner: Owner) => (owner.published ? owner.title : `${owner.title} (draft)`);

/** The other templates of this kind: which serves the default, and each category and product. */
const useOtherTemplates = (kind: TemplateFor, pageId: string) => {
  const { defs } = useEditor();
  const types = useMemo(() => [...defs.values()].filter((d) => d.kind === "CONTENT_TYPE" && d.templateFor === kind).map((d) => d.code), [defs, kind]);
  const results = useQueries({
    queries: types.map((type) => ({ queryKey: [...BUILDER_KEYS.pages, "templates", type], queryFn: () => request(TemplatePagesQuery, { type }), staleTime: 30_000 })),
  });
  const loaded = results.map((r) => r.dataUpdatedAt).join();
  return useMemo(() => {
    const owners = { isDefault: null as Owner | null, products: new Map<string, Owner>(), categories: new Map<string, Owner>() };
    for (const result of results) {
      for (const edge of result.data?.pages?.edges ?? []) {
        const page = edge?.node;
        if (!page || page.id === pageId) continue;
        const owner = { title: page.title || "Untitled template", published: page.status !== "DRAFT" };
        if (page.templateTargets?.isDefault) owners.isDefault = serving(owners.isDefault, owner);
        for (const p of page.templateTargets?.products ?? []) owners.products.set(p.id, serving(owners.products.get(p.id), owner));
        for (const c of page.templateTargets?.categories ?? []) owners.categories.set(c.id, serving(owners.categories.get(c.id), owner));
      }
    }
    return owners;
    // Recomputed when any of the lists loads again.
  }, [pageId, loaded]);
};

/** The template's assignments. Each change saves at once, queued behind the one before. */
export const TemplateSettings = () => {
  const { contentType, pageId, actions, store } = useEditor();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const write = can("content:write");
  const kind = contentType.templateFor!;
  const names = TEMPLATE_KINDS[kind];
  const stored = useEditorState((s) => s.meta.templateTargets);
  const published = useEditorState((s) => !!s.meta.publishedAt);
  const categoryOptions = useCategoryOptions();
  const others = useOtherTemplates(kind, pageId);

  const [targets, setTargets] = useState(() => toTargets(stored));
  const pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Follow changes made elsewhere (the product or category screens, another tab) while idle.
  const signature = JSON.stringify(toTargets(stored));
  useEffect(() => {
    if (!pending.current) setTargets(toTargets(stored));
  }, [signature]);

  /** `note` says what else the change did: the template it took from, or no default left. */
  const save = (input: TargetsInput, next: Targets, success: string, note?: string | null) => {
    setTargets(next);
    pending.current++;
    queue.current = queue.current.then(async () => {
      try {
        const page = unwrap((await request(PageTemplateTargetsMutation, { id: pageId, input })).pageTemplateTargetsUpdate).page;
        if (page) actions.setMeta({ templateTargets: page.templateTargets });
        const visitors = published ? "Visitors see the change now." : "Visitors see it once this template is published.";
        toast.success(success, { id: "template-targets", description: note ? `${note} ${visitors}` : visitors });
        void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.pages });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not change where the template is used", { id: "template-targets" });
      } finally {
        pending.current--;
        // Settled: show what the API has, which also undoes a change it refused.
        if (!pending.current) setTargets(toTargets(store.get().meta.templateTargets));
      }
    });
  };

  // What an assignment does to the template serving it now: published templates take it at once.
  const takenFrom = (owner: Owner | null | undefined) => (!owner ? null : published ? `Taken from ${ownerLabel(owner)}.` : `${ownerLabel(owner)} keeps it until this template is published.`);
  const setDefault = (isDefault: boolean) =>
    save(
      { isDefault },
      { ...targets, isDefault },
      isDefault ? `Now the default for ${names.pages}` : `No longer the default for ${names.pages}`,
      isDefault
        ? others.isDefault
          ? published
            ? `${ownerLabel(others.isDefault)} is no longer the default.`
            : `${ownerLabel(others.isDefault)} stays the default until this template is published.`
          : null
        : others.isDefault?.published
          ? `${others.isDefault.title} is the default.`
          : others.isDefault
            ? `There is no published default now: ${ownerLabel(others.isDefault)} becomes it when it is published.`
            : `There is no default now: ${names.pages} without another template use the storefront's built-in layout.`,
    );
  const setCategories = (categoryIds: string[]) => {
    const added = categoryIds.find((id) => !targets.categoryIds.includes(id));
    save({ categoryIds }, { ...targets, categoryIds }, added ? "Category assigned" : categoryIds.length ? "Category removed" : "No categories assigned", added ? takenFrom(others.categories.get(added)) : null);
  };
  const setProducts = (productIds: string[]) => {
    const added = productIds.find((id) => !targets.productIds.includes(id));
    save({ productIds }, { ...targets, productIds }, added ? "Product assigned" : productIds.length ? "Product removed" : "No products assigned", added ? takenFrom(others.products.get(added)) : null);
  };

  // Categories another template serves name it, since assigning one here takes it over.
  const options = useMemo(() => {
    const list = categoryOptions.options.map((o) => {
      const owner = targets.categoryIds.includes(o.value) ? undefined : others.categories.get(o.value);
      return owner ? { ...o, hint: [o.hint, ownerLabel(owner)].filter(Boolean).join(" · ") } : o;
    });
    // Assigned categories the list lacks (loading, or catalog not readable): named from the page.
    for (const c of stored?.categories ?? []) if (!list.some((o) => o.value === c.id)) list.push({ value: c.id, label: c.name ?? "Untitled category", hint: undefined });
    return list;
  }, [categoryOptions.options, others, targets.categoryIds, stored]);

  return (
    <div data-field-path={TEMPLATE_FOCUS} className="flex flex-col gap-5 rounded-lg transition-[background-color,box-shadow] duration-500 data-[flash=true]:bg-primary/8 data-[flash=true]:ring-4 data-[flash=true]:ring-primary/8">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {kind === "PRODUCT"
          ? "A product page renders with the most specific template: the product's own, then its nearest category's, then the default."
          : "A category page renders with its own template, else the default."}{" "}
        Visitors get one published template for each {names.one} and for the default.
      </p>

      <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">Default for all {names.many}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {targets.isDefault
              ? `Every ${names.one} page without a more specific template renders with it.`
              : others.isDefault
                ? `Now the default is ${ownerLabel(others.isDefault)}; turning this on replaces it${published ? "" : " once this template is published"}.`
                : `There is no default: ${names.pages} without a template use the storefront's built-in layout.`}
          </p>
          {targets.isDefault && !published ? (
            <p className="mt-1 text-xs text-warning">
              Until this template is published, visitors keep {others.isDefault?.published ? `${others.isDefault.title} as the default` : `the storefront's built-in layout for ${names.pages} without another template`}.
            </p>
          ) : null}
        </div>
        <Switch checked={targets.isDefault} onCheckedChange={setDefault} disabled={!write} aria-label={`Default for all ${names.many}`} />
      </div>

      <FieldShell
        path="@template.categories"
        label="Categories"
        description={
          kind === "PRODUCT" ? "The products in these categories and their subcategories, unless a product has its own template or a deeper category has one." : "The pages of these categories (not their subcategories)."
        }
      >
        <MultiSelect options={options} value={targets.categoryIds} onChange={setCategories} placeholder="No categories" searchPlaceholder="Search categories…" disabled={!write} />
      </FieldShell>

      {kind === "PRODUCT" ? <ProductTargets ids={targets.productIds} stored={stored} onChange={setProducts} disabled={!write} /> : null}

      <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" />
        <span>
          Changes save at once, without publishing.{" "}
          {published
            ? `This template is published, so it takes ${kind === "PRODUCT" ? "a product, a category" : "a category"} or the default from the template serving it (the category list names it) right away.`
            : `Until this template is published, visitors keep the template serving ${kind === "PRODUCT" ? "each product and category" : "each category"} now (the category list names it); publishing takes them over.`}
        </span>
      </p>
      {!write ? <p className="text-xs text-muted-foreground">Changing where a template is used needs the content:write permission.</p> : null}
    </div>
  );
};

const ProductTargets = ({ ids, stored, onChange, disabled }: { ids: string[]; stored: TemplateTargets | null | undefined; onChange: (ids: string[]) => void; disabled: boolean }) => {
  const { names } = useReferenceNames(ids);
  // Names the page already loaded, so assigned products do not flash "Loading…".
  const known = useMemo(() => new Map((stored?.products ?? []).map((p) => [p.id, { label: p.name ?? "Untitled product", image: (p.media ?? []).find((m) => m.kind !== "VIDEO")?.url ?? null }])), [stored]);
  return (
    <FieldShell path="@template.products" label="Products" description="These products, whatever their categories. A product's own template replaces any other once this one is published.">
      <div className="flex flex-col gap-1.5">
        {ids.length ? (
          <ul className="flex flex-col overflow-hidden rounded-md border">
            {ids.map((id) => {
              const product = names.get(id);
              const label = product?.label ?? known.get(id)?.label ?? "Loading…";
              return (
                <li key={id} className="group flex items-center gap-2 border-b bg-background px-1.5 py-1 last:border-b-0">
                  <Thumb src={product?.image ?? known.get(id)?.image} />
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", product?.missing && "text-destructive")}>{label}</span>
                  {product?.hint ? <span className="text-[10px] text-muted-foreground">{product.hint}</span> : null}
                  {disabled ? null : (
                    <Tooltip content="Remove">
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        onClick={() => onChange(ids.filter((x) => x !== id))}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </Tooltip>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <ProductSearchPopover selected={ids} closeOnPick={false} disabled={disabled} onPick={(id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])}>
            <Button type="button" variant="outline" size="sm" disabled={disabled}>
              <Search />
              {ids.length ? "Add products" : "Choose products"}
            </Button>
          </ProductSearchPopover>
          <span className="text-xs text-muted-foreground">{ids.length ? `${ids.length} assigned` : "None"}</span>
        </div>
      </div>
    </FieldShell>
  );
};

// ---------------------------------------------------------------- preview

/**
 * The product or category a template's preview shows, following the frame as it browses, and a
 * picker that opens a new preview on another.
 */
export const PreviewWith = ({ path }: { path: string | null }) => {
  const { contentType, store } = useEditor();
  const kind = contentType.templateFor;
  const chosen = useEditorState((s) => s.previewWith);
  const resolvable = !!kind && !!path && isTemplatePath(kind, path);
  const route = useQuery({ queryKey: ["builder-preview-route", path], queryFn: () => request(PreviewRouteQuery, { path: path! }), enabled: resolvable, staleTime: 60_000, retry: false });
  if (!kind) return null;
  const node = route.data?.route;
  const shown =
    node?.__typename === "Product" && kind === "PRODUCT"
      ? { id: node.id, name: node.name ?? "Untitled product", image: (node.media ?? []).find((m) => m.kind !== "VIDEO")?.url ?? null }
      : node?.__typename === "Category" && kind === "CATEGORY"
        ? { id: node.id, name: node.name ?? "Untitled category", image: null }
        : null;
  const names = TEMPLATE_KINDS[kind];
  const choose = (id: string | null) => {
    // Already on screen and nothing was picked: keep the preview as it is.
    if (id && id === shown?.id && !chosen) return;
    store.set({ previewWith: id });
  };
  const fallback = route.isLoading && resolvable ? "Loading…" : (path ?? `Choose a ${names.one}`);
  const hint = (
    <>
      Every {names.one} page in this preview renders with the template, so you can browse to others too.{" "}
      {chosen ? `Pick another ${names.one} to preview with.` : `Picked automatically (one the template is assigned to, if any); choose another ${names.one} to preview with.`}
      {path ? <span className="mt-1 block font-mono opacity-80">{path}</span> : null}
    </>
  );
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5">
      <span className="hidden text-xs whitespace-nowrap text-muted-foreground xl:inline">Preview with</span>
      <Tooltip content={hint}>
        <span className="flex min-w-0">
          {kind === "PRODUCT" ? (
            <ProductSearchPopover selected={shown ? [shown.id] : chosen ? [chosen] : []} onPick={choose}>
              <button
                type="button"
                aria-label={`Preview with another product (now ${shown?.name ?? fallback})`}
                className="flex h-7 max-w-52 min-w-0 items-center gap-1.5 rounded-md border bg-background pr-1.5 pl-1 text-xs shadow-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Thumb src={shown?.image} className="size-5 rounded-sm" />
                <span className={cn("min-w-0 truncate", !shown && "text-muted-foreground")}>{shown?.name ?? fallback}</span>
                <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
              </button>
            </ProductSearchPopover>
          ) : (
            <CategoryPicker value={shown?.id ?? chosen} onChange={choose} placeholder={fallback} className="h-7 min-h-7 w-52 max-w-52 gap-1.5 bg-background px-2 py-0 text-xs" />
          )}
        </span>
      </Tooltip>
      {chosen && kind === "PRODUCT" ? (
        <Tooltip content={`Let the preview pick a ${names.one} again`}>
          <button type="button" aria-label="Pick automatically" onClick={() => choose(null)} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
};
