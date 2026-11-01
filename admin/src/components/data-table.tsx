import { useIsFetching, useQueryClient, type Query } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, BookmarkPlus, ChevronLeft, ChevronRight, ChevronsLeft, CloudOff, Columns3, Download, Keyboard, Loader2, RotateCw, Search, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Alert, EmptyState, Kbd, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlay";
import { stickyHeadClass, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebounced, useListSearch, usePreference } from "@/lib/hooks";
import { cn, downloadText, toCsv } from "@/lib/utils";
import type { ListSearch } from "@/router";

export type Column<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Plain value for CSV export; columns without one are left out. */
  csv?: (row: T) => unknown;
  align?: "right";
  className?: string;
  /** Hidden until the user turns it on. */
  hidden?: boolean;
  /** Always shown; not listed in the column picker. */
  fixed?: boolean;
};

export type SavedView = { name: string; search: ListSearch };

export type SortOption = {
  /** The `sort` URL param; the first option is the default and leaves it out. */
  value: string;
  label: string;
  /** The column whose header picks this option, and which way it sorts that column. */
  column?: string;
  direction?: "asc" | "desc";
};

/** The option in the `sort` URL param, else the first. */
export const useListSort = <Options extends readonly [SortOption, ...SortOption[]]>(options: Options): Options[number] => {
  const [search] = useListSearch();
  const value = (search as Record<string, string | undefined>).sort;
  return options.find((o) => o.value === value) ?? options[0];
};

/** A query loading a new result set behind `placeholderData`; background refreshes don't count. */
const replacingRows = (query: Query) => query.state.status === "pending" && query.observers.some((observer) => observer.getCurrentResult().isPlaceholderData);

/** A load error as a sentence; a blocked or failed request reads as a connection problem. */
const describeError = (error: unknown) => {
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "The server could not be reached. Check your connection.";
  const message = error instanceof Error ? error.message.trim() : "";
  return !message ? "Something went wrong." : /[.!?]$/.test(message) ? message : `${message}.`;
};

// ---------------------------------------------------------------- keyboard

const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const WIDGETS = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=combobox], [role=tablist], [role=radiogroup], [role=tree], [role=slider], [role=spinbutton]";
const OPEN_LAYERS = "[role=dialog][data-state=open], [role=alertdialog][data-state=open], [role=menu][data-state=open]";

/** Keys typed into a field, or meant for a dialog, menu or other widget, are not list shortcuts. */
const notForList = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing || event.altKey) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target && (target.closest(TYPING) || target.closest(WIDGETS) || (target instanceof HTMLElement && target.isContentEditable))) return true;
  return document.querySelector(OPEN_LAYERS) !== null;
};

/** Lists on screen, newest last. Only the newest answers shortcuts. */
const keyboardLists: object[] = [];

/** The link in a row's first column: what the row opens, for "open in a new tab". */
const rowLink = (row: Element | null | undefined) => row?.querySelector<HTMLAnchorElement>("[data-primary] a[href]") ?? null;

const openInNewTab = (href: string) => window.open(href, "_blank", "noopener");

// ---------------------------------------------------------------- styles

/**
 * Row tints (matching TableRow's) live in a variable so sticky cells can paint them over an opaque
 * background. No fade: sticky cells can't fade a background image.
 */
const ROW =
  "group/row scroll-mt-14 scroll-mb-16 outline-none transition-none [--row-bg:transparent] hover:[--row-bg:color-mix(in_oklab,var(--color-muted)_40%,transparent)] data-[state=selected]:[--row-bg:color-mix(in_oklab,var(--color-accent)_60%,transparent)] data-[active]:not-data-[state=selected]:[--row-bg:color-mix(in_oklab,var(--color-muted)_70%,transparent)] data-[active]:bg-(--row-bg)";
const STICKY_CELL = "relative bg-card [background-image:linear-gradient(var(--row-bg),var(--row-bg))] md:sticky md:z-[1]";
/** The highlighted row's marker, on its first cell. */
const ACTIVE_MARK = "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary before:opacity-0 group-data-[active]/row:before:opacity-100";
/** A shadow along the sticky first column once the rows scroll sideways under it. */
const EDGE_SHADOW =
  "after:pointer-events-none after:absolute after:inset-y-0 after:left-full after:w-2 after:bg-linear-to-r after:from-black/10 after:to-transparent after:opacity-0 md:group-data-[scrolled]/scroll:after:opacity-100 dark:after:from-black/40";

