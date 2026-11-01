import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Ban, ChevronDown, CreditCard, Plus, Printer, Radio, Truck, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BulkActionDialog } from "@/components/bulk-action";
import { DataTable, FilterSelect, fetchAllPages, type Column } from "@/components/data-table";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/overlay";
import { graphql, type ResultOf, type VariablesOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatMoney, relativeTime, startOfDay } from "@/lib/format";
import { useCursorPages, useListSearch, useReference } from "@/lib/hooks";
import { useSubscription } from "@/lib/live";
import { orderBlocker, ORDERS_PAGE_SIZE, rememberOrderList, type OrderAction } from "./shared";

export const OrdersQuery = graphql(`
  query Orders($first: Int!, $after: String, $filter: OrderFilter) {
    orders(first: $first, after: $after, filter: $filter) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          number
          placedAt
          email
          status
          paymentStatus
          fulfillmentStatus
          currencyCode
          canCancel
          channel {
            code
            name
          }
          customer {
            id
            firstName
            lastName
          }
          lines {
            quantity
            quantityFulfilled
            quantityCanceled
            quantityRefunded
          }
          totals {
            total {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`);

type Order = NonNullable<NonNullable<NonNullable<ResultOf<typeof OrdersQuery>["orders"]>["edges"]>[number]>["node"] & {};

const OrderActivity = graphql(`
  subscription OrderActivity {
    orderActivity {
      eventType
      order {
        number
      }
    }
  }
`);

const Capture = graphql(`
  mutation BulkCapture($orderId: ID!) {
    orderCapturePayment(orderId: $orderId) {
      __typename
      ... on Error {
        message
      }
    }
  }
`);
const Fulfill = graphql(`
  mutation BulkFulfill($orderId: ID!) {
    orderFulfill(orderId: $orderId) {
      __typename
      ... on Error {
        message
      }
    }
  }
`);
const Cancel = graphql(`
  mutation BulkCancel($orderId: ID!) {
    orderCancel(orderId: $orderId) {
      __typename
      ... on Error {
        message
      }
    }
  }
`);

const RANGES: Record<string, () => { placedAfter?: string; placedBefore?: string }> = {
  today: () => ({ placedAfter: startOfDay(0).toISOString() }),
  "7d": () => ({ placedAfter: startOfDay(6).toISOString() }),
  "30d": () => ({ placedAfter: startOfDay(29).toISOString() }),
  "90d": () => ({ placedAfter: startOfDay(89).toISOString() }),
};

const ORDER_STATUSES = ["OPEN", "COMPLETED", "CANCELED"] as const;
const PAYMENT_STATUSES = ["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED"] as const;
const FULFILLMENT_STATUSES = ["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED"] as const;

/** A filter value from the URL, if the API knows it, so an outdated link doesn't fail the query. */
const known = <T extends string>(values: readonly T[], value: string | undefined) => (values as readonly string[]).includes(value ?? "") ? (value as T) : undefined;

const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

const BULK: Record<OrderAction, { button: string; icon: LucideIcon; title: string; description: string; verbs: [string, string]; destructive?: boolean; mutation: typeof Capture }> = {
  capture: { button: "Capture", icon: CreditCard, title: "Capture payment", description: "Captures the outstanding amount of each order and creates its invoice.", verbs: ["Capturing", "Captured"], mutation: Capture },
  fulfill: { button: "Ship", icon: Truck, title: "Ship everything", description: "Ships every unshipped item of each order from its channel's first stock location.", verbs: ["Shipping", "Shipped"], mutation: Fulfill as unknown as typeof Capture },
  cancel: {
    button: "Cancel",
    icon: Ban,
    title: "Cancel orders",
    description: "Voids each order's payment authorization and releases its reserved stock. This cannot be undone.",
    verbs: ["Canceling", "Canceled"],
    destructive: true,
    mutation: Cancel as unknown as typeof Capture,
  },
};

