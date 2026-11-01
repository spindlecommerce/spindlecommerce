import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShoppingCart } from "lucide-react";
import { useState } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { Page, PageHeader } from "@/components/layout/page";
import { Alert, EmptyState } from "@/components/ui/feedback";
import { Select } from "@/components/ui/menu";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { formatDateTime, formatMoney, relativeTime } from "@/lib/format";

const CartsQuery = graphql(`
  query AbandonedCarts($idleMinutes: Int!, $since: DateTime) {
    abandonedCartsReport(idleMinutes: $idleMinutes, since: $since, first: 200) {
      id
      email
      lines
      items
      updatedAt
      currencyCode
      subtotal {
        amount
        currencyCode
      }
      channel {
        name
      }
      customer {
        id
        firstName
        lastName
      }
    }
  }
`);

type Cart = NonNullable<ResultOf<typeof CartsQuery>["abandonedCartsReport"]>[number];

const IDLE = [
  { value: "60", label: "Idle 1 hour" },
  { value: "240", label: "Idle 4 hours" },
  { value: "1440", label: "Idle 1 day" },
  { value: "4320", label: "Idle 3 days" },
];

export const AbandonedCartsPage = () => {
  const [idle, setIdle] = useState("60");
  const query = useQuery({
    queryKey: ["abandoned-carts", idle],
    queryFn: () => request(CartsQuery, { idleMinutes: Number(idle), since: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
  });
  const rows = query.data?.abandonedCartsReport ?? [];
  const columns: Column<Cart>[] = [
    {
      id: "customer",
      header: "Shopper",
      fixed: true,
      cell: (c) =>
        c.customer ? (
          <Link to="/customers/$id" params={{ id: c.customer.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
            {c.customer.firstName} {c.customer.lastName}
          </Link>
        ) : (
          <span className="text-muted-foreground">Guest</span>
        ),
      csv: (c) => (c.customer ? `${c.customer.firstName} ${c.customer.lastName}` : "Guest"),
    },
    { id: "email", header: "Email", cell: (c) => c.email ?? <span className="text-muted-foreground">Unknown</span>, csv: (c) => c.email },
    { id: "channel", header: "Channel", cell: (c) => c.channel?.name, csv: (c) => c.channel?.name },
    { id: "items", header: "Items", align: "right", cell: (c) => c.items, csv: (c) => c.items },
    { id: "subtotal", header: "Subtotal", align: "right", cell: (c) => <span className="font-medium">{formatMoney(c.subtotal)}</span>, csv: (c) => c.subtotal?.amount },
    { id: "updated", header: "Last activity", cell: (c) => <span title={formatDateTime(c.updatedAt)}>{relativeTime(c.updatedAt)}</span>, csv: (c) => c.updatedAt },
  ];
  return (
    <Page>
      <PageHeader title="Abandoned carts" description="Carts with items that have stopped changing in the last 30 days, valued at current prices." actions={<Select value={idle} onValueChange={setIdle} options={IDLE} className="w-36" aria-label="Idle time" />} />
      <Alert variant="info" className="mb-4">
        Recovery emails are not built in: export this list, or let your email tool read it through the admin API (<code className="font-mono">abandonedCartsReport</code>) with an API key that has reports:read.
      </Alert>
      <DataTable id="abandoned-carts" rows={rows} columns={columns} rowKey={(c) => c.id ?? ""} loading={query.isLoading} error={query.error} searchable={false} exportName="abandoned-carts" empty={<EmptyState icon={ShoppingCart} title="No abandoned carts" description="Nothing has been left in a cart for that long." />} />
    </Page>
  );
};