/** A loading bar over the rows, shown only once loading takes more than a moment. */
const LoadingBar = ({ active }: { active: boolean }) => {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    if (!active || !element || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(400%)" }], { duration: 1100, easing: "ease-in-out", iterations: Infinity });
    return () => animation.cancel();
  }, [active]);
  return (
    // Above the sticky header cells (z-20), below the app's sticky top bar (z-30).
    <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-[21] h-0.5 overflow-hidden", active ? "opacity-100 transition-opacity delay-150 duration-150" : "opacity-0")}>
      <div ref={bar} className="h-full w-1/4 bg-primary motion-reduce:w-full motion-reduce:animate-pulse" />
    </div>
  );
};

const Shortcut = ({ keys, children }: { keys: string[][]; children: ReactNode }) => (
  <>
    <dt className="flex flex-wrap items-center gap-1 text-muted-foreground">
      {keys.map((combo, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 ? <span className="mr-1 text-xs">or</span> : null}
          {combo.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      ))}
    </dt>
    <dd>{children}</dd>
  </>
);

/** The keyboard icon in the toolbar, listing the list's shortcuts ("?" opens it too). */
const ShortcutsHelp = ({ open, onOpenChange, searchable, selectable }: { open: boolean; onOpenChange: (open: boolean) => void; searchable: boolean; selectable: boolean }) => (
  <Popover open={open} onOpenChange={onOpenChange}>
    <Tooltip content="Keyboard shortcuts">
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts" aria-keyshortcuts="?">
          <Keyboard />
        </Button>
      </PopoverTrigger>
    </Tooltip>
    <PopoverContent align="end" className="w-80">
      <p className="mb-2.5 text-[13px] font-medium">Keyboard shortcuts</p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
        {searchable ? <Shortcut keys={[["/"]]}>Search</Shortcut> : null}
        <Shortcut keys={[["j"], ["↓"]]}>Next row</Shortcut>
        <Shortcut keys={[["k"], ["↑"]]}>Previous row</Shortcut>
        <Shortcut keys={[["Enter"]]}>Open the row</Shortcut>
        <Shortcut keys={[[MOD_KEY, "Enter"]]}>Open it in a new tab (or middle-click)</Shortcut>
        {selectable ? (
          <>
            <Shortcut keys={[["x"]]}>Select or deselect the row</Shortcut>
            <Shortcut keys={[["Shift", "x"]]}>Select a range (or Shift-click)</Shortcut>
            <Shortcut keys={[["Esc"]]}>Clear the selection</Shortcut>
          </>
        ) : null}
        <Shortcut keys={[["?"]]}>Show these shortcuts</Shortcut>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">In the Views menu, Delete removes the highlighted view.</p>
    </PopoverContent>
  </Popover>
);

/**
 * The admin grid: server-side filtering, sorting and cursor paging, per-user columns and saved
 * views, bulk actions, CSV export and keyboard navigation. While a new result set loads (queries
 * with `placeholderData`), the old rows dim and paging and bulk actions wait.
 */
