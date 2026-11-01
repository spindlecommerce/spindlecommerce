import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, FolderTree, Globe, ImageOff, Package, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DataTable, FilterSelect, fetchAllPages, useListSort, type Column, type SortOption } from "@/components/data-table";
import { Field } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox, MultiSelect } from "@/components/ui/combobox";
import { Checkbox, Switch } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Label, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf, type VariablesOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatMoney, formatNumber, relativeTime } from "@/lib/format";
import { useAction, useAdminCurrency, useCursorPages, useListSearch, useReference } from "@/lib/hooks";
import { AttributeInput, initialAttributeValue, isEmptyAttribute, toAttributeData, type AttributeFormValue } from "./attribute-inputs";
import { ProductTypesFullQuery, type EditorAttribute } from "./product-data";
import { CATALOG_KEYS, PRODUCT_STATUSES, useCategoryOptions, type ProductStatus } from "./shared";

const ProductsQuery = graphql(`
  query Products($first: Int!, $after: String, $query: String, $filter: ProductFilter, $sort: ProductSortInput, $channel: String, $currency: String) @inContext(channel: $channel, currency: $currency) {
    products(first: $first, after: $after, query: $query, filter: $filter, sort: $sort) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          status
          createdAt
          updatedAt
          productType {
            id
            name
          }
          media {
            url
          }
          variants {
            id
            sku
            isActive
            trackInventory
            stockLevels {
              quantity
            }
          }
          priceRange {
            minVariantPrice {
              amount
              currencyCode
            }
            maxVariantPrice {
              amount
              currencyCode
            }
          }
          channelListings {
            isPublished
            visibleInListings
            channel {
              id
              code
              name
            }
          }
          categories {
            id
            name
          }
        }
      }
    }
  }
`);

type Product = NonNullable<NonNullable<NonNullable<ResultOf<typeof ProductsQuery>["products"]>["edges"]>[number]>["node"] & {};