const PrintMenu = ({ numbers }: { numbers: string[] }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button size="sm" variant="outline">
        <Printer />
        Print
        <ChevronDown />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      {[
        { doc: "packing", label: "Packing slips" },
        { doc: "invoice", label: "Invoices" },
        { doc: "both", label: "Both" },
      ].map((option) => (
        <DropdownMenuItem key={option.doc} asChild>
          <Link to="/orders/print" search={{ numbers: numbers.join(","), doc: option.doc }}>
            {option.label}
          </Link>
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const OrdersPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const { channels } = useReference();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const [live, setLive] = useState(false);
  const [bulk, setBulk] = useState<{ kind: OrderAction; orders: Order[]; clear: () => void; keep: (keys: string[]) => void } | null>(null);
  const write = can("orders:write");

  const filter: VariablesOf<typeof OrdersQuery>["filter"] = {
    query: search.q,
    status: known(ORDER_STATUSES, search.status),
    paymentStatus: known(PAYMENT_STATUSES, search.payment),
    fulfillmentStatus: known(FULFILLMENT_STATUSES, search.fulfillment),
    channelId: search.channel,
    ...(search.from ? RANGES[search.from]?.() : {}),
  };
  const query = useQuery({
    queryKey: ["orders", filter, pages.after],
    queryFn: ({ signal }) => request(OrdersQuery, { first: ORDERS_PAGE_SIZE, after: pages.after, filter }, { signal }),
    placeholderData: (previous) => previous,
  });

  // The order page steps through this result ("3 of 25"); placeholder rows belong to the old one.
  const searchKey = JSON.stringify(search);
  useEffect(() => {
    const orders = query.data?.orders;
    if (orders && !query.isPlaceholderData) rememberOrderList({ search, filter, after: pages.after, page: pages.page, orders });
  }, [query.data, query.isPlaceholderData, searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useSubscription(
    OrderActivity,
    (data) => {
      setLive(true);
      if (data.orderActivity?.eventType === "order.placed") toast.info(`New order ${data.orderActivity.order?.number ?? ""}`);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    can("orders:read"),
  );

  const rows = (query.data?.orders?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

  const columns: Column<Order>[] = [
    {
      id: "number",
      header: "Order",
      fixed: true,
      cell: (o) => (
        <Link to="/orders/$number" params={{ number: o.number! }} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
          {o.number}
        </Link>
      ),
      csv: (o) => o.number,
    },
    {
      id: "placedAt",
      header: "Date",
      cell: (o) => (
        <Tooltip content={formatDateTime(o.placedAt)}>
          <span className="text-muted-foreground">{relativeTime(o.placedAt)}</span>
        </Tooltip>
      ),
      csv: (o) => o.placedAt,
    },
    {
      id: "customer",
      header: "Customer",
      cell: (o) => (
        <div className="flex flex-col">
          <span>{o.customer ? `${o.customer.firstName} ${o.customer.lastName}` : "Guest"}</span>
          <span className="text-xs text-muted-foreground">{o.email}</span>
        </div>
      ),
      csv: (o) => o.email,
    },
    { id: "channel", header: "Channel", cell: (o) => <span className="text-muted-foreground">{o.channel?.name}</span>, csv: (o) => o.channel?.code },
    { id: "status", header: "Status", cell: (o) => <StatusBadge value={o.status} />, csv: (o) => o.status },
    { id: "payment", header: "Payment", cell: (o) => <StatusBadge value={o.paymentStatus} />, csv: (o) => o.paymentStatus },
    { id: "fulfillment", header: "Fulfillment", cell: (o) => <StatusBadge value={o.fulfillmentStatus} />, csv: (o) => o.fulfillmentStatus },
    { id: "items", header: "Items", align: "right", cell: (o) => o.lines?.reduce((n, l) => n + (l.quantity ?? 0), 0), csv: (o) => o.lines?.reduce((n, l) => n + (l.quantity ?? 0), 0), hidden: true },
    { id: "total", header: "Total", align: "right", cell: (o) => <span className="font-medium">{formatMoney(o.totals?.total)}</span>, csv: (o) => o.totals?.total?.amount },
    { id: "currency", header: "Currency", cell: (o) => o.currencyCode, csv: (o) => o.currencyCode, hidden: true },
  ];

  const bulkEligible = bulk ? bulk.orders.filter((o) => !orderBlocker(bulk.kind, o)).length : 0;
  const orderLink = (o: Order) => (
    <Link to="/orders/$number" params={{ number: o.number! }} className="text-primary hover:underline">
      Order {o.number}
    </Link>
  );

  return (
    <Page wide>
      <PageHeader
        title="Orders"
        description="Every order across channels. Filters and saved views are kept in the address bar."
        badges={
          live ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Radio className="size-3.5" /> Live
            </span>
          ) : null
        }
        actions={
          write ? (
            <Button asChild>
              <Link to="/orders/new">
                <Plus />
                Create order
              </Link>
            </Button>
          ) : null
        }
      />
      <DataTable
        id="orders"
        rows={rows}
        columns={columns}
        rowKey={(o) => o.id}
        loading={query.isLoading}
        error={query.error}
        onRowClick={(o) => void navigate({ to: "/orders/$number", params: { number: o.number! } })}
        searchPlaceholder="Order number or email"
        // Anyone who can see orders can print them; changing them needs orders:write.
        selectable
        total={query.data?.orders?.totalCount}
        pageInfo={query.data?.orders?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="orders"
        fetchAll={() =>
          fetchAllPages(async (after) => {
            const data = await request(OrdersQuery, { first: 100, after, filter });
            return { nodes: (data.orders?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])), endCursor: data.orders?.pageInfo.endCursor ?? null, hasNextPage: !!data.orders?.pageInfo.hasNextPage };
          })
        }
        filters={
          <>
            <FilterSelect param="status" label="Status" options={ORDER_STATUSES.map((v) => ({ value: v, label: humanize(v) }))} />
            <FilterSelect
              param="payment"
              label="Payment"
              options={PAYMENT_STATUSES.map((v) => ({ value: v, label: humanize(v) }))}
            />
            <FilterSelect param="fulfillment" label="Fulfillment" options={FULFILLMENT_STATUSES.map((v) => ({ value: v, label: humanize(v) }))} />
            <FilterSelect param="channel" label="Channel" options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} />
            <FilterSelect param="from" label="Placed" options={[{ value: "today", label: "Today" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "90d", label: "Last 90 days" }]} />
          </>
        }
        bulkActions={(selected, clear, keep) => (
          <>
            <PrintMenu numbers={selected.map((o) => o.number!)} />
            {write
              ? (["capture", "fulfill", "cancel"] as const).map((kind) => {
                  const eligible = selected.filter((o) => !orderBlocker(kind, o)).length;
                  const { icon: Icon, button, destructive } = BULK[kind];
                  return (
                    <Button key={kind} size="sm" variant="outline" className={destructive ? "text-destructive" : undefined} disabled={!eligible} onClick={() => setBulk({ kind, orders: selected, clear, keep })}>
                      <Icon />
                      {button} {eligible}
                    </Button>
                  );
                })
              : null}
          </>
        )}
      />
      {bulk ? (
        <BulkActionDialog
          items={bulk.orders}
          title={BULK[bulk.kind].title}
          description={BULK[bulk.kind].description}
          noun={["order", "orders"]}
          verbs={BULK[bulk.kind].verbs}
          confirmLabel={`${BULK[bulk.kind].button} ${bulkEligible} ${bulkEligible === 1 ? "order" : "orders"}`}
          destructive={BULK[bulk.kind].destructive}
          itemKey={(o) => o.id}
          itemLabel={orderLink}
          skipReason={(o) => orderBlocker(bulk.kind, o)}
          run={async (o) => {
            const result = await request(BULK[bulk.kind].mutation, { orderId: o.id });
            unwrap(Object.values(result)[0] as { __typename: string });
          }}
          onClose={() => setBulk(null)}
          onFinished={(outcome) => {
            void queryClient.invalidateQueries({ queryKey: ["orders"] });
            void queryClient.invalidateQueries({ queryKey: ["order"] });
            // Only the failed or unprocessed orders stay selected, ready for another try.
            if (!outcome.failed.length && !outcome.stopped) return bulk.clear();
            const settled = new Set([...outcome.done, ...outcome.skipped].map((o) => o.id));
            bulk.keep(bulk.orders.filter((o) => !settled.has(o.id)).map((o) => o.id));
          }}
        />
      ) : null}
    </Page>
  );
};