export const DataTable = <T,>({
  id,
  rows,
  columns,
  rowKey,
  loading,
  fetching,
  error,
  onRetry,
  onRowClick,
  selectable,
  bulkActions,
  filters,
  sortOptions,
  searchPlaceholder,
  total,
  pageInfo,
  onNext,
  onPrev,
  page,
  exportName,
  fetchAll,
  empty,
  toolbarExtra,
  searchable = true,
}: {
  id: string;
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** A new result set is loading behind the rows shown. Detected by default. */
  fetching?: boolean;
  error?: unknown;
  /** What "Try again" runs; by default every query on screen is refetched. */
  onRetry?: () => unknown;
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  /** `keep` narrows the selection to some rows, e.g. the ones a bulk action could not change. */
  bulkActions?: (selected: T[], clear: () => void, keep: (keys: string[]) => void) => ReactNode;
  filters?: ReactNode;
  /** Sort orders, kept in the `sort` URL param (see useListSort). */
  sortOptions?: readonly [SortOption, ...SortOption[]];
  searchPlaceholder?: string;
  total?: number | null;
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null } | null;
  onNext?: (cursor: string) => void;
  onPrev?: () => void;
  /** Leave out when unknown, e.g. for a shared link to a later page. */
  page?: number;
  exportName?: string;
  /** Every matching row, for "Export all". */
  fetchAll?: () => Promise<T[]>;
  empty?: ReactNode;
  toolbarExtra?: ReactNode;
  searchable?: boolean;
}) => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useListSearch();
  const [hidden, setHidden] = usePreference<string[] | null>(`grid:${id}:hidden`, null);
  const [views, setViews] = usePreference<SavedView[]>(`grid:${id}:views`, []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The highlighted row (keyboard cursor), by key so it follows the row when the list refreshes.
  const [active, setActive] = useState<string | null>(null);
  // Where the last selection toggle happened, for Shift-click and Shift+x ranges.
  const anchor = useRef<string | null>(null);
  const [query, setQuery] = useState(search.q ?? "");
  // Search as you type, kept in the URL. `pushed` tells our own updates from a saved view or Reset
  // changing it.
  const debouncedQuery = useDebounced(query.trim(), 300);
  const pushed = useRef(search.q ?? "");
  useEffect(() => {
    if (debouncedQuery === pushed.current) return;
    pushed.current = debouncedQuery;
    setSearch({ q: debouncedQuery || undefined });
  }, [debouncedQuery, setSearch]);
  useEffect(() => {
    if ((search.q ?? "") === pushed.current) return;
    pushed.current = search.q ?? "";
    setQuery(search.q ?? "");
  }, [search.q]);
  const [exporting, setExporting] = useState(false);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState("");
  // A view deleted with the Views menu open; it stays there as "Undo" until the menu closes.
  const [removed, setRemoved] = useState<{ view: SavedView; index: number } | null>(null);
  const latestViews = useRef(views);
  useEffect(() => {
    latestViews.current = views;
  }, [views]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const [keyboardToken] = useState(() => ({}));
  const uid = useId();
  const selectLabelId = `${uid}-select`;

  const replacing = useIsFetching({ predicate: replacingRows }) > 0;
  const busy = fetching ?? replacing;
  const showSkeleton = rows.length === 0 && (!!loading || busy);

  const hiddenIds = useMemo(() => new Set(hidden ?? columns.filter((c) => c.hidden).map((c) => c.id)), [hidden, columns]);
  const visible = columns.filter((c) => c.fixed || !hiddenIds.has(c.id));
  const keys = rows.map(rowKey);
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const activeIndex = active === null ? -1 : keys.indexOf(active);
  const clear = () => {
    setSelected(new Set());
    anchor.current = null;
  };
  const keep = (keys: string[]) => setSelected((current) => new Set(keys.filter((key) => current.has(key))));

  /** With `range`, every row from the last toggled one to this one takes its new state. */
  const toggle = (key: string, range: boolean) => {
    const from = range && anchor.current ? keys.indexOf(anchor.current) : -1;
    const to = keys.indexOf(key);
    const span = from >= 0 && to >= 0 ? keys.slice(Math.min(from, to), Math.max(from, to) + 1) : [key];
    setSelected((current) => {
      const next = new Set(current);
      const on = !current.has(key);
      for (const k of span) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
    anchor.current = key;
  };

  const openRow = (row: T, element: Element | null | undefined, newTab: boolean) => {
    const link = rowLink(element);
    if (newTab && link) openInNewTab(link.href);
    else if (onRowClick) onRowClick(row);
    else link?.click();
  };

  const focusRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    setActive(rowKey(row));
    const element = body.current?.rows[index];
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };

  // ------------------------------------------------------------ sorting

  const sortParam = (search as Record<string, string | undefined>).sort;
  const sort = sortOptions ? (sortOptions.find((o) => o.value === sortParam) ?? sortOptions[0]) : undefined;
  const setSort = (option: SortOption) => setSearch({ sort: option.value === sortOptions?.[0].value ? undefined : option.value } as Partial<ListSearch>);
  /** The header's current sort option, and the one a click picks (the other direction). */
  const headerSort = (columnId: string) => {
    const options = sortOptions?.filter((o) => o.column === columnId) ?? [];
    if (!options.length) return null;
    const current = sort?.column === columnId ? sort : undefined;
    return { current, next: current ? (options.find((o) => o !== current) ?? current) : options[0]! };
  };

  // ------------------------------------------------------------ paging

  // A second click on Next before the page arrives would reuse the old page's end cursor.
  const requested = useRef<string | null>(null);
  useEffect(() => {
    requested.current = null;
  }, [search.after]);
  const goNext = () => {
    const cursor = pageInfo?.endCursor;
    if (!cursor || busy || cursor === requested.current || cursor === search.after) return;
    requested.current = cursor;
    onNext?.(cursor);
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await (onRetry ? onRetry() : queryClient.refetchQueries({ type: "active" }));
    } finally {
      setRetrying(false);
    }
  };

  // ------------------------------------------------------------ keyboard

  const onListKey = useEffectEvent((event: KeyboardEvent) => {
    if (keyboardLists.at(-1) !== keyboardToken || notForList(event)) return;
    const { key } = event;
    const mod = event.metaKey || event.ctrlKey;
    const target = event.target instanceof Element ? event.target : null;
    const onRow = target instanceof HTMLTableRowElement && !!body.current?.contains(target);
    // Links and buttons answer Enter and the arrow keys themselves.
    const onControl = !onRow && !!target?.closest("a[href], button, [role=button], [role=checkbox], [role=switch], summary, label");

    if (key === "/" && !mod) {
      if (!searchInput.current) return;
      event.preventDefault();
      searchInput.current.focus();
      searchInput.current.select();
    } else if (key === "?" && !mod) {
      event.preventDefault();
      setHelpOpen((open) => !open);
    } else if (key === "Escape") {
      if (selected.size) clear();
      else if (active !== null) {
        setActive(null);
        if (onRow) (target as HTMLElement).blur();
      }
    } else if ((key === "j" || key === "k") && !mod && !event.shiftKey) {
      if (!rows.length) return;
      event.preventDefault();
      focusRow(activeIndex < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, activeIndex + (key === "j" ? 1 : -1))));
    } else if ((key === "ArrowDown" || key === "ArrowUp") && !mod && !event.shiftKey && (onRow || (!onControl && activeIndex >= 0))) {
      // Arrows scroll the page as usual until a row is highlighted.
      event.preventDefault();
      focusRow(activeIndex < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, activeIndex + (key === "ArrowDown" ? 1 : -1))));
    } else if (key === "Enter" && !event.repeat && !onControl && activeIndex >= 0 && !busy) {
      event.preventDefault();
      openRow(rows[activeIndex]!, body.current?.rows[activeIndex], mod);
    } else if ((key === "x" || key === "X") && !mod && !event.repeat && selectable && activeIndex >= 0 && !busy) {
      event.preventDefault();
      toggle(keys[activeIndex]!, event.shiftKey);
    }
  });

  useEffect(() => {
    keyboardLists.push(keyboardToken);
    const listener = (event: KeyboardEvent) => onListKey(event);
    document.addEventListener("keydown", listener);
    return () => {
      keyboardLists.splice(keyboardLists.indexOf(keyboardToken), 1);
      document.removeEventListener("keydown", listener);
    };
  }, [keyboardToken]);

  // ------------------------------------------------------------ columns, export, views

  const toggleColumn = (columnId: string) => {
    const next = new Set(hiddenIds);
    if (next.has(columnId)) next.delete(columnId);
    else next.add(columnId);
    setHidden([...next]);
  };

  const exportRows = async (all: boolean) => {
    const exportable = columns.filter((c) => c.csv);
    setExporting(true);
    try {
      const data = all && fetchAll ? await fetchAll() : rows;
      downloadText(`${exportName ?? id}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([exportable.map((c) => (typeof c.header === "string" ? c.header : c.id)), ...data.map((row) => exportable.map((c) => c.csv!(row)))]));
      toast.success(`Exported ${data.length} rows`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const filtersActive = Object.entries(search).some(([key, value]) => key !== "after" && key !== "tab" && value);
  const viewSearch = (): ListSearch => Object.fromEntries(Object.entries(search).filter(([key]) => key !== "after"));
  const commitQuery = () => {
    pushed.current = query.trim();
    setSearch({ q: query.trim() || undefined });
  };

  const restoreView = (view: SavedView, index: number) => {
    const current = latestViews.current;
    setRemoved((r) => (r?.view.name === view.name ? null : r));
    if (current.some((v) => v.name === view.name)) return;
    setViews([...current.slice(0, index), view, ...current.slice(index)]);
  };
  const deleteView = (view: SavedView) => {
    const index = views.findIndex((v) => v.name === view.name);
    if (index < 0) return;
    setViews(views.filter((v) => v.name !== view.name));
    setRemoved({ view, index });
    toast.success(`Deleted view “${view.name}”`, { action: { label: "Undo", onClick: () => restoreView(view, index) } });
  };
  const menuViews: { view: SavedView; undo?: number }[] = views.map((view) => ({ view }));
  if (removed) menuViews.splice(removed.index, 0, { view: removed.view, undo: removed.index });

  // ------------------------------------------------------------ render

  const firstHead = cn(selectable ? "md:left-12" : "md:left-0", "md:z-20", EDGE_SHADOW);
  const firstCell = cn(STICKY_CELL, selectable ? "md:left-12" : cn("md:left-0", ACTIVE_MARK), EDGE_SHADOW);

  return (
    <div className="overflow-clip rounded-xl border bg-card shadow-xs">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        {searchable ? (
          <form
            className="relative w-full max-w-xs"
            onSubmit={(event) => {
              event.preventDefault();
              commitQuery();
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInput}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // A search field clears itself on Escape; keep the text and hand the keys to the rows.
                event.preventDefault();
                if (query.trim() !== (search.q ?? "")) commitQuery();
                event.currentTarget.blur();
              }}
              placeholder={searchPlaceholder ?? "Search…"}
              aria-label={searchPlaceholder ?? "Search"}
              aria-keyshortcuts="/"
              className="h-8 pl-8"
            />
          </form>
        ) : null}
        {filters}
        {sortOptions && sort ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant={sort === sortOptions[0] ? "outline" : "secondary"} size="sm" className={cn(sort !== sortOptions[0] && "border border-primary/30")}>
                <ArrowUpDown />
                Sort<span className="font-normal text-muted-foreground">: {sort.label}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              {sortOptions.map((o) => (
                <DropdownMenuCheckboxItem key={o.value} checked={o.value === sort.value} onCheckedChange={() => setSort(o)}>
                  {o.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setSearch(Object.fromEntries(Object.keys(search).filter((k) => k !== "tab").map((k) => [k, undefined])));
            }}
          >
            <X />
            Reset
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {toolbarExtra}
          <DropdownMenu onOpenChange={(open) => !open && setRemoved(null)}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Bookmark />
                Views
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
              <DropdownMenuLabel>Saved views</DropdownMenuLabel>
              {menuViews.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Save filters you use often.</p> : null}
              {menuViews.map(({ view, undo }) =>
                undo !== undefined ? (
                  // Same key as the view's own item, so the highlight stays put for Enter to undo.
                  <DropdownMenuItem
                    key={view.name}
                    aria-label={`Undo deleting view ${view.name}`}
                    onSelect={(event) => {
                      event.preventDefault();
                      restoreView(view, undo);
                    }}
                  >
                    <Undo2 />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground line-through">{view.name}</span>
                    <span className="text-xs font-medium text-primary">Undo</span>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    key={view.name}
                    aria-keyshortcuts="Delete"
                    className="justify-between py-1 pr-1"
                    onSelect={() => setSearch({ ...Object.fromEntries(Object.keys(search).map((k) => [k, undefined])), ...view.search })}
                    onKeyDown={(event) => {
                      if (event.key !== "Delete" && event.key !== "Backspace") return;
                      event.preventDefault();
                      deleteView(view);
                    }}
                  >
                    <span className="min-w-0 truncate">{view.name}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      title="Delete view (Delete key)"
                      aria-label={`Delete view ${view.name}`}
                      className="flex size-6 shrink-0 items-center justify-center rounded opacity-60 hover:bg-background hover:opacity-100"
                      onClick={(event) => {
                        // Not a click on the item: that would apply the view and close the menu.
                        event.preventDefault();
                        event.stopPropagation();
                        deleteView(view);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </DropdownMenuItem>
                ),
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!filtersActive}
                onSelect={() => {
                  setViewName("");
                  setNaming(true);
                }}
              >
                <BookmarkPlus />
                Save current filters…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {columns
                .filter((c) => !c.fixed)
                .map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={!hiddenIds.has(c.id)} onCheckedChange={() => toggleColumn(c.id)} onSelect={(e) => e.preventDefault()}>
                    {c.header}
                  </DropdownMenuCheckboxItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setHidden(null)}>Restore defaults</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {columns.some((c) => c.csv) ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={exporting}>
                  {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => void exportRows(false)}>This page (CSV)</DropdownMenuItem>
                {fetchAll ? <DropdownMenuItem onSelect={() => void exportRows(true)}>Everything matching (CSV)</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} searchable={searchable} selectable={!!selectable} />
        </div>
      </div>

      {error && rows.length > 0 ? (
        <Alert
          variant="warning"
          className="items-center rounded-none border-x-0 border-t-0 py-2.5"
          title="Couldn't refresh this list"
          action={
            <Button size="sm" variant="outline" loading={retrying} onClick={() => void retry()}>
              {retrying ? null : <RotateCw />}
              Try again
            </Button>
          }
        >
          {describeError(error)} The rows below may be out of date.
        </Alert>
      ) : null}

      <span id={selectLabelId} hidden>
        Select
      </span>
      <div className="relative">
        <LoadingBar active={busy && rows.length > 0} />
        {/* From md up the rows scroll in their own area, sized to leave room for the top bar, the
            selection bar and the footer, so the header row and first column stay in view. */}
        <Table
          aria-busy={busy || undefined}
          container={{
            className: "group/scroll md:max-h-[calc(100dvh-10rem)]",
            onScroll: (event) => event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollLeft > 0),
          }}
        >
          {/* The sticky cells draw the rule under the header themselves. */}
          <TableHeader className="[&_tr]:border-b-0">
            <TableRow className="hover:bg-transparent">
              {selectable ? (
                <TableHead className={cn(stickyHeadClass, "w-12 md:left-0 md:z-20")}>
                  <Checkbox
                    aria-label="Select all rows on this page"
                    checked={allSelected ? true : selectedRows.length ? "indeterminate" : false}
                    onCheckedChange={() => {
                      setSelected(allSelected ? new Set() : new Set(keys));
                      anchor.current = null;
                    }}
                  />
                </TableHead>
              ) : null}
              {visible.map((c, columnIndex) => {
                const sorting = headerSort(c.id);
                const direction = sorting?.current?.direction ?? "asc";
                return (
                  <TableHead
                    key={c.id}
                    aria-sort={sorting?.current ? (direction === "desc" ? "descending" : "ascending") : undefined}
                    className={cn(stickyHeadClass, c.align === "right" && "text-right", columnIndex === 0 && firstHead, c.className)}
                  >
                    {sorting ? (
                      <button
                        type="button"
                        onClick={() => setSort(sorting.next)}
                        className={cn(
                          "group/sort -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                          c.align === "right" && "flex-row-reverse",
                          sorting.current && "text-foreground",
                        )}
                      >
                        {c.header}
                        {sorting.current ? (
                          direction === "desc" ? (
                            <ArrowDown className="size-3.5" />
                          ) : (
                            <ArrowUp className="size-3.5" />
                          )
                        ) : (
                          <ArrowUpDown className="size-3.5 opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody ref={body} className={busy && rows.length > 0 ? "opacity-50 transition-opacity delay-150 duration-150" : undefined}>
            {showSkeleton
              ? Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}>
                    {selectable ? <TableCell className="w-12" /> : null}
                    {visible.map((c) => (
                      <TableCell key={c.id}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row, index) => {
                  const key = keys[index]!;
                  const isActive = key === active;
                  return (
                    <TableRow
                      key={key}
                      tabIndex={isActive ? 0 : -1}
                      data-state={selected.has(key) ? "selected" : undefined}
                      data-active={isActive ? "" : undefined}
                      className={cn(ROW, onRowClick && "cursor-pointer")}
                      onFocus={() => setActive(key)}
                      onClick={(event) => {
                        if ((event.metaKey || event.ctrlKey) && rowLink(event.currentTarget)) openRow(row, event.currentTarget, true);
                        else onRowClick?.(row);
                      }}
                      onAuxClick={(event) => {
                        // Middle-click: a new tab, as on a link.
                        const link = rowLink(event.currentTarget);
                        if (event.button !== 1 || !link || (event.target as Element).closest("a[href]")) return;
                        event.preventDefault();
                        openInNewTab(link.href);
                      }}
                    >
                      {selectable ? (
                        <TableCell
                          className={cn(STICKY_CELL, ACTIVE_MARK, "w-12 md:left-0")}
                          // Shift-click selects a range of rows, not the text between the clicks.
                          onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                          onClick={(event) => {
                            event.stopPropagation();
                            // The cell around the box toggles too (the box handles its own clicks).
                            if (event.target === event.currentTarget) toggle(key, event.shiftKey);
                          }}
                        >
                          <Checkbox
                            aria-labelledby={`${selectLabelId} ${uid}-${index}`}
                            checked={selected.has(key)}
                            onClick={(event) => {
                              event.preventDefault();
                              toggle(key, event.shiftKey);
                            }}
                          />
                        </TableCell>
                      ) : null}
                      {visible.map((c, columnIndex) => (
                        <TableCell
                          key={c.id}
                          id={columnIndex === 0 ? `${uid}-${index}` : undefined}
                          data-primary={columnIndex === 0 ? "" : undefined}
                          className={cn(c.align === "right" && "tabular text-right", columnIndex === 0 && firstCell, c.className)}
                        >
                          {c.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
      </div>
      {rows.length === 0 && !showSkeleton ? (
        error ? (
          <div role="alert">
            <EmptyState
              icon={CloudOff}
              title="Couldn't load this list"
              description={describeError(error)}
              action={
                <Button variant="outline" loading={retrying} onClick={() => void retry()}>
                  {retrying ? null : <RotateCw />}
                  Try again
                </Button>
              }
            />
          </div>
        ) : (
          (empty ?? <EmptyState icon={Search} title="Nothing found" description={filtersActive ? "Try other filters." : undefined} />)
        )
      ) : null}

      {selectable && selectedRows.length > 0 && bulkActions ? (
        // Sticks to the window's bottom while the list runs past it, keeping the actions in reach.
        <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-card))] px-4 py-2 text-[13px] shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.3)]">
          <span className="font-medium" aria-live="polite">
            {selectedRows.length} selected
          </span>
          <Button variant="ghost" size="sm" onClick={clear} aria-keyshortcuts="Escape">
            Clear
          </Button>
          <fieldset disabled={busy} className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
            {bulkActions(selectedRows, clear, keep)}
          </fieldset>
        </div>
      ) : null}

      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>Saves the current search, filters and sort. Views follow your account to any device.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const name = viewName.trim();
              if (!name) return;
              setViews([...views.filter((v) => v.name !== name), { name, search: viewSearch() }]);
              setNaming(false);
              toast.success(`Saved view "${name}"`);
            }}
          >
            <Input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="e.g. Unshipped this week" aria-label="View name" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!viewName.trim()}>
                Save view
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {total !== undefined || pageInfo ? (
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5 text-[13px] text-muted-foreground">
          <span>
            {total !== null && total !== undefined ? `${total.toLocaleString()} ${total === 1 ? "result" : "results"}` : null}
            {pageInfo && page && (page > 1 || pageInfo.hasNextPage) ? `${total !== null && total !== undefined ? " · " : ""}Page ${page}` : null}
          </span>
          {pageInfo ? (
            <div className="flex items-center gap-1">
              {search.after ? (
                <Tooltip content="First page">
                  <Button variant="outline" size="icon-sm" disabled={busy} onClick={() => setSearch({ after: undefined })} aria-label="First page">
                    <ChevronsLeft />
                  </Button>
                </Tooltip>
              ) : null}
              <Button variant="outline" size="icon-sm" disabled={busy || !page || page <= 1} onClick={onPrev} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-sm" disabled={busy || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={goNext} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** Compact select for grid toolbars, writing one URL search param. */
export const FilterSelect = ({ param, label, options }: { param: keyof ListSearch; label: string; options: readonly { value: string; label: string }[] }) => {
  const [search, setSearch] = useListSearch();
  const value = search[param] ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={value ? "secondary" : "outline"} size="sm" className={cn(value && "border border-primary/30")}>
          {label}
          {value ? <span className="font-normal text-muted-foreground">: {options.find((o) => o.value === value)?.label ?? value}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuCheckboxItem checked={!value} onCheckedChange={() => setSearch({ [param]: undefined })}>
          Any
        </DropdownMenuCheckboxItem>
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.value} checked={value === o.value} onCheckedChange={() => setSearch({ [param]: o.value })}>
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Every page of a cursor connection, up to about `limit` rows, for exports. */
export const fetchAllPages = async <T,>(fetchPage: (after: string | null) => Promise<{ nodes: T[]; endCursor: string | null; hasNextPage: boolean }>, limit = 5000): Promise<T[]> => {
  const all: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await fetchPage(after);
    all.push(...page.nodes);
    if (!page.hasNextPage || !page.endCursor || all.length >= limit) return all;
    after = page.endCursor;
  }
};
