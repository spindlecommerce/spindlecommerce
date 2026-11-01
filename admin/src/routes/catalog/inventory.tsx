import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Boxes, Check, Download, FileUp, Loader2, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { DataTable, FilterSelect, fetchAllPages, type Column } from "@/components/data-table";
import { Field } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState } from "@/components/ui/feedback";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf, type VariablesOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber } from "@/lib/format";
import { useCursorPages, useListSearch, useReference } from "@/lib/hooks";
import { cn, downloadText, toCsv } from "@/lib/utils";
import { StockLevelAdjust, StockLevelSet } from "./product-data";
import { CATALOG_KEYS } from "./shared";

const InventoryQuery = graphql(`
  query Inventory($first: Int!, $after: String, $query: String, $maxOnHand: Int, $trackInventory: Boolean) {
    productVariants(first: $first, after: $after, query: $query, maxOnHand: $maxOnHand, trackInventory: $trackInventory) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          sku
          name
          isActive
          trackInventory
          allowBackorder
          quantityAvailable
          product {
            id
            status
          }
          stockLevels {
            quantity
            location {
              id
            }
          }
        }
      }
    }
  }
`);

const StockLevelsImport = graphql(
  `
    mutation StockLevelsImport($levels: [StockLevelImportInput!]!) {
      stockLevelsImport(levels: $levels) {
        __typename
        ... on StockLevelsImportPayload {
          applied
          results {
            error
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** Rows per stockLevelsImport call (the API takes up to 5000). */
const IMPORT_CHUNK = 1000;

type Variant = NonNullable<NonNullable<NonNullable<ResultOf<typeof InventoryQuery>["productVariants"]>["edges"]>[number]>["node"] & {};

/** "Low stock" means at or below this many on hand across locations. */
const LOW_STOCK = 5;

const VIEWS: Record<string, Pick<VariablesOf<typeof InventoryQuery>, "maxOnHand" | "trackInventory">> = {
  low: { maxOnHand: LOW_STOCK, trackInventory: true },
  out: { maxOnHand: 0, trackInventory: true },
  tracked: { trackInventory: true },
  untracked: { trackInventory: false },
};

const levelAt = (variant: Variant, locationId: string) => variant.stockLevels?.find((l) => l.location?.id === locationId)?.quantity ?? 0;
const totalOf = (variant: Variant) => (variant.stockLevels ?? []).reduce((sum, l) => sum + (l.quantity ?? 0), 0);

// ---------------------------------------------------------------- writing counts

type InventoryData = ResultOf<typeof InventoryQuery>;
/** A variant at a location; `sku` and `place` name it in toasts. */
type StockCellRef = { variantId: string; locationId: string; sku: string; place: string };
type CellStatus = "saving" | "saved" | "error";
type Move = "down" | "up" | "next" | "prev";

const cellKey = (variantId: string, locationId: string) => `${variantId}|${locationId}`;
/** One toast for the latest count, replaced by the next, so counting a shelf doesn't stack them. */
const COUNT_TOAST = "inventory-count";
/** Quick − and + clicks within this long go to the server as one adjustment. */
const BATCH_MS = 450;
/** Refetch once writes settle and nobody is typing; availability and views come from the server. */
const REFRESH_MS = 1500;

/** Updates every cached inventory page, adding the level if the variant had none at that location. */
const patchLevel = (queryClient: QueryClient, variantId: string, locationId: string, update: (quantity: number) => number) =>
  queryClient.setQueriesData<InventoryData>({ queryKey: CATALOG_KEYS.inventory }, (data) => {
    const connection = data?.productVariants;
    if (!connection?.edges) return data;
    return {
      ...data,
      productVariants: {
        ...connection,
        edges: connection.edges.map((edge) => {
          const node = edge?.node;
          if (!node || node.id !== variantId) return edge;
          const levels = node.stockLevels ?? [];
          const stockLevels = levels.some((l) => l.location?.id === locationId)
            ? levels.map((l) => (l.location?.id === locationId ? { ...l, quantity: update(l.quantity ?? 0) } : l))
            : [...levels, { quantity: update(0), location: { id: locationId } }];
          return { ...edge, node: { ...node, stockLevels } };
        }),
      },
    };
  });

/**
 * Optimistic stock writes, sent one after another per cell so a count and the clicks around it
 * land in order. It outlives the page, so Undo in a toast still works after leaving.
 */
const createStockWriter = (queryClient: QueryClient, isEditing: () => boolean) => {
  const statuses = new Map<string, CellStatus>();
  const listeners = new Set<() => void>();
  const queues = new Map<string, Promise<void>>();
  const queued = new Map<string, number>();
  const batches = new Map<string, { cell: StockCellRef; delta: number; timer: ReturnType<typeof setTimeout> }>();
  const fades = new Map<string, ReturnType<typeof setTimeout>>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const mark = (key: string, status: CellStatus | null) => {
    clearTimeout(fades.get(key));
    fades.delete(key);
    if (status) statuses.set(key, status);
    else statuses.delete(key);
    if (status === "saved") fades.set(key, setTimeout(() => mark(key, null), 1600));
    for (const listener of listeners) listener();
  };
  const settled = () => batches.size === 0 && [...queued.values()].every((n) => n === 0);
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (!settled() || isEditing()) return scheduleRefresh();
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.inventory });
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.productDetails });
    }, REFRESH_MS);
  };
  /** Cancels refetches in flight, which would bring back the old number. */
  const optimistic = (cell: StockCellRef, update: (quantity: number) => number) => {
    void queryClient.cancelQueries({ queryKey: CATALOG_KEYS.inventory });
    patchLevel(queryClient, cell.variantId, cell.locationId, update);
  };

  /** Runs `send` after the cell's earlier writes; `revert` undoes the optimistic change on failure. */
  const enqueue = (cell: StockCellRef, send: () => Promise<number>, revert: () => void, onSaved: (quantity: number) => void) => {
    const key = cellKey(cell.variantId, cell.locationId);
    queued.set(key, (queued.get(key) ?? 0) + 1);
    mark(key, "saving");
    const run = async () => {
      try {
        const quantity = await send();
        const last = queued.get(key) === 1 && !batches.has(key);
        if (last) {
          patchLevel(queryClient, cell.variantId, cell.locationId, () => quantity);
          mark(key, "saved");
        }
        onSaved(quantity);
      } catch (error) {
        revert();
        mark(key, "error");
        toast.error(`${cell.sku} at ${cell.place} was not saved`, { id: COUNT_TOAST, description: error instanceof Error ? error.message : undefined });
      } finally {
        queued.set(key, (queued.get(key) ?? 1) - 1);
        scheduleRefresh();
      }
    };
    const next = (queues.get(key) ?? Promise.resolve()).then(run);
    queues.set(key, next);
  };

  /** Send the cell's pending clicks now. */
  const flush = (cell: StockCellRef) => {
    const key = cellKey(cell.variantId, cell.locationId);
    const batch = batches.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    batches.delete(key);
    if (batch.delta === 0) {
      if (!queued.get(key)) mark(key, null);
      return;
    }
    adjust(cell, batch.delta);
  };

  const adjust = (cell: StockCellRef, delta: number, undo = false) => {
    if (undo) optimistic(cell, (q) => q + delta);
    enqueue(
      cell,
      async () => unwrap((await request(StockLevelAdjust, { variantId: cell.variantId, locationId: cell.locationId, delta })).stockLevelAdjust).stockLevel?.quantity ?? 0,
      () => patchLevel(queryClient, cell.variantId, cell.locationId, (q) => q - delta),
      (quantity) =>
        undo
          ? toast.success(`Undone: ${cell.sku} at ${cell.place} is ${formatNumber(quantity)}`, { id: COUNT_TOAST })
          : toast.success(`${delta > 0 ? "Added" : "Removed"} ${formatNumber(Math.abs(delta))} ${delta > 0 ? "to" : "from"} ${cell.sku} at ${cell.place} (now ${formatNumber(quantity)})`, {
              id: COUNT_TOAST,
              action: { label: "Undo", onClick: () => adjust(cell, -delta, true) },
            }),
    );
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    status: (variantId: string, locationId: string) => statuses.get(cellKey(variantId, locationId)),
    /** − or + one: shown at once, sent with the clicks around it. */
    bump: (cell: StockCellRef, delta: number) => {
      const key = cellKey(cell.variantId, cell.locationId);
      optimistic(cell, (q) => q + delta);
      const batch = batches.get(key);
      clearTimeout(batch?.timer);
      batches.set(key, { cell, delta: (batch?.delta ?? 0) + delta, timer: setTimeout(() => flush(cell), BATCH_MS) });
      mark(key, "saving");
    },
    /** A counted quantity; `previous` is what the cell showed, for Undo. */
    set: function set(cell: StockCellRef, quantity: number, previous: number, undo = false) {
      flush(cell);
      optimistic(cell, () => quantity);
      enqueue(
        cell,
        async () => unwrap((await request(StockLevelSet, { variantId: cell.variantId, locationId: cell.locationId, quantity })).stockLevelSet).stockLevel?.quantity ?? quantity,
        () => patchLevel(queryClient, cell.variantId, cell.locationId, (q) => q - (quantity - previous)),
        (saved) =>
          undo
            ? toast.success(`Undone: ${cell.sku} at ${cell.place} is ${formatNumber(saved)} again`, { id: COUNT_TOAST })
            : toast.success(`Set ${cell.sku} at ${cell.place} to ${formatNumber(saved)}`, { id: COUNT_TOAST, action: { label: "Undo", onClick: () => set(cell, previous, saved, true) } }),
      );
    },
  };
};

type StockWriter = ReturnType<typeof createStockWriter>;

type StockGrid = {
  writer: StockWriter;
  editing: { variantId: string; locationId: string; initial?: string } | null;
  open: (variantId: string, locationId: string, initial?: string) => void;
  /** `focusCell` puts focus back on the cell, as after Escape. */
  close: (cell: { variantId: string; locationId: string }, focusCell: boolean) => void;
  move: (cell: { variantId: string; locationId: string }, direction: Move) => void;
};

const CountInput = ({ quantity, initial, label, onDone, onCancel }: { quantity: number; initial?: string; label: string; onDone: (count: number | null, move: Move | null) => void; onCancel: () => void }) => {
  const [value, setValue] = useState(initial ?? String(quantity));
  const [invalid, setInvalid] = useState(false);
  // Untouched, the cell saves nothing, even if its number changed meanwhile.
  const [typed, setTyped] = useState(initial !== undefined);
  const finished = useRef(false);
  /** null: nothing typed, so nothing to save; undefined: not a count. */
  const parsed = () => {
    if (!typed) return null;
    const text = value.trim();
    if (text === "") return null;
    const count = Number(text);
    return Number.isInteger(count) && count >= 0 ? count : undefined;
  };
  const finish = (move: Move | null) => {
    const count = parsed();
    if (count === undefined) {
      setInvalid(true);
      return;
    }
    finished.current = true;
    onDone(count, move);
  };
  return (
    <Input
      autoFocus
      inputMode="numeric"
      className="h-7 w-20 text-right tabular"
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? "A whole number of 0 or more" : undefined}
      onFocus={(e) => {
        // A count replaces the number; after a digit typed on the cell, typing goes on after it.
        const input = e.currentTarget;
        if (initial === undefined) input.select();
        else input.setSelectionRange(input.value.length, input.value.length);
      }}
      onChange={(e) => {
        setValue(e.target.value);
        setTyped(true);
        setInvalid(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          finish(e.key === "Enter" ? (e.shiftKey ? "up" : "down") : e.shiftKey ? "prev" : "next");
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finished.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (finished.current) return;
        finished.current = true;
        // Clicking away saves a valid count and drops anything else.
        const count = parsed();
        if (count === undefined) onCancel();
        else onDone(count, null);
      }}
    />
  );
};

const StockCell = ({ variant, locationId, place, editable, grid }: { variant: Variant; locationId: string; place: string; editable: boolean; grid: StockGrid }) => {
  const quantity = levelAt(variant, locationId);
  const status = useSyncExternalStore(grid.writer.subscribe, () => grid.writer.status(variant.id, locationId));
  if (!editable) return <span className={cn(quantity <= 0 && variant.trackInventory && "text-destructive")}>{formatNumber(quantity)}</span>;
  const cell: StockCellRef = { variantId: variant.id, locationId, sku: variant.sku ?? variant.name ?? "", place };
  const editing = grid.editing?.variantId === variant.id && grid.editing.locationId === locationId ? grid.editing : null;
  const label = `${variant.sku ?? variant.name} at ${place}`;
  const adjustButton = "flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <div data-stock-cell="" data-variant={variant.id} data-location={locationId} className="group flex items-center justify-end gap-0.5">
      <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
        {status === "saving" ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : status === "saved" ? <Check className="size-3.5 text-success" /> : null}
      </span>
      <span className="sr-only" aria-live="polite">
        {status === "saved" ? `${label} saved` : status === "error" ? `${label} not saved` : ""}
      </span>
      {editing ? (
        <CountInput
          quantity={quantity}
          initial={editing.initial}
          label={`Count for ${label}`}
          onDone={(count, move) => {
            if (count !== null && count !== quantity) grid.writer.set(cell, count, quantity);
            if (move) grid.move(cell, move);
            else grid.close(cell, false);
          }}
          onCancel={() => grid.close(cell, true)}
        />
      ) : (
        <>
          <button type="button" aria-label={`Remove one from ${label}`} className={adjustButton} onClick={() => grid.writer.bump(cell, -1)}>
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            data-count=""
            className={cn(
              "min-w-10 rounded px-1.5 py-0.5 text-right tabular outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
              quantity <= 0 && variant.trackInventory && "font-medium text-destructive",
              quantity > 0 && quantity <= LOW_STOCK && variant.trackInventory && "font-medium text-warning",
              status === "error" && "ring-2 ring-destructive",
            )}
            aria-label={`Count for ${label}, ${formatNumber(quantity)} on hand`}
            title="Click or type a number to enter a count; + and − adjust by one"
            onClick={() => grid.open(variant.id, locationId)}
            onKeyDown={(e) => {
              if (e.metaKey || e.ctrlKey || e.altKey) return;
              // The cell owns these keys, so list shortcuts don't also act on them.
              if (/^[0-9]$/.test(e.key)) grid.open(variant.id, locationId, e.key);
              else if (e.key === "+" || e.key === "=") grid.writer.bump(cell, 1);
              else if (e.key === "-" || e.key === "_") grid.writer.bump(cell, -1);
              else if (e.key === "Enter" || e.key === "F2") grid.open(variant.id, locationId);
              else return;
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {formatNumber(quantity)}
          </button>
          <button type="button" aria-label={`Add one to ${label}`} className={adjustButton} onClick={() => grid.writer.bump(cell, 1)}>
            <Plus className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
};

/** Moves between cells in on-screen order, so hidden columns are skipped. */
const useStockGrid = (): StockGrid => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StockGrid["editing"]>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [writer] = useState(() => createStockWriter(queryClient, () => editingRef.current !== null));
  const focusAfter = useRef<{ variantId: string; locationId: string } | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (!target || editing) return;
    focusAfter.current = null;
    document.querySelector<HTMLElement>(`[data-stock-cell][data-variant="${CSS.escape(target.variantId)}"][data-location="${CSS.escape(target.locationId)}"] [data-count]`)?.focus();
  }, [editing]);
  // Leaving the page while a cell is open must not hold back the refresh.
  useEffect(() => () => void (editingRef.current = null), []);

  return {
    writer,
    editing,
    open: (variantId, locationId, initial) => setEditing({ variantId, locationId, ...(initial !== undefined ? { initial } : {}) }),
    close: (cell, focusCell) => {
      if (focusCell) focusAfter.current = cell;
      setEditing((current) => (current?.variantId === cell.variantId && current.locationId === cell.locationId ? null : current));
    },
    move: (cell, direction) => {
      const cells = [...document.querySelectorAll<HTMLElement>("[data-stock-cell]")];
      const index = cells.findIndex((c) => c.dataset.variant === cell.variantId && c.dataset.location === cell.locationId);
      const after = cells.slice(index + 1);
      const before = cells.slice(0, Math.max(index, 0)).reverse();
      const sameColumn = (c: HTMLElement) => c.dataset.location === cell.locationId;
      const target = index < 0 ? undefined : direction === "down" ? after.find(sameColumn) : direction === "up" ? before.find(sameColumn) : direction === "next" ? after[0] : before[0];
      if (!target?.dataset.variant || !target.dataset.location) {
        // The edge of the page: close and stay on the cell.
        focusAfter.current = cell;
        setEditing(null);
        return;
      }
      setEditing({ variantId: target.dataset.variant, locationId: target.dataset.location });
    },
  };
};

export const InventoryPage = () => {
  const { can } = useAuth();
  const write = can("inventory:write");
  const { stockLocations } = useReference();
  const grid = useStockGrid();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const [importing, setImporting] = useState(false);
  const view = search.view ? VIEWS[search.view] : undefined;
  const variables = { first: 50, after: pages.after, query: search.q ?? null, maxOnHand: view?.maxOnHand ?? null, trackInventory: view?.trackInventory ?? null };
  const query = useQuery({
    queryKey: [...CATALOG_KEYS.inventory, search.q, search.view, pages.after],
    queryFn: ({ signal }) => request(InventoryQuery, variables, { signal }),
    placeholderData: (previous) => previous,
  });
  const rows = (query.data?.productVariants?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

  const columns: Column<Variant>[] = [
    {
      id: "variant",
      header: "Variant",
      fixed: true,
      cell: (v) => (
        <div className="min-w-48">
          {v.product ? (
            <Link to="/products/$id" params={{ id: v.product.id }} className="font-medium hover:underline">
              {v.name}
            </Link>
          ) : (
            <span className="font-medium">{v.name}</span>
          )}
          <p className="font-mono text-xs text-muted-foreground">{v.sku}</p>
        </div>
      ),
      csv: (v) => v.name,
    },
    { id: "sku", header: "SKU", hidden: true, cell: (v) => <span className="font-mono text-xs">{v.sku}</span>, csv: (v) => v.sku },
    ...stockLocations.map<Column<Variant>>((location) => ({
      id: `location:${location.id}`,
      header: location.name ?? location.code ?? "",
      align: "right",
      cell: (v) => <StockCell variant={v} locationId={location.id} place={location.name ?? location.code ?? ""} editable={write} grid={grid} />,
      csv: (v) => levelAt(v, location.id),
    })),
    {
      id: "total",
      header: "On hand",
      align: "right",
      cell: (v) => <span className="font-medium">{formatNumber(totalOf(v))}</span>,
      csv: (v) => totalOf(v),
    },
    {
      id: "available",
      header: "Available",
      align: "right",
      cell: (v) => (v.trackInventory ? formatNumber(v.quantityAvailable) : <span className="text-muted-foreground">∞</span>),
      csv: (v) => (v.trackInventory ? v.quantityAvailable : ""),
    },
    {
      id: "tracking",
      header: "Tracking",
      cell: (v) =>
        v.trackInventory ? (
          v.allowBackorder ? (
            <Badge variant="info">Backorders allowed</Badge>
          ) : (
            <Badge variant="secondary">Tracked</Badge>
          )
        ) : (
          <Badge variant="outline">Not tracked</Badge>
        ),
      csv: (v) => (v.trackInventory ? (v.allowBackorder ? "backorder" : "tracked") : "untracked"),
    },
    {
      id: "status",
      header: "Status",
      cell: (v) => (v.isActive ? <StatusBadge value={v.product?.status} /> : <Badge variant="outline">Variant inactive</Badge>),
      csv: (v) => (v.isActive ? v.product?.status : "INACTIVE"),
    },
  ];

  return (
    <Page wide>
      <PageHeader
        title="Inventory"
        description={`On-hand stock per location. Click a number (or Tab to it and type) to enter a count: Enter saves and moves down, Shift+Enter up, Tab across, Escape cancels. − and + adjust by one. Available subtracts open orders' reservations in the default channel's stock. Low stock is ${LOW_STOCK} or fewer.`}
        actions={
          write ? (
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp />
              Import counts
            </Button>
          ) : null
        }
      />
      {stockLocations.length === 0 ? (
        <Alert variant="info" className="mb-4" title="No stock locations">
          Create a stock location under Settings › Stock locations to record quantities.
        </Alert>
      ) : null}
      <DataTable
        id="inventory"
        rows={rows}
        columns={columns}
        rowKey={(v) => v.id}
        loading={query.isLoading}
        error={query.error}
        searchPlaceholder="SKU, barcode or product name"
        total={query.data?.productVariants?.totalCount}
        pageInfo={query.data?.productVariants?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="inventory"
        fetchAll={() =>
          fetchAllPages(async (after) => {
            const data = await request(InventoryQuery, { ...variables, first: 100, after });
            return { nodes: (data.productVariants?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])), endCursor: data.productVariants?.pageInfo.endCursor ?? null, hasNextPage: !!data.productVariants?.pageInfo.hasNextPage };
          })
        }
        filters={
          <FilterSelect
            param="view"
            label="Stock"
            options={[
              { value: "low", label: `Low (≤ ${LOW_STOCK})` },
              { value: "out", label: "Out of stock" },
              { value: "tracked", label: "Tracked" },
              { value: "untracked", label: "Not tracked" },
            ]}
          />
        }
        empty={!query.isLoading && rows.length === 0 && !search.q && !search.view ? <EmptyState icon={Boxes} title="No variants yet" description="Variants appear here once products are created." /> : undefined}
      />
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </Page>
  );
};

// ---------------------------------------------------------------- CSV import

/** RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === "," || char === ";" || char === "\t") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
};

type ImportRow = { line: number; sku: string; location: string; quantity: string };
type ImportResult = { line: number; sku: string; location: string; quantity: string; error: string | null };

const toRows = (table: string[][]): ImportRow[] => {
  if (!table.length) return [];
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const named = { sku: find("sku"), location: find("location", "location_code", "location code", "source", "source_code"), quantity: find("quantity", "qty", "on_hand", "on hand") };
  const hasHeader = named.sku >= 0;
  const columns = hasHeader ? named : { sku: 0, location: 1, quantity: 2 };
  return table.slice(hasHeader ? 1 : 0).map((cells, i) => ({
    line: i + (hasHeader ? 2 : 1),
    sku: (cells[columns.sku] ?? "").trim(),
    location: (cells[columns.location] ?? "").trim(),
    quantity: (cells[columns.quantity] ?? "").trim(),
  }));
};

/** Set counted quantities from a CSV of sku, location code and quantity. */
const ImportDialog = ({ onClose }: { onClose: () => void }) => {
  const queryClient = useQueryClient();
  const { stockLocations } = useReference();
  const [text, setText] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const rows = toRows(parseCsv(text));
  const unknownLocations = [...new Set(rows.map((r) => r.location).filter((code) => code && !stockLocations.some((l) => l.code === code)))];
  const running = !!progress && progress.done < progress.total;

  const run = async () => {
    const out: ImportResult[] = [];
    const valid: ImportRow[] = [];
    for (const row of rows) {
      const quantity = Number(row.quantity);
      if (row.quantity === "" || !Number.isInteger(quantity) || quantity < 0) out.push({ ...row, error: `Quantity "${row.quantity}" is not a whole number of 0 or more` });
      else valid.push(row);
    }
    // The server resolves SKUs and location codes and reports the rows it skipped.
    setProgress({ done: out.length, total: rows.length });
    for (let start = 0; start < valid.length; start += IMPORT_CHUNK) {
      const chunk = valid.slice(start, start + IMPORT_CHUNK);
      try {
        const levels = chunk.map((r) => ({ sku: r.sku, locationCode: r.location, quantity: Number(r.quantity) }));
        const result = unwrap((await request(StockLevelsImport, { levels })).stockLevelsImport);
        chunk.forEach((row, i) => out.push({ ...row, error: result.results?.[i]?.error ?? null }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed";
        chunk.forEach((row) => out.push({ ...row, error: message }));
      }
      setProgress({ done: out.length, total: rows.length });
    }
    out.sort((a, b) => a.line - b.line);
    setResults(out);
    await queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.inventory });
    const failed = out.filter((r) => r.error).length;
    if (out.length - failed) toast.success(`${out.length - failed} stock level${out.length - failed === 1 ? "" : "s"} updated`);
    if (failed) toast.error(`${failed} row${failed === 1 ? "" : "s"} failed`);
  };

  const failures = results?.filter((r) => r.error) ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent wide dirty={!!text.trim() && !results && !running}>
        <DialogHeader>
          <DialogTitle>Import stock counts</DialogTitle>
          <DialogDescription>
            A CSV with the columns <code className="rounded bg-muted px-1">sku</code>, <code className="rounded bg-muted px-1">location</code> (the location code) and <code className="rounded bg-muted px-1">quantity</code>. Each row sets the on-hand count at one location.
          </DialogDescription>
        </DialogHeader>
        {results ? (
          <div className="flex flex-col gap-3">
            <Alert variant={failures.length ? "warning" : "success"} title={`${results.length - failures.length} of ${results.length} rows imported`}>
              {failures.length ? "The rows below were skipped." : "Every row was applied."}
            </Alert>
            {failures.length ? (
              <div className="max-h-64 overflow-y-auto rounded-lg border text-[13px]">
                <table className="w-full">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">Line</th>
                      <th className="px-3 py-1.5 text-left font-medium">SKU</th>
                      <th className="px-3 py-1.5 text-left font-medium">Problem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {failures.map((f) => (
                      <tr key={f.line}>
                        <td className="px-3 py-1.5 tabular">{f.line}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{f.sku || "—"}</td>
                        <td className="px-3 py-1.5 text-destructive">{f.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <Field label="CSV file">
              <Input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setText(await file.text());
                }}
              />
            </Field>
            <Field label="…or paste rows" hint={stockLocations.length ? `Location codes: ${stockLocations.map((l) => l.code).join(", ")}` : undefined}>
              <Textarea rows={6} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={`sku,location,quantity\nOXF-BLUE-M,${stockLocations[0]?.code ?? "warehouse"},24`} />
            </Field>
            {rows.length ? <p className="text-[13px] text-muted-foreground">{rows.length} row{rows.length === 1 ? "" : "s"} ready.</p> : null}
            {unknownLocations.length ? <Alert variant="warning">Unknown location codes will be skipped: {unknownLocations.join(", ")}</Alert> : null}
            {progress ? (
              <div className="space-y-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {progress.done} of {progress.total}
                </p>
              </div>
            ) : null}
          </>
        )}
        <DialogFooter>
          {results && failures.length ? (
            <Button variant="outline" onClick={() => downloadText(`stock-import-errors-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([["line", "sku", "location", "quantity", "error"], ...failures.map((f) => [f.line, f.sku, f.location, f.quantity, f.error])]))}>
              <Download />
              Download problems
            </Button>
          ) : null}
          <Button variant="outline" disabled={running} onClick={onClose}>
            {results ? "Close" : "Cancel"}
          </Button>
          {results ? null : (
            <Button loading={running} disabled={!rows.length} onClick={() => void run()}>
              <FileUp />
              Import {rows.length || ""} row{rows.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
