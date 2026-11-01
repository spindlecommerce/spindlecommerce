import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, UsersRound } from "lucide-react";
import { DataTable, FilterSelect, fetchAllPages, type Column } from "@/components/data-table";
import { Page, PageHeader } from "@/components/layout/page";
import { BooleanBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/overlay";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, formatNumber, relativeTime } from "@/lib/format";
import { useCursorPages, useListSearch, useReference } from "@/lib/hooks";

export const CustomersQuery = graphql(`
  query Customers($first: Int!, $after: String, $query: String, $groupId: ID, $withOrders: Boolean!) {
    customers(first: $first, after: $after, query: $query, groupId: $groupId) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          email
          firstName
          lastName
          phone
          isActive
          acceptsMarketing
          createdAt
          lastLoginAt
          emailVerifiedAt
          group {
            id
            name
          }
          orders(first: 1) @include(if: $withOrders) {
            totalCount
          }
        }
      }
    }
  }
`);

type Customer = NonNullable<NonNullable<NonNullable<ResultOf<typeof CustomersQuery>["customers"]>["edges"]>[number]>["node"] & {};

export const customerName = (c: { firstName?: string | null; lastName?: string | null; email?: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Customer";

export const CustomersPage = () => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { customerGroups } = useReference();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const variables = { query: search.q ?? null, groupId: search.group ?? null };

  const query = useQuery({
    queryKey: ["customers", variables, pages.after],
    queryFn: ({ signal }) => request(CustomersQuery, { first: 25, after: pages.after, withOrders: can("orders:read"), ...variables }, { signal }),
    placeholderData: (previous) => previous,
  });
  const rows = (query.data?.customers?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

  const columns: Column<Customer>[] = [
    {
      id: "name",
      header: "Customer",
      fixed: true,
      cell: (c) => (
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
            {customerName(c)
              .split(/\s+/)
              .map((p) => p[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <div className="min-w-0">
            <Link to="/customers/$id" params={{ id: c.id }} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
              {customerName(c)}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{c.email}</p>
          </div>
        </div>
      ),
      csv: (c) => customerName(c),
    },
    { id: "email", header: "Email", cell: (c) => c.email, csv: (c) => c.email, hidden: true },
    { id: "phone", header: "Phone", cell: (c) => c.phone ?? "—", csv: (c) => c.phone, hidden: true },
    { id: "group", header: "Group", cell: (c) => <Badge variant="secondary">{c.group?.name ?? "—"}</Badge>, csv: (c) => c.group?.name },
    { id: "status", header: "Status", cell: (c) => <BooleanBadge value={c.isActive} on="Active" off="Disabled" />, csv: (c) => (c.isActive ? "active" : "disabled") },
    {
      id: "marketing",
      header: "Marketing",
      cell: (c) => (c.acceptsMarketing ? <Badge variant="info">Subscribed</Badge> : <span className="text-muted-foreground">—</span>),
      csv: (c) => (c.acceptsMarketing ? "yes" : "no"),
    },
    ...(can("orders:read") ? [{ id: "orders", header: "Orders", align: "right" as const, cell: (c: Customer) => formatNumber(c.orders?.totalCount ?? 0) }] : []),
    {
      id: "createdAt",
      header: "Customer since",
      cell: (c) => <span className="text-muted-foreground">{formatDate(c.createdAt)}</span>,
      csv: (c) => c.createdAt,
    },
    {
      id: "lastLoginAt",
      header: "Last sign-in",
      hidden: true,
      cell: (c) =>
        c.lastLoginAt ? (
          <Tooltip content={formatDateTime(c.lastLoginAt)}>
            <span className="text-muted-foreground">{relativeTime(c.lastLoginAt)}</span>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">Never</span>
        ),
      csv: (c) => c.lastLoginAt,
    },
    {
      id: "verified",
      header: "Email verified",
      hidden: true,
      cell: (c) => (c.emailVerifiedAt ? formatDate(c.emailVerifiedAt) : <span className="text-muted-foreground">No</span>),
      csv: (c) => c.emailVerifiedAt,
    },
  ];

  return (
    <Page wide>
      <PageHeader
        title="Customers"
        description="Accounts that can sign in to the storefront. Guest checkouts appear on their orders only."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/customer-groups">
                <UsersRound />
                Groups
              </Link>
            </Button>
            {can("customers:write") ? (
              <Button asChild>
                <Link to="/customers/new">
                  <Plus />
                  Add customer
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <DataTable
        id="customers"
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        loading={query.isLoading}
        error={query.error}
        onRowClick={(c) => void navigate({ to: "/customers/$id", params: { id: c.id } })}
        searchPlaceholder="Name or email"
        total={query.data?.customers?.totalCount}
        pageInfo={query.data?.customers?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="customers"
        fetchAll={() =>
          fetchAllPages(async (after) => {
            const data = await request(CustomersQuery, { first: 100, after, withOrders: false, ...variables });
            return { nodes: (data.customers?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])), endCursor: data.customers?.pageInfo.endCursor ?? null, hasNextPage: !!data.customers?.pageInfo.hasNextPage };
          })
        }
        filters={<FilterSelect param="group" label="Group" options={customerGroups.map((g) => ({ value: g.id, label: g.name ?? g.code ?? "" }))} />}
      />
    </Page>
  );
};
