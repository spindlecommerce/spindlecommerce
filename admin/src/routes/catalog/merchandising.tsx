import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Eye, EyeOff, ImageOff, LayoutGrid, Package, Pin, PinOff, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type DragEvent, type ReactNode } from "react";
import { Page, PageHeader } from "@/components/layout/page";
import { SaveBar, useSaveShortcut } from "@/components/save-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatMoney } from "@/lib/format";
import { useAction, useAdminCurrency } from "@/lib/hooks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { cn } from "@/lib/utils";
import { CATALOG_KEYS, gid } from "./shared";

/** Board order: pinned, hidden, then the rest newest first. Prices are in the admin's currency. */
const MerchandisingQuery = graphql(`
  query CategoryMerchandising($id: ID!, $channel: String, $currency: String) @inContext(channel: $channel, currency: $currency) {
    category(id: $id) {
      id
      name
      merchandising {
        totalCount
        items {
          pinned
          hidden
          product {
            id
            name
            status
            createdAt
            media {
              url
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
            variants {
              isActive
              trackInventory
              stockLevels {
                quantity
              }
            }
          }
        }
      }
    }
  }
`);

const MerchandisingUpdate = graphql(
  `
    mutation CategoryMerchandisingUpdate($id: ID!, $input: CategoryMerchandisingInput!) {
      categoryMerchandisingUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type Item = NonNullable<NonNullable<NonNullable<ResultOf<typeof MerchandisingQuery>["category"]>["merchandising"]>["items"]>[number];
type Product = NonNullable<Item["product"]>;

/** Pinned is ordered, hidden is not; every other product is placed automatically. */
type Arrangement = { pinned: string[]; hidden: string[] };
type Zone = "pinned" | "rest" | "hidden";
/** Where a dragged product would land; `index` only in the pinned zone. */
type Target = { zone: Zone; index?: number };

/** The storefront's order for products nobody placed. */
const newestFirst = (a: Product, b: Product) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id);

/** Units on hand across the active variants that track stock; null when none do. */
const stockOf = (p: Product) => {
  const tracked = (p.variants ?? []).filter((v) => v.isActive && v.trackInventory);
  if (!tracked.length) return null;
  return tracked.reduce((sum, v) => sum + (v.stockLevels ?? []).reduce((n, l) => n + (l.quantity ?? 0), 0), 0);
};

const priceLabel = (p: Product) => {
  const min = p.priceRange?.minVariantPrice;
  const max = p.priceRange?.maxVariantPrice;
  if (!min) return "No price";
  return max && max.amount !== min.amount ? `${formatMoney(min)} – ${formatMoney(max)}` : formatMoney(min);
};

const without = (a: Arrangement, id: string): Arrangement => ({ pinned: a.pinned.filter((x) => x !== id), hidden: a.hidden.filter((x) => x !== id) });

/** Pin `id` at `index` of the pinned list as it is now (with `id` still in it if it was pinned). */
const pinAt = (a: Arrangement, id: string, index: number): Arrangement => {
  const from = a.pinned.indexOf(id);
  const at = from !== -1 && from < index ? index - 1 : index;
  const rest = without(a, id);
  return { ...rest, pinned: [...rest.pinned.slice(0, at), id, ...rest.pinned.slice(at)] };
};

const same = (a: Arrangement | null, b: Arrangement) => !!a && a.pinned.join() === b.pinned.join() && [...a.hidden].sort().join() === [...b.hidden].sort().join();

export const MerchandisingPage = () => {
  const params = useParams({ strict: false }) as { id?: string };
  const id = gid("Category", params.id ?? "");
  const { can } = useAuth();
  const write = can("catalog:write");
  const admin = useAdminCurrency();
  const query = useQuery({
    queryKey: [...CATALOG_KEYS.categories, "merchandising", id, admin.key],
    queryFn: () => request(MerchandisingQuery, { id, channel: admin.channel || null, currency: admin.currency }),
    enabled: !admin.loading,
    // Changing currency keeps the board on screen; another category does not.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === id ? previous : undefined),
  });
  const category = query.data?.category;
  const total = category?.merchandising?.totalCount ?? 0;

  const items = useMemo(() => (category?.merchandising?.items ?? []).filter((i): i is Item & { product: Product } => !!i.product), [category]);
  const products = useMemo(() => new Map(items.map((i) => [i.product.id, i.product])), [items]);
  const initial = useMemo<Arrangement>(() => ({ pinned: items.filter((i) => i.pinned).map((i) => i.product.id), hidden: items.filter((i) => i.hidden).map((i) => i.product.id) }), [items]);
  const [arrangement, setArrangement] = useState(initial);
  const dirty = !same(arrangement, initial);

  // Fresh data (after saving, or a refetch) replaces the board unless it holds edits made since.
  const shown = useRef(initial);
  const saved = useRef<Arrangement | null>(null);
  useEffect(() => {
    if (shown.current === initial) return;
    if (same(shown.current, arrangement) || same(saved.current, arrangement)) setArrangement(initial);
    shown.current = initial;
    saved.current = null;
  }, [initial]); // Only when the data changes: `arrangement` is the board as it is at that moment.

  const unsaved = useUnsavedChanges(dirty, { description: "The order and hidden products you changed here will be lost." });
  const save = useAction(async (sent: Arrangement) => unwrap((await request(MerchandisingUpdate, { id, input: sent })).categoryMerchandisingUpdate), {
    success: "Merchandising saved",
    invalidate: [CATALOG_KEYS.categories],
    onSuccess: (_result, sent) => {
      saved.current = sent;
    },
  });
  const submit = () => {
    if (dirty && !save.isPending) save.mutate(arrangement);
  };
  useSaveShortcut(submit, dirty);

  const pinnedIds = new Set(arrangement.pinned);
  const hiddenIds = new Set(arrangement.hidden);
  const pinned = arrangement.pinned.map((p) => products.get(p)).filter((p): p is Product => !!p);
  const hidden = arrangement.hidden.map((p) => products.get(p)).filter((p): p is Product => !!p).sort(newestFirst);
  const rest = items.map((i) => i.product).filter((p) => !pinnedIds.has(p.id) && !hiddenIds.has(p.id)).sort(newestFirst);
  const unlisted = total - items.length;

  // ------------------------------------------------------------ dragging

  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  const place = (productId: string, to: Target) =>
    setArrangement((a) => {
      if (to.zone === "pinned") return pinAt(a, productId, to.index ?? a.pinned.length);
      const rest = without(a, productId);
      return to.zone === "hidden" ? { ...rest, hidden: [...rest.hidden, productId] } : rest;
    });

  const endDrag = () => {
    setDragId(null);
    setTarget(null);
  };

  const dragProps = (product: Product) =>
    write
      ? {
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", product.name ?? product.id);
            setDragId(product.id);
          },
          onDragEnd: endDrag,
        }
      : null;

  /** A zone takes a dragged product anywhere in it; pinned tiles narrow that to a place. */
  const zoneProps = (zone: Zone) =>
    write
      ? {
          onDragOver: (e: DragEvent) => {
            if (!dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (zone !== "pinned" || !(e.target as Element).closest("[data-tile]")) setTarget(zone === "pinned" ? { zone, index: arrangement.pinned.length } : { zone });
          },
          onDragLeave: (e: DragEvent) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dragId && target) place(dragId, target);
            endDrag();
          },
        }
      : {};

  const pinnedTileTarget = (index: number) => (e: DragEvent<HTMLLIElement>) => {
    if (!dragId) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setTarget({ zone: "pinned", index: e.clientX > box.left + box.width / 2 ? index + 1 : index });
  };

  const dropAt = (index: number) => (target?.zone === "pinned" ? (target.index === index ? "before" : index === pinned.length - 1 && target.index === pinned.length ? "after" : null) : null);

  // ------------------------------------------------------------ rendering

  if (admin.loading || query.isLoading) {
    return (
      <Page wide>
        <Skeleton className="mb-6 h-12 w-72" />
        <TileGrid>
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i}>
              <Skeleton className="aspect-[4/5] w-full rounded-lg" />
            </li>
          ))}
        </TileGrid>
      </Page>
    );
  }

  if (!category) {
    return (
      <Page>
        <PageHeader back={{ to: "/categories", label: "Categories" }} title="Merchandising" />
        <Card>
          <EmptyState icon={LayoutGrid} title="Category not found" description="It may have been deleted. Choose another one under Categories." />
        </Card>
      </Page>
    );
  }

  return (
    <Page wide>
      <PageHeader
        back={{ to: "/categories", label: "Categories" }}
        title={`Merchandise ${category.name || "category"}`}
        description="Choose what shoppers see first on this category's page: pinned products lead, in your order, then everything else, newest first. This is the storefront's Featured sort, the one category pages open with."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/products" search={{ category: category.id }}>
              <Package />
              {total} {total === 1 ? "product" : "products"}
            </Link>
          </Button>
        }
      />

      {items.length === 0 ? (
        <Card>
          <EmptyState icon={LayoutGrid} title="No products in this category yet" description="Assign products to it, or to a category below it, then arrange them here." />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <ZoneCard
            title="Pinned"
            count={pinned.length}
            description={write ? "Shown first, in this order. Drag to reorder, or drag products here from below. A draft can be pinned now and shows once it goes live." : "Shown first, in this order."}
            active={target?.zone === "pinned"}
            {...zoneProps("pinned")}
          >
            {pinned.length ? (
              <TileGrid label="Pinned products">
                {pinned.map((product, index) => (
                  <Tile
                    key={product.id}
                    product={product}
                    position={index}
                    dragging={dragId === product.id}
                    drop={dropAt(index)}
                    drag={dragProps(product)}
                    onDragOver={write ? pinnedTileTarget(index) : undefined}
                    actions={
                      write ? (
                        <>
                          <TileAction label="Move earlier" icon={ArrowLeft} disabled={index === 0} onClick={() => setArrangement((a) => pinAt(a, product.id, index - 1))} />
                          <TileAction label="Move later" icon={ArrowRight} disabled={index === pinned.length - 1} onClick={() => setArrangement((a) => pinAt(a, product.id, index + 2))} />
                          <TileAction label="Unpin" icon={PinOff} onClick={() => place(product.id, { zone: "rest" })} />
                          <TileAction label="Hide from this category" icon={EyeOff} onClick={() => place(product.id, { zone: "hidden" })} />
                        </>
                      ) : null
                    }
                  />
                ))}
              </TileGrid>
            ) : (
              <DropHint>{write ? "Nothing pinned yet. Drag products here, or use Pin, to show them first." : "Nothing pinned: every product follows the automatic order."}</DropHint>
            )}
          </ZoneCard>

          <ZoneCard
            title="Then newest first"
            count={rest.length + Math.max(unlisted, 0)}
            description={`Everything else, in the automatic order. New products land here.${unlisted > 0 ? ` Showing the first ${rest.length} of them.` : ""}`}
            active={target?.zone === "rest"}
            {...zoneProps("rest")}
          >
            {rest.length ? (
              <TileGrid label="Products in the automatic order">
                {rest.map((product) => (
                  <Tile
                    key={product.id}
                    product={product}
                    dragging={dragId === product.id}
                    drag={dragProps(product)}
                    actions={
                      write ? (
                        <>
                          <TileAction label="Pin" icon={Pin} onClick={() => place(product.id, { zone: "pinned" })} />
                          <TileAction label="Hide from this category" icon={EyeOff} onClick={() => place(product.id, { zone: "hidden" })} />
                        </>
                      ) : null
                    }
                  />
                ))}
              </TileGrid>
            ) : (
              <DropHint>{write ? "Every product is pinned or hidden. Drag one here to give it back to the automatic order." : "Every product is pinned or hidden."}</DropHint>
            )}
          </ZoneCard>

          <ZoneCard
            title="Hidden"
            count={hidden.length}
            description="In the category, but left out of its page in every sort. Its parent's and subcategories' pages are merchandised on their own."
            active={target?.zone === "hidden"}
            {...zoneProps("hidden")}
          >
            {hidden.length ? (
              <TileGrid label="Hidden products">
                {hidden.map((product) => (
                  <Tile
                    key={product.id}
                    product={product}
                    muted
                    dragging={dragId === product.id}
                    drag={dragProps(product)}
                    actions={write ? <TileAction label="Show again" icon={Eye} onClick={() => place(product.id, { zone: "rest" })} /> : null}
                  />
                ))}
              </TileGrid>
            ) : (
              <DropHint>{write ? "Drag a product here to leave it out of this category's page." : "Nothing hidden."}</DropHint>
            )}
          </ZoneCard>
        </div>
      )}

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={submit}
          onDiscard={() => setArrangement(initial)}
          status={`${arrangement.pinned.length} pinned · ${arrangement.hidden.length} hidden · unsaved`}
        />
      ) : null}
      {unsaved.dialog}
    </Page>
  );
};

const ZoneCard = ({
  title,
  count,
  description,
  active,
  children,
  ...drop
}: { title: string; count: number; description: ReactNode; active: boolean; children: ReactNode } & Pick<ComponentProps<"div">, "onDragOver" | "onDragLeave" | "onDrop">) => (
  <Card className={cn("transition-shadow", active && "ring-2 ring-primary/50")} {...drop}>
    <CardHeader>
      <div className="min-w-0">
        <CardTitle className="flex items-center gap-2">
          {title}
          <Badge variant="secondary" className="tabular">
            {count}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const TileGrid = ({ label, children }: { label?: string; children: ReactNode }) => (
  <ul aria-label={label} className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
    {children}
  </ul>
);

const DropHint = ({ children }: { children: ReactNode }) => <p className="flex min-h-24 items-center justify-center rounded-lg border border-dashed px-4 text-center text-[13px] text-muted-foreground">{children}</p>;

const TileAction = ({ label, icon: Icon, onClick, disabled }: { label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean }) => (
  <Button variant="ghost" size="icon-sm" className="size-7" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <Icon />
  </Button>
);

const Tile = ({
  product,
  position,
  muted,
  dragging,
  drop,
  drag,
  onDragOver,
  actions,
}: {
  product: Product;
  /** Its place among the pinned products, from 0. */
  position?: number;
  muted?: boolean;
  dragging?: boolean;
  /** Where a dragged product would land relative to this one. */
  drop?: "before" | "after" | null;
  drag: { onDragStart: (e: DragEvent) => void; onDragEnd: () => void } | null;
  onDragOver?: (e: DragEvent<HTMLLIElement>) => void;
  actions: ReactNode;
}) => {
  const url = product.media?.[0]?.url;
  const stock = stockOf(product);
  return (
    <li
      data-tile
      draggable={!!drag}
      {...drag}
      onDragOver={onDragOver}
      className={cn("relative flex min-w-0 flex-col rounded-lg border bg-card shadow-xs transition-opacity", drag && "cursor-grab active:cursor-grabbing", muted && "opacity-60", dragging && "opacity-30")}
    >
      {drop === "before" ? <span aria-hidden className="absolute inset-y-2 -left-2.5 w-1 rounded-full bg-primary" /> : null}
      {drop === "after" ? <span aria-hidden className="absolute inset-y-2 -right-2.5 w-1 rounded-full bg-primary" /> : null}
      <div className="relative aspect-[4/5] overflow-hidden rounded-t-lg bg-muted">
        {url ? (
          <img src={url} alt="" draggable={false} loading="lazy" className="size-full object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
        ) : (
          <span className="flex size-full items-center justify-center">
            <ImageOff className="size-5 text-muted-foreground" />
          </span>
        )}
        {position !== undefined ? (
          <span className="absolute top-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular">{position + 1}</span>
        ) : null}
        <span className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
          {product.status === "DRAFT" ? <Badge className="border-border bg-background/90 text-foreground">Draft</Badge> : null}
          {stock !== null && stock <= 0 ? <Badge className="border-transparent bg-destructive text-white">Out of stock</Badge> : null}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
        <Link to="/products/$id" params={{ id: product.id }} draggable={false} className="line-clamp-2 text-[13px] leading-snug font-medium hover:underline">
          {product.name || "(untitled)"}
        </Link>
        <span className="text-xs text-muted-foreground tabular">{priceLabel(product)}</span>
      </div>
      {actions ? <div className="flex items-center justify-end gap-0.5 border-t p-1">{actions}</div> : null}
    </li>
  );
};