const BulkUpdate = graphql(
  `
    mutation ProductBulkUpdate($ids: [ID!]!, $input: ProductBulkUpdateInput!) {
      productBulkUpdate(ids: $ids, input: $input) {
        __typename
        ... on ProductsPayload {
          products {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const BulkDelete = graphql(
  `
    mutation ProductBulkDelete($ids: [ID!]!) {
      productBulkDelete(ids: $ids) {
        __typename
        ... on BulkDeletePayload {
          deletedIds
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type BulkInput = VariablesOf<typeof BulkUpdate>["input"];

const stockOf = (p: Product) => {
  const tracked = (p.variants ?? []).filter((v) => v.trackInventory);
  if (!tracked.length) return null;
  return tracked.reduce((sum, v) => sum + (v.stockLevels ?? []).reduce((n, l) => n + (l.quantity ?? 0), 0), 0);
};

const priceLabel = (p: Product) => {
  const min = p.priceRange?.minVariantPrice;
  const max = p.priceRange?.maxVariantPrice;
  if (!min) return "—";
  return max && max.amount !== min.amount ? `${formatMoney(min)} – ${formatMoney(max)}` : formatMoney(min);
};

// ---------------------------------------------------------------- sorting

const PAGE_SIZE = 25;

type ProductSort = NonNullable<VariablesOf<typeof ProductsQuery>["sort"]>;

/** The API sorts: newest first (paged by id), or by name or lowest price (paged by offset). */
const PRODUCT_SORTS = [
  { value: "newest", label: "Newest", api: { field: "NEWEST" } },
  { value: "name", label: "Name: A to Z", column: "name", direction: "asc", api: { field: "NAME", direction: "ASC" } },
  { value: "name-desc", label: "Name: Z to A", column: "name", direction: "desc", api: { field: "NAME", direction: "DESC" } },
  { value: "price", label: "Price: low to high", column: "price", direction: "asc", api: { field: "PRICE", direction: "ASC" } },
  { value: "price-desc", label: "Price: high to low", column: "price", direction: "desc", api: { field: "PRICE", direction: "DESC" } },
] as const satisfies readonly (SortOption & { api: ProductSort })[];

const nodesOf = (data: ResultOf<typeof ProductsQuery>) => (data.products?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

/** Prices are in the admin's channel and currency (useAdminCurrency). */
type ListVariables = Pick<VariablesOf<typeof ProductsQuery>, "query" | "filter" | "sort" | "channel" | "currency">;

/** One page of 100, for exporting everything that matches. */
const fetchProductPage = async (variables: ListVariables, after: string | null, signal?: AbortSignal) => {
  const data = await request(ProductsQuery, { ...variables, first: 100, after }, { signal });
  return { nodes: nodesOf(data), endCursor: data.products?.pageInfo.endCursor ?? null, hasNextPage: !!data.products?.pageInfo.hasNextPage, totalCount: data.products?.totalCount ?? 0 };
};

const Thumbnail = ({ url }: { url: string | null | undefined }) =>
  url ? (
    <img src={url} alt="" loading="lazy" className="size-9 shrink-0 rounded-md border bg-muted object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
  ) : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted">
      <ImageOff className="size-4 text-muted-foreground" />
    </span>
  );

export const ProductsPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const { productTypes, channels } = useReference();
  const admin = useAdminCurrency();
  const categories = useCategoryOptions();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const sort = useListSort(PRODUCT_SORTS);
  const [dialog, setDialog] = useState<{ kind: "categories" | "channels" | "attributes" | "delete"; ids: string[]; typeIds: string[]; done: () => void } | null>(null);
  const write = can("catalog:write");

  const filter: VariablesOf<typeof ProductsQuery>["filter"] = {
    status: (search.status as ProductStatus | undefined) ?? null,
    productTypeId: search.type ?? null,
    categoryId: search.category ?? null,
  };
  const variables: ListVariables = { query: search.q ?? null, filter, sort: sort.api, channel: admin.channel || null, currency: admin.currency };
  const query = useQuery({
    queryKey: [...CATALOG_KEYS.products, search.q, filter, sort.value, pages.after, admin.key],
    queryFn: async ({ signal }) => {
      const data = await request(ProductsQuery, { ...variables, first: PAGE_SIZE, after: pages.after }, { signal });
      return { rows: nodesOf(data), totalCount: data.products?.totalCount ?? null, pageInfo: { hasNextPage: !!data.products?.pageInfo.hasNextPage, endCursor: data.products?.pageInfo.endCursor ?? null } };
    },
    placeholderData: (previous) => previous,
    enabled: !admin.loading,
  });
  const rows = query.data?.rows ?? [];

  const bulk = useAction((input: { ids: string[]; input: BulkInput; label: string }) => request(BulkUpdate, { ids: input.ids, input: input.input }).then((r) => ({ result: unwrap(r.productBulkUpdate), label: input.label })), {
    success: ({ result, label }) => `${label}: ${result.products?.length ?? 0} product${result.products?.length === 1 ? "" : "s"} updated`,
    invalidate: [CATALOG_KEYS.products, CATALOG_KEYS.productDetails, CATALOG_KEYS.categories],
  });

  const remove = useAction((ids: string[]) => request(BulkDelete, { ids }).then((r) => unwrap(r.productBulkDelete)), {
    success: (r) => `${r.deletedIds?.length ?? 0} product${r.deletedIds?.length === 1 ? "" : "s"} deleted`,
    invalidate: [CATALOG_KEYS.products, CATALOG_KEYS.categories, CATALOG_KEYS.productTypes],
  });

  const setStatus = (ids: string[], status: ProductStatus, done: () => void) =>
    bulk.mutate({ ids, input: { status }, label: `Status ${status.toLowerCase()}` }, { onSuccess: done });

  const columns: Column<Product>[] = [
    {
      id: "name",
      header: "Product",
      fixed: true,
      cell: (p) => (
        <div className="flex min-w-56 items-center gap-3">
          <Thumbnail url={p.media?.[0]?.url} />
          <div className="min-w-0">
            <Link to="/products/$id" params={{ id: p.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
              {p.name || "(untitled)"}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {(p.variants ?? [])[0]?.sku}
              {(p.variants ?? []).length > 1 ? ` +${(p.variants ?? []).length - 1} more` : ""}
            </p>
          </div>
        </div>
      ),
      csv: (p) => p.name,
    },
    { id: "skus", header: "SKUs", hidden: true, cell: (p) => <span className="text-xs text-muted-foreground">{(p.variants ?? []).map((v) => v.sku).join(", ")}</span>, csv: (p) => (p.variants ?? []).map((v) => v.sku).join(" ") },
    { id: "status", header: "Status", cell: (p) => <StatusBadge value={p.status} />, csv: (p) => p.status },
    { id: "type", header: "Type", cell: (p) => <span className="text-muted-foreground">{p.productType?.name}</span>, csv: (p) => p.productType?.name },
    { id: "variants", header: "Variants", align: "right", cell: (p) => (p.variants ?? []).length, csv: (p) => (p.variants ?? []).length },
    { id: "price", header: "Price", align: "right", cell: (p) => priceLabel(p), csv: (p) => p.priceRange?.minVariantPrice?.amount },
    {
      id: "stock",
      header: "On hand",
      align: "right",
      cell: (p) => {
        const stock = stockOf(p);
        if (stock === null) return <span className="text-muted-foreground">Not tracked</span>;
        return <span className={stock <= 0 ? "font-medium text-destructive" : stock <= 5 ? "font-medium text-warning" : undefined}>{formatNumber(stock)}</span>;
      },
      csv: (p) => stockOf(p) ?? "",
    },
    {
      id: "channels",
      header: "Channels",
      cell: (p) => (
        <div className="flex flex-wrap gap-1">
          {(p.channelListings ?? []).length === 0 ? <span className="text-xs text-muted-foreground">None</span> : null}
          {(p.channelListings ?? []).map((l) => (
            <Tooltip key={l.channel?.id} content={`${l.channel?.name}: ${l.isPublished ? "published" : "not published"}${l.isPublished && !l.visibleInListings ? ", hidden from listings" : ""}`}>
              <Badge variant={l.isPublished ? "success" : "outline"}>{l.channel?.code}</Badge>
            </Tooltip>
          ))}
        </div>
      ),
      csv: (p) => (p.channelListings ?? []).filter((l) => l.isPublished).map((l) => l.channel?.code).join(" "),
    },
    { id: "categories", header: "Categories", hidden: true, cell: (p) => <span className="text-xs text-muted-foreground">{(p.categories ?? []).map((c) => c.name).join(", ") || "—"}</span>, csv: (p) => (p.categories ?? []).map((c) => c.name).join("; ") },
    {
      id: "updated",
      header: "Updated",
      cell: (p) => (
        <Tooltip content={formatDateTime(p.updatedAt)}>
          <span className="text-muted-foreground">{relativeTime(p.updatedAt)}</span>
        </Tooltip>
      ),
      csv: (p) => p.updatedAt,
    },
  ];

  const noFilters = !search.q && !search.status && !search.type && !search.category;

  return (
    <Page wide>
      <PageHeader
        title="Products"
        description="Every product in every channel. Search by name or SKU; filters and saved views live in the address bar."
        actions={
          write ? (
            <Button asChild>
              <Link to="/products/new">
                <Plus />
                Add product
              </Link>
            </Button>
          ) : null
        }
      />
      <DataTable
        id="products"
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        loading={admin.loading || query.isLoading}
        error={query.error}
        onRowClick={(p) => void navigate({ to: "/products/$id", params: { id: p.id } })}
        searchPlaceholder="Name or SKU"
        selectable={write}
        sortOptions={PRODUCT_SORTS}
        total={query.data?.totalCount}
        pageInfo={query.data?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="products"
        fetchAll={async () => {
          return fetchAllPages((after) => fetchProductPage(variables, after));
        }}
        empty={
          !admin.loading && !query.isLoading && noFilters && rows.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No products yet"
              description="Products have a type, which decides their attributes and the options their variants differ by."
              action={
                write ? (
                  <Button asChild>
                    <Link to="/products/new">
                      <Plus />
                      Add product
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
        filters={
          <>
            <FilterSelect param="status" label="Status" options={PRODUCT_STATUSES} />
            <FilterSelect param="type" label="Type" options={productTypes.map((t) => ({ value: t.id, label: t.name ?? t.code ?? "" }))} />
            <FilterSelect param="category" label="Category" options={categories.options} />
          </>
        }
        bulkActions={(selected, clear) => {
          const ids = selected.map((p) => p.id);
          const typeIds = [...new Set(selected.flatMap((p) => (p.productType?.id ? [p.productType.id] : [])))];
          const show = (kind: "categories" | "channels" | "attributes" | "delete") => setDialog({ kind, ids, typeIds, done: clear });
          return (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" loading={bulk.isPending}>
                    Set status
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Change status of {ids.length}</DropdownMenuLabel>
                  {PRODUCT_STATUSES.map((s) => (
                    <DropdownMenuItem key={s.value} onSelect={() => setStatus(ids, s.value, clear)}>
                      <StatusBadge value={s.value} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="outline" onClick={() => show("categories")}>
                <FolderTree />
                Categories
              </Button>
              <Button size="sm" variant="outline" onClick={() => show("channels")}>
                <Globe />
                Channels
              </Button>
              <Button size="sm" variant="outline" onClick={() => show("attributes")}>
                <SlidersHorizontal />
                Attributes
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => show("delete")}>
                <Trash2 />
                Delete
              </Button>
            </>
          );
        }}
      />

      <CategoriesDialog
        open={dialog?.kind === "categories"}
        count={dialog?.ids.length ?? 0}
        options={categories.options}
        loading={bulk.isPending}
        onClose={() => setDialog(null)}
        onApply={(mode, categoryIds) =>
          dialog &&
          bulk.mutate(
            { ids: dialog.ids, input: mode === "add" ? { addCategoryIds: categoryIds } : { removeCategoryIds: categoryIds }, label: mode === "add" ? "Categories added" : "Categories removed" },
            {
              onSuccess: () => {
                dialog.done();
                setDialog(null);
              },
            },
          )
        }
      />
      <ChannelsDialog
        open={dialog?.kind === "channels"}
        count={dialog?.ids.length ?? 0}
        channels={channels.map((c) => ({ id: c.id, name: c.name ?? c.code ?? "" }))}
        loading={bulk.isPending}
        onClose={() => setDialog(null)}
        onApply={(listing) =>
          dialog &&
          bulk.mutate(
            { ids: dialog.ids, input: { channelListings: [listing] }, label: listing.isPublished ? "Published" : "Unpublished" },
            {
              onSuccess: () => {
                dialog.done();
                setDialog(null);
              },
            },
          )
        }
      />
      {dialog?.kind === "attributes" ? (
        <AttributesDialog
          ids={dialog.ids}
          typeIds={dialog.typeIds}
          onClose={() => setDialog(null)}
          onDone={() => {
            dialog.done();
            setDialog(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete ${dialog?.ids.length ?? 0} product${dialog?.ids.length === 1 ? "" : "s"}?`}
        description="Their variants, prices, stock levels and media go too. Past orders keep their own copy of what was bought. This cannot be undone."
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() =>
          dialog &&
          remove.mutate(dialog.ids, {
            onSuccess: () => {
              dialog.done();
              setDialog(null);
              void queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.inventory });
            },
          })
        }
      />
    </Page>
  );
};

const CategoriesDialog = ({
  open,
  count,
  options,
  loading,
  onClose,
  onApply,
}: {
  open: boolean;
  count: number;
  options: { value: string; label: string }[];
  loading: boolean;
  onClose: () => void;
  onApply: (mode: "add" | "remove", categoryIds: string[]) => void;
}) => {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setSelected([]);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Categories for {count} products</DialogTitle>
          <DialogDescription>Other category assignments stay as they are.</DialogDescription>
        </DialogHeader>
        <Field label="Action">
          <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as "add" | "remove")}>
            <option value="add">Add to categories</option>
            <option value="remove">Remove from categories</option>
          </NativeSelect>
        </Field>
        <Field label="Categories">
          <MultiSelect options={options} value={selected} onChange={setSelected} placeholder="Choose categories" searchPlaceholder="Search categories…" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={loading} disabled={!selected.length} onClick={() => onApply(mode, selected)}>
            {mode === "add" ? "Add" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const ChannelsDialog = ({
  open,
  count,
  channels,
  loading,
  onClose,
  onApply,
}: {
  open: boolean;
  count: number;
  channels: { id: string; name: string }[];
  loading: boolean;
  onClose: () => void;
  onApply: (listing: { channelId: string; isPublished: boolean; visibleInListings: boolean }) => void;
}) => {
  const [channelId, setChannelId] = useState("");
  const [published, setPublished] = useState(true);
  const [visible, setVisible] = useState(true);
  const chosen = channelId || channels[0]?.id || "";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Channel listing for {count} products</DialogTitle>
          <DialogDescription>Lists the products in the channel (or updates their listing). Other channels stay as they are. Customers only see active products.</DialogDescription>
        </DialogHeader>
        <Field label="Channel">
          <NativeSelect value={chosen} onChange={(e) => setChannelId(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Label className="justify-between font-normal">
          Published in this channel
          <Switch checked={published} onCheckedChange={setPublished} />
        </Label>
        <Label className="justify-between font-normal">
          Shown in category pages and search
          <Switch checked={visible} disabled={!published} onCheckedChange={setVisible} />
        </Label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={loading}
            disabled={!chosen}
            onClick={() => {
              if (!chosen) return toast.error("Choose a channel");
              onApply({ channelId: chosen, isPublished: published, visibleInListings: published && visible });
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

type AttributeChange = { code: string; value: AttributeFormValue; clear: boolean };

/** One transaction: nothing is saved if any selected product's type lacks an attribute. */
const AttributesDialog = ({ ids, typeIds, onClose, onDone }: { ids: string[]; typeIds: string[]; onClose: () => void; onDone: () => void }) => {
  const reference = useReference();
  const types = useQuery({ queryKey: ["product-types-full"], queryFn: () => request(ProductTypesFullQuery), staleTime: 60_000 });
  const [changes, setChanges] = useState<AttributeChange[]>([]);
  const [error, setError] = useState<unknown>(null);
  const locales = useMemo(() => [...new Set([reference.defaultLocale, ...reference.locales].filter(Boolean))], [reference.defaultLocale, reference.locales]);

  // Product attributes of the selected products' types, with the types that lack each one.
  const available = useMemo(() => {
    const chosen = (types.data?.productTypes ?? []).filter((t) => typeIds.includes(t.id));
    const defs = new Map<string, EditorAttribute & { code: string }>();
    for (const def of chosen.flatMap((t) => t.attributes ?? [])) if (def.code && !defs.has(def.code)) defs.set(def.code, { ...def, code: def.code });
    return [...defs.values()].map((def) => ({ def, missingFrom: chosen.filter((t) => !(t.attributes ?? []).some((a) => a.code === def.code)).map((t) => t.name ?? t.code ?? "") }));
  }, [types.data, typeIds]);
  const entryOf = (code: string) => available.find((a) => a.def.code === code);

  const edit = (next: AttributeChange[]) => {
    setError(null);
    setChanges(next);
  };
  const update = (code: string, patch: Partial<AttributeChange>) => edit(changes.map((c) => (c.code === code ? { ...c, ...patch } : c)));

  const apply = useAction(
    async () => {
      const attributes = changes.flatMap((c) => {
        const def = entryOf(c.code)?.def;
        const value = c.clear ? { clear: true } : def ? toAttributeData(def, c.value) : null;
        return value ? [{ code: c.code, value }] : [];
      });
      return unwrap((await request(BulkUpdate, { ids, input: { attributes } })).productBulkUpdate);
    },
    {
      success: (r) => `Attributes updated on ${r.products?.length ?? 0} product${r.products?.length === 1 ? "" : "s"}`,
      invalidate: [CATALOG_KEYS.products, CATALOG_KEYS.productDetails],
      onError: (e) => setError(e),
      onSuccess: onDone,
    },
  );

  const fieldErrors = error instanceof MutationError ? error.fieldErrors : [];
  const errorFor = (code: string) => fieldErrors.find((e) => e.path[0] === "input" && e.path[1] === "attributes" && e.path[2] === code)?.message;
  const unplaced = fieldErrors.filter((e) => !(e.path[1] === "attributes" && changes.some((c) => c.code === e.path[2])));
  const ready = changes.length > 0 && changes.every((c) => c.clear || !isEmptyAttribute(c.value));
  const count = `${ids.length} product${ids.length === 1 ? "" : "s"}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Update attributes of {count}</DialogTitle>
          <DialogDescription>Each value you set replaces the current one on every selected product; translated text changes only the languages you fill in. Attributes you leave out stay as they are.</DialogDescription>
        </DialogHeader>
        {types.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : available.length === 0 ? (
          <EmptyState icon={SlidersHorizontal} title="No attributes to set" description="The product types of the selected products have no product attributes." className="py-6" />
        ) : (
          <div className="-mx-1 flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-1">
            {changes.map((change) => {
              const entry = entryOf(change.code);
              if (!entry) return null;
              const label = entry.def.label ?? entry.def.code;
              const message = errorFor(change.code);
              return (
                <div key={change.code} className={`rounded-lg border p-3 ${message ? "border-destructive/60" : ""}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                      <span className="truncate">{label}</span>
                      {entry.missingFrom.length ? <Badge variant="warning">Not on {entry.missingFrom.join(", ")}</Badge> : null}
                    </span>
                    <Button variant="ghost" size="icon-sm" onClick={() => edit(changes.filter((c) => c.code !== change.code))} aria-label={`Leave ${label} unchanged`}>
                      <X />
                    </Button>
                  </div>
                  {change.clear ? (
                    <p className="text-[13px] text-muted-foreground">Removed from every selected product.</p>
                  ) : (
                    <AttributeInput def={entry.def} value={change.value} onChange={(value) => update(change.code, { value })} locales={locales} invalid={!!message} />
                  )}
                  <Label className="mt-2 text-[13px] font-normal">
                    <Checkbox checked={change.clear} onCheckedChange={(v) => update(change.code, { clear: v === true })} />
                    Remove the value instead
                  </Label>
                  {message ? <p className="mt-1 text-xs text-destructive">{message}</p> : null}
                </div>
              );
            })}
            <Combobox
              options={available
                .filter((a) => !changes.some((c) => c.code === a.def.code))
                .map((a) => ({ value: a.def.code, label: a.def.label ?? a.def.code, hint: a.missingFrom.length ? `not on ${a.missingFrom.join(", ")}` : undefined }))}
              value=""
              onChange={(code) => {
                const entry = entryOf(code);
                if (entry) edit([...changes, { code, value: initialAttributeValue(entry.def, undefined, reference.defaultLocale), clear: false }]);
              }}
              placeholder={changes.length ? "Add another attribute…" : "Choose an attribute to set…"}
            />
          </div>
        )}
        {error ? (
          <Alert variant="destructive" title={error instanceof Error ? error.message : "The products were not updated"}>
            {unplaced.length ? (
              <ul className="list-disc pl-4">
                {unplaced.map((e, i) => (
                  <li key={i}>
                    {e.path.slice(1).join(".")}: {e.message}
                  </li>
                ))}
              </ul>
            ) : (
              "Nothing was saved."
            )}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={apply.isPending} disabled={!ready} onClick={() => apply.mutate(undefined)}>
            Update {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
