import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronRight, FolderInput, FolderPlus, FolderTree, GripVertical, LayoutGrid, Package, Plus, Save, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form";
import { LocalizedInput } from "@/components/inputs";
import { LocalizedRichText } from "@/components/rich-text";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useDebounced, useReference } from "@/lib/hooks";
import { useNavTitle } from "@/lib/nav-history";
import { cn, slugify } from "@/lib/utils";
import type { ListSearch } from "@/router";
import { PageDesignCard } from "./page-design";
import { CATALOG_KEYS, flattenCategories, gid, type FlatCategory } from "./shared";

/** Every category, depth first in position order: the order the tree renders. */
const CategoryListQuery = graphql(`
  query CategoryList {
    categories {
      id
      name
      path
      isActive
      parent {
        id
      }
      translations {
        locale
        name
        slug
        description
      }
      products(first: 1) {
        totalCount
      }
    }
  }
`);

/** Matches a name in any locale. */
const CategorySearchQuery = graphql(`
  query CategorySearch($query: String!) {
    categories(query: $query) {
      id
    }
  }
`);

type Category = FlatCategory<NonNullable<ResultOf<typeof CategoryListQuery>["categories"]>[number]>;

const CategoryCreate = graphql(
  `
    mutation CategoryCreate($input: CategoryInput!) {
      categoryCreate(input: $input) {
        __typename
        ... on CategoryPayload {
          category {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const CategoryUpdate = graphql(
  `
    mutation CategoryUpdate($id: ID!, $input: CategoryUpdateInput!) {
      categoryUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const CategoryMove = graphql(
  `
    mutation CategoryMove($id: ID!, $parentId: ID, $position: Int) {
      categoryMove(id: $id, parentId: $parentId, position: $position) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const CategoryDelete = graphql(
  `
    mutation CategoryDelete($id: ID!) {
      categoryDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type Zone = "before" | "inside" | "after";

/** The selected category in the URL (`?node=`): its UUID, without the gid:// prefix. */
const nodeParam = (id: string) => id.slice(id.lastIndexOf("/") + 1);

export const CategoriesPage = () => {
  const { can } = useAuth();
  const write = can("catalog:write");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reference = useReference();
  const { node } = useSearch({ strict: false }) as ListSearch;
  const query = useQuery({ queryKey: [...CATALOG_KEYS.categories, "list"], queryFn: () => request(CategoryListQuery) });
  const flat = useMemo(() => flattenCategories(query.data?.categories ?? []), [query.data]);
  const byId = useMemo(() => new Map(flat.map((c) => [c.id, c])), [flat]);
  const byParent = useMemo(() => {
    const levels = new Map<string | null, Category[]>();
    for (const c of flat) {
      const level = levels.get(c.parentId);
      if (level) level.push(c);
      else levels.set(c.parentId, [c]);
    }
    return levels;
  }, [flat]);
  const childrenOf = (parentId: string | null) => byParent.get(parentId) ?? [];
  // The selection lives in the URL, so a reload, a link or Back keeps it.
  const selectedId = node ? gid("Category", node) : null;
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [moving, setMoving] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; zone: Zone } | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const term = useDebounced(search.trim());
  const found = useQuery({
    queryKey: [...CATALOG_KEYS.categories, "search", term],
    queryFn: ({ signal }) => request(CategorySearchQuery, { query: term }, { signal }),
    enabled: !!term,
    placeholderData: (previous) => previous,
  });
  const matches = search.trim() && term ? (found.data?.categories ?? []).flatMap((c) => byId.get(c.id) ?? []) : null;
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  // Names the screen for back links elsewhere: the page editor's arrow reads "Back to Shirts".
  useNavTitle(selected ? selected.name || "(untitled)" : "Categories");

  /** Unsaved edits are confirmed first (by the blocker below) unless `force`. */
  const select = (id: string | null, options: { force?: boolean } = {}) => {
    if (id === selectedId) return;
    void navigate({ to: ".", search: (prev: ListSearch) => ({ ...prev, node: id ? nodeParam(id) : undefined }), replace: true, ignoreBlocker: options.force });
  };

  // Switching category changes `?node=`, so one guard covers switching, leaving and closing the tab.
  const editing = useRef({ dirty: false, name: "" });
  const onDirtyChange = useCallback((dirty: boolean, name: string) => {
    editing.current = { dirty, name };
  }, []);
  useBlocker({
    shouldBlockFn: () => editing.current.dirty && !window.confirm(`Leave ${editing.current.name || "this category"} without saving? Your changes will be lost.`),
    enableBeforeUnload: () => editing.current.dirty,
  });

  const ancestorsOf = (category: Category) => {
    const ids: string[] = [];
    for (let id = category.parentId; id; id = byId.get(id)?.parentId ?? null) ids.push(id);
    return ids;
  };

  // Start with the top level open, and the branch of a category selected by the URL.
  useEffect(() => {
    if (expanded !== null || !flat.length) return;
    const chosen = selectedId ? byId.get(selectedId) : undefined;
    setExpanded(new Set([...flat.filter((c) => !c.parentId).map((c) => c.id), ...(chosen ? ancestorsOf(chosen) : [])]));
  }, [flat, expanded]); // Once, on first load: the selection and lookups come from the same render.

  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.categories }), queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.products })]);
  const expand = (ids: readonly string[]) => setExpanded((current) => new Set([...(current ?? []), ...ids]));

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ---------------------------------------------------------------- keyboard: a tree with one tab stop

  /** Every category on screen, top to bottom: arrow keys move through these. */
  const visible = useMemo(() => {
    const list: Category[] = [];
    const walk = (parentId: string | null) => {
      for (const c of byParent.get(parentId) ?? []) {
        list.push(c);
        if (expanded?.has(c.id)) walk(c.id);
      }
    };
    walk(null);
    return list;
  }, [byParent, expanded]);
  const [focusId, setFocusId] = useState<string | null>(null);
  // The item Tab reaches: the last one focused, else the selection, else the first.
  const tabStop = [focusId, selectedId, visible[0]?.id].find((id) => id && visible.some((c) => c.id === id)) ?? null;
  const items = useRef(new Map<string, HTMLLIElement>());
  const focusItem = (id: string | null | undefined) => {
    if (!id) return;
    setFocusId(id);
    items.current.get(id)?.focus();
  };

  // A category selected by the URL scrolls into view once the tree first shows.
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !expanded) return;
    revealed.current = true;
    if (selectedId) items.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [expanded, selectedId]);

  const onItemKeyDown = (event: KeyboardEvent<HTMLLIElement>, category: Category) => {
    // Keys on the add button inside the item belong to the button.
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const at = visible.findIndex((c) => c.id === category.id);
    const kids = childrenOf(category.id);
    const open = expanded?.has(category.id) ?? false;
    switch (event.key) {
      case "ArrowDown":
        focusItem(visible[at + 1]?.id);
        break;
      case "ArrowUp":
        focusItem(visible[at - 1]?.id);
        break;
      case "ArrowRight":
        if (kids.length && !open) toggle(category.id);
        else focusItem(kids[0]?.id);
        break;
      case "ArrowLeft":
        if (kids.length && open) toggle(category.id);
        else focusItem(category.parentId);
        break;
      case "Home":
        focusItem(visible[0]?.id);
        break;
      case "End":
        focusItem(visible.at(-1)?.id);
        break;
      case "Enter":
      case " ":
        select(category.id);
        break;
      default: {
        if (event.key.length !== 1 || !/\S/.test(event.key)) return;
        const letter = event.key.toLowerCase();
        focusItem([...visible.slice(at + 1), ...visible.slice(0, at + 1)].find((c) => (c.name ?? "").toLowerCase().startsWith(letter))?.id);
      }
    }
    event.preventDefault();
  };

  const reveal = (category: Category) => {
    expand(ancestorsOf(category));
    setSearch("");
    setFocusId(category.id);
    select(category.id);
  };

  // ---------------------------------------------------------------- moving

  /** `position` is 0-based. The API renumbers the level, so one update or move is enough. */
  const reposition = async (id: string, parentChanged: boolean, parentId: string | null, position: number) => {
    if (parentChanged) unwrap((await request(CategoryMove, { id, parentId, position })).categoryMove);
    else unwrap((await request(CategoryUpdate, { id, input: { position } })).categoryUpdate);
  };

  /** Moves change the storefront's navigation and URLs at once, so each toast offers Undo. */
  const place = async (moved: Category, parentId: string | null, index: number) => {
    const from = { parentId: moved.parentId, index: childrenOf(moved.parentId).findIndex((c) => c.id === moved.id) };
    const parentChanged = moved.parentId !== parentId;
    if (!parentChanged && from.index === index) return;
    const name = moved.name || "(untitled)";
    setBusy(true);
    try {
      await reposition(moved.id, parentChanged, parentId, index);
      if (parentId) expand([parentId]);
      toast.success(`Moved ${name}`, { action: { label: "Undo", onClick: () => void moveBack(moved.id, name, parentChanged, from) } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The move failed");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const moveBack = async (id: string, name: string, parentChanged: boolean, from: { parentId: string | null; index: number }) => {
    setBusy(true);
    try {
      await reposition(id, parentChanged, from.parentId, Math.max(from.index, 0));
      if (from.parentId) expand([from.parentId]);
      toast.success(`Moved ${name} back`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't undo the move");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const drop = (target: Category, zone: Zone) => {
    const moved = dragId ? byId.get(dragId) : null;
    setDragId(null);
    setOver(null);
    if (!moved || moved.id === target.id || moved.descendantIds.includes(target.id)) return;
    if (zone === "inside") return void place(moved, target.id, childrenOf(target.id).filter((c) => c.id !== moved.id).length);
    const siblings = childrenOf(target.parentId).filter((c) => c.id !== moved.id);
    const index = siblings.findIndex((c) => c.id === target.id);
    void place(moved, target.parentId, zone === "before" ? index : index + 1);
  };

  const zoneOf = (event: DragEvent<HTMLElement>): Zone => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
  };

  const renderNode = (node: Category, level: Category[], position: number): ReactNode => {
    const kids = childrenOf(node.id);
    const open = expanded?.has(node.id) ?? false;
    const isSelected = selectedId === node.id;
    const target = over?.id === node.id ? over.zone : null;
    const invalidTarget = !!dragId && (dragId === node.id || (byId.get(dragId)?.descendantIds.includes(node.id) ?? false));
    const count = node.products?.totalCount ?? 0;
    return (
      <li
        key={node.id}
        ref={(element) => {
          if (element) items.current.set(node.id, element);
          else items.current.delete(node.id);
        }}
        role="treeitem"
        aria-level={node.trail.length + 1}
        aria-setsize={level.length}
        aria-posinset={position + 1}
        aria-expanded={kids.length ? open : undefined}
        aria-selected={isSelected}
        aria-label={`${node.name || "(untitled)"}${node.isActive ? "" : ", inactive"}, ${count} product${count === 1 ? "" : "s"}`}
        tabIndex={tabStop === node.id ? 0 : -1}
        onKeyDown={(e) => onItemKeyDown(e, node)}
        onFocus={(e) => e.target === e.currentTarget && setFocusId(node.id)}
        className="rounded-md outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-ring/60"
      >
        <div
          draggable={write && !busy}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", node.id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(node.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            setOver(null);
          }}
          onDragOver={(e) => {
            if (!dragId || invalidTarget) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const zone = zoneOf(e);
            if (over?.id !== node.id || over.zone !== zone) setOver({ id: node.id, zone });
          }}
          onDragLeave={() => over?.id === node.id && setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            drop(node, zoneOf(e));
          }}
          onClick={() => {
            setFocusId(node.id);
            select(node.id);
          }}
          className={cn(
            "group relative flex cursor-pointer items-center gap-1 rounded-md py-1.5 pr-2 text-[13px] transition-colors hover:bg-accent/60",
            isSelected && "bg-accent text-accent-foreground",
            target === "inside" && "ring-2 ring-primary/60 ring-inset",
            dragId === node.id && "opacity-40",
          )}
          style={{ paddingLeft: `${node.trail.length * 18 + 4}px` }}
        >
          {target === "before" ? <span className="pointer-events-none absolute inset-x-2 top-0 h-0.5 rounded bg-primary" /> : null}
          {target === "after" ? <span className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 rounded bg-primary" /> : null}
          {write ? <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/50 group-hover:text-muted-foreground" /> : null}
          {/* Right and Left open and close by keyboard, so this stays out of the tab order. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? "Collapse" : "Expand"}
            className={cn("flex size-5 shrink-0 items-center justify-center rounded hover:bg-background/60", !kids.length && "invisible")}
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
          <span className={cn("flex-1 truncate font-medium", !node.isActive && "text-muted-foreground")}>{node.name || "(untitled)"}</span>
          {!node.isActive ? <Badge variant="outline">inactive</Badge> : null}
          <span className="text-xs text-muted-foreground tabular">{count}</span>
          {write ? (
            // Tab reaches it from the focused category; hidden until hover or focus, but still there.
            <button
              type="button"
              tabIndex={tabStop === node.id ? 0 : -1}
              aria-label={`Add a subcategory to ${node.name || "(untitled)"}`}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-background/60 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60",
                isSelected && "opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                setCreating({ parentId: node.id });
              }}
            >
              <Plus className="size-3.5" />
            </button>
          ) : null}
        </div>
        {open && kids.length ? <ul role="group">{kids.map((kid, i) => renderNode(kid, kids, i))}</ul> : null}
      </li>
    );
  };

  const siblings = selected ? childrenOf(selected.parentId) : [];
  const index = selected ? siblings.findIndex((c) => c.id === selected.id) : -1;
  const roots = childrenOf(null);

  return (
    <Page wide>
      <PageHeader
        title="Categories"
        description="The storefront's navigation tree. Drag a category onto another to nest it, or between two to reorder. Products in a category also count for its parents in storefront filters."
        actions={
          write ? (
            <Button onClick={() => setCreating({ parentId: null })}>
              <FolderPlus />
              New category
            </Button>
          ) : null
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <div>
              <CardTitle>Tree</CardTitle>
              <CardDescription>{flat.length} categories · numbers are directly assigned products</CardDescription>
            </div>
            {busy ? <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : null}
          </CardHeader>
          <CardContent className="px-2 pb-3">
            {flat.length ? (
              <div className="relative mx-2 mb-2">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find by name in any language" aria-label="Find a category" className="h-8 pl-8" />
              </div>
            ) : null}
            {query.isLoading ? (
              <div className="space-y-2 px-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : flat.length === 0 ? (
              <EmptyState icon={FolderTree} title="No categories yet" description="Create the top level of your navigation, then nest categories under it." className="py-10" />
            ) : matches ? (
              matches.length ? (
                <ul className="pb-2">
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => reveal(c)} className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-accent/60">
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate font-medium", !c.isActive && "text-muted-foreground")}>{c.name || "(untitled)"}</span>
                          {c.trail.length ? <span className="block truncate text-xs text-muted-foreground">{c.trail.join(" › ")}</span> : null}
                        </span>
                        {!c.isActive ? <Badge variant="outline">inactive</Badge> : null}
                        <span className="text-xs text-muted-foreground tabular">{c.products?.totalCount ?? 0}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{found.isFetching ? "Searching…" : `No category is named like “${term}”.`}</p>
              )
            ) : (
              <ul
                role="tree"
                aria-label="Categories"
                aria-busy={busy}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={(e) => {
                  // Dropped on empty space below the tree: make it the last top-level category.
                  if (e.target !== e.currentTarget) return;
                  e.preventDefault();
                  const moved = dragId ? byId.get(dragId) : null;
                  setDragId(null);
                  setOver(null);
                  if (moved) void place(moved, null, roots.filter((c) => c.id !== moved.id).length);
                }}
                className="min-h-24 pb-6"
              >
                {roots.map((root, i) => renderNode(root, roots, i))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selected ? (
          // Sticky beside a long tree; scrolls on its own when the window is too short for both cards.
          <div key={selected.id} className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto">
            <CategoryEditor
              category={selected}
              locales={reference.locales}
              write={write}
              busy={busy}
              onAddChild={() => setCreating({ parentId: selected.id })}
              onMoveUp={index > 0 ? () => void place(selected, selected.parentId, index - 1) : undefined}
              onMoveDown={index >= 0 && index < siblings.length - 1 ? () => void place(selected, selected.parentId, index + 1) : undefined}
              onMove={() => setMoving(selected)}
              onDelete={() => setDeleting(selected)}
              onSaved={refresh}
              onDirtyChange={onDirtyChange}
            />
            <PageDesignCard kind="CATEGORY" id={selected.id} name={selected.name ?? ""} />
          </div>
        ) : node && query.isLoading ? (
          <Card>
            <CardContent className="grid gap-4 pt-6">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <EmptyState icon={FolderTree} title="Select a category" description="Choose a category in the tree to edit its names, URL and visibility." />
          </Card>
        )}
      </div>

      <CreateDialog
        open={!!creating}
        parentId={creating?.parentId ?? null}
        flat={flat}
        defaultLocale={reference.defaultLocale}
        onClose={() => setCreating(null)}
        onCreated={async (id, parentId) => {
          setCreating(null);
          if (parentId) expand([parentId]);
          await refresh();
          setFocusId(id);
          select(id);
        }}
      />
      {moving ? (
        <MoveDialog
          category={moving}
          flat={flat}
          childrenOf={childrenOf}
          onClose={() => setMoving(null)}
          onMove={(parentId, position) => {
            setMoving(null);
            void place(moving, parentId, position);
          }}
        />
      ) : null}
      <DeleteCategory
        category={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={async () => {
          setDeleting(null);
          // Its unsaved edits went with it.
          select(null, { force: true });
          await refresh();
        }}
      />
    </Page>
  );
};

const CategoryEditor = ({
  category,
  locales,
  write,
  busy,
  onAddChild,
  onMoveUp,
  onMoveDown,
  onMove,
  onDelete,
  onSaved,
  onDirtyChange,
}: {
  category: Category;
  locales: readonly string[];
  write: boolean;
  busy: boolean;
  onAddChild: () => void;
  /** Undefined when the category is already first. */
  onMoveUp?: () => void;
  /** Undefined when the category is already last. */
  onMoveDown?: () => void;
  onMove: () => void;
  onDelete: () => void;
  onSaved: () => Promise<unknown>;
  /** Feeds the screen's leave and switch guard. */
  onDirtyChange: (dirty: boolean, name: string) => void;
}) => {
  const initial = useMemo(() => {
    const translations = category.translations ?? [];
    const pick = (field: "name" | "slug" | "description") => Object.fromEntries(translations.map((t) => [t.locale ?? "", t[field] ?? ""]));
    return { name: pick("name"), slug: pick("slug"), description: pick("description"), isActive: !!category.isActive };
  }, [category]);
  const allLocales = useMemo(() => [...new Set([...locales, ...(category.translations ?? []).map((t) => t.locale ?? "")].filter(Boolean))], [locales, category.translations]);
  const [values, setValues] = useState(initial);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  useEffect(() => onDirtyChange(dirty, category.name || "(untitled)"), [dirty, category.name, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false, ""), [onDirtyChange]);

  // Fresh data replaces the form unless it holds edits made since. The server tidies what was saved
  // (an empty slug, spaces around a name), so the form would otherwise stay "unsaved".
  const shown = useRef(initial);
  const saved = useRef<typeof values | null>(null);
  useEffect(() => {
    if (shown.current === initial) return;
    const same = (other: typeof values | null) => !!other && JSON.stringify(values) === JSON.stringify(other);
    if (same(shown.current) || same(saved.current)) setValues(initial);
    shown.current = initial;
    saved.current = null;
  }, [initial]); // Only when the data changes: `values` is the form as it is at that moment.

  const save = useAction(
    async (sent: typeof values) => {
      const translations = allLocales
        .filter((locale) => sent.name[locale]?.trim())
        .map((locale) => ({
          locale,
          name: sent.name[locale]!.trim(),
          slug: sent.slug[locale]?.trim() ? slugify(sent.slug[locale]!) : null,
          description: sent.description[locale]?.trim() ? sent.description[locale]! : null,
        }));
      if (!translations.length) throw new Error("Give the category a name");
      return unwrap((await request(CategoryUpdate, { id: category.id, input: { isActive: sent.isActive, translations } })).categoryUpdate);
    },
    {
      success: "Category saved",
      onSuccess: (_result, sent) => {
        saved.current = sent;
        void onSaved();
      },
    },
  );

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="truncate">{category.name || "(untitled)"}</CardTitle>
          <CardDescription className="truncate">{category.trail.length ? category.trail.join(" › ") : "Top level"} · /{category.path}</CardDescription>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Link to="/products" search={{ category: category.id }} className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
            <Package className="size-3.5" />
            {category.products?.totalCount ?? 0} products
          </Link>
          <Link to="/categories/$id/merchandising" params={{ id: nodeParam(category.id) }} className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
            <LayoutGrid className="size-3.5" />
            Merchandise
          </Link>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field label="Name" required>
          <LocalizedInput value={values.name} onChange={(name) => setValues({ ...values, name })} locales={allLocales} />
        </Field>
        <Field label="URL slug" hint="Lowercase words separated by hyphens; empty to generate from the name.">
          <LocalizedInput value={values.slug} onChange={(slug) => setValues({ ...values, slug })} locales={allLocales} />
        </Field>
        <Field label="Description" hint="Shown at the top of the category page.">
          <LocalizedRichText value={values.description} onChange={(description) => setValues({ ...values, description })} locales={allLocales} format="html" rows={4} placeholder="A sentence or two about this category" />
        </Field>
        <Label className="justify-between rounded-lg border p-3 font-normal">
          <span>
            <span className="block font-medium">Active</span>
            <span className="text-xs text-muted-foreground">Inactive categories and everything below them are hidden on the storefront.</span>
          </span>
          <Switch checked={values.isActive} disabled={!write} onCheckedChange={(isActive) => setValues({ ...values, isActive })} />
        </Label>
        {write ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="icon-sm" disabled={!onMoveUp || busy} onClick={onMoveUp} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button variant="outline" size="icon-sm" disabled={!onMoveDown || busy} onClick={onMoveDown} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button variant="outline" size="sm" onClick={onAddChild}>
                <FolderPlus />
                Add subcategory
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={onMove}>
                <FolderInput />
                Move…
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
                <Trash2 />
                Delete
              </Button>
            </div>
            <div className="flex gap-2">
              {dirty ? (
                <Button variant="ghost" size="sm" onClick={() => setValues(initial)}>
                  Discard
                </Button>
              ) : null}
              <Button size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(values)}>
                <Save />
                Save
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

const CreateDialog = ({
  open,
  parentId,
  flat,
  defaultLocale,
  onClose,
  onCreated,
}: {
  open: boolean;
  parentId: string | null;
  flat: Category[];
  defaultLocale: string;
  onClose: () => void;
  onCreated: (id: string, parentId: string | null) => void;
}) => {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [parent, setParent] = useState(parentId ?? "");
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (open) {
      setName("");
      setSlug("");
      setParent(parentId ?? "");
      setActive(true);
    }
  }, [open, parentId]);
  // Without a position the API adds it last among its siblings.
  const create = useAction(
    async () =>
      unwrap((await request(CategoryCreate, { input: { parentId: parent || null, isActive: active, translations: [{ locale: defaultLocale, name: name.trim(), slug: slug.trim() ? slugify(slug) : null }] } })).categoryCreate),
    { success: "Category created", onSuccess: (r) => r.category?.id && onCreated(r.category.id, parent || null) },
  );
  // Escape or a click outside asks before dropping what was typed.
  const dirty = !!name.trim() || !!slug.trim() || parent !== (parentId ?? "") || !active;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dirty={dirty}>
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>It is added after its siblings. Add names in other languages after creating it.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate(undefined);
          }}
        >
          <Field label={`Name (${defaultLocale})`} required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL slug" hint={`Defaults to ${slugify(name) || "the name"}`}>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(name)} />
          </Field>
          <Field label="Parent">
            <Combobox options={[{ value: "", label: "Top level" }, ...flat.map((c) => ({ value: c.id, label: c.label }))]} value={parent} onChange={setParent} placeholder="Top level" />
          </Field>
          <Label className="justify-between font-normal">
            Active
            <Switch checked={active} onCheckedChange={setActive} />
          </Label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const MoveDialog = ({
  category,
  flat,
  childrenOf,
  onClose,
  onMove,
}: {
  category: Category;
  flat: Category[];
  childrenOf: (parentId: string | null) => Category[];
  onClose: () => void;
  onMove: (parentId: string | null, position: number) => void;
}) => {
  const currentIndex = childrenOf(category.parentId).findIndex((c) => c.id === category.id);
  const [parent, setParent] = useState(category.parentId ?? "");
  // An index among the new siblings; null means last.
  const [position, setPosition] = useState<number | null>(currentIndex);
  const siblings = childrenOf(parent || null).filter((c) => c.id !== category.id);
  const index = position === null ? siblings.length : Math.min(position, siblings.length);
  const options = [{ value: "", label: "Top level" }, ...flat.filter((c) => c.id !== category.id && !category.descendantIds.includes(c.id)).map((c) => ({ value: c.id, label: c.label }))];
  const dirty = parent !== (category.parentId ?? "") || index !== currentIndex;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dirty={dirty}>
        <DialogHeader>
          <DialogTitle>Move {category.name}</DialogTitle>
          <DialogDescription>
            {category.descendantIds.length ? `Its ${category.descendantIds.length} subcategor${category.descendantIds.length === 1 ? "y moves" : "ies move"} with it. ` : ""}URLs follow the new path.
          </DialogDescription>
        </DialogHeader>
        <Field label="Parent">
          <Combobox
            options={options}
            value={parent}
            onChange={(value) => {
              setParent(value);
              setPosition((value || null) === category.parentId ? currentIndex : null);
            }}
            placeholder="Top level"
          />
        </Field>
        <Field label="Position">
          <NativeSelect value={index} onChange={(e) => setPosition(Number(e.target.value))}>
            <option value={0}>First</option>
            {siblings.map((s, i) => (
              <option key={s.id} value={i + 1}>
                After {s.name || "(untitled)"}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onMove(parent || null, index)}>
            <FolderInput />
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const DeleteCategory = ({ category, onClose, onDeleted }: { category: Category | null; onClose: () => void; onDeleted: () => void }) => {
  const remove = useAction(async (id: string) => unwrap((await request(CategoryDelete, { id })).categoryDelete), { success: "Category deleted", onSuccess: onDeleted });
  const sub = category?.descendantIds.length ?? 0;
  return (
    <ConfirmDialog
      open={!!category}
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${category?.name ?? "category"}?`}
      description={`${sub ? `Its ${sub} subcategor${sub === 1 ? "y is" : "ies are"} deleted too. ` : ""}Products stay in the catalog without these category assignments. This cannot be undone.`}
      destructive
      confirmLabel="Delete"
      loading={remove.isPending}
      onConfirm={() => category && remove.mutate(category.id)}
    />
  );
};
