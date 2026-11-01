import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, TicketPercent } from "lucide-react";
import { DataTable, FilterSelect, fetchAllPages, type Column } from "@/components/data-table";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatNumber } from "@/lib/format";
import { useCursorPages, useListSearch } from "@/lib/hooks";
import { summarizeStoredAction } from "./promotion-rules";

export const PromotionsQuery = graphql(`
  query Promotions($first: Int!, $after: String, $query: String, $isActive: Boolean) {
    promotions(first: $first, after: $after, query: $query, isActive: $isActive) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          description
          isActive
          requiresCoupon
          priority
          stopFurtherRules
          startsAt
          endsAt
          timesUsed
          usageLimit
          action
          createdAt
          channels {
            id
            name
          }
          customerGroups {
            id
            name
          }
        }
      }
    }
  }
`);

type Promotion = NonNullable<NonNullable<NonNullable<ResultOf<typeof PromotionsQuery>["promotions"]>["edges"]>[number]>["node"] & {};

export type PromotionState = "active" | "scheduled" | "expired" | "inactive" | "used_up";

export const promotionState = (p: { isActive?: boolean | null; startsAt?: string | null; endsAt?: string | null; timesUsed?: number | null; usageLimit?: number | null }, now = Date.now()): PromotionState => {
  if (!p.isActive) return "inactive";
  if (p.endsAt && Date.parse(p.endsAt) <= now) return "expired";
  if (p.usageLimit && (p.timesUsed ?? 0) >= p.usageLimit) return "used_up";
  if (p.startsAt && Date.parse(p.startsAt) > now) return "scheduled";
  return "active";
};

const STATE_BADGE: Record<PromotionState, { label: string; variant: BadgeVariant }> = {
  active: { label: "Active", variant: "success" },
  scheduled: { label: "Scheduled", variant: "info" },
  expired: { label: "Expired", variant: "secondary" },
  inactive: { label: "Inactive", variant: "secondary" },
  used_up: { label: "Limit reached", variant: "warning" },
};

export const PromotionStateBadge = ({ promotion }: { promotion: Parameters<typeof promotionState>[0] }) => {
  const state = STATE_BADGE[promotionState(promotion)];
  return (
    <Badge variant={state.variant} dot>
      {state.label}
    </Badge>
  );
};

const schedule = (p: Promotion) => {
  if (!p.startsAt && !p.endsAt) return "Always";
  if (p.startsAt && p.endsAt) return `${formatDate(p.startsAt)} – ${formatDate(p.endsAt)}`;
  return p.startsAt ? `From ${formatDate(p.startsAt)}` : `Until ${formatDate(p.endsAt)}`;
};

const names = (list: readonly { name?: string | null }[] | null | undefined, all: string) => (list?.length ? list.map((x) => x.name).join(", ") : all);

export const PromotionsPage = () => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search] = useListSearch();
  const pages = useCursorPages();
  // Name contains the text, or a coupon code matches it exactly.
  const filter = { query: search.q ?? null, isActive: search.status === "enabled" ? true : search.status === "disabled" ? false : null };
  const query = useQuery({
    queryKey: ["promotions", filter, pages.after],
    queryFn: ({ signal }) => request(PromotionsQuery, { first: 50, after: pages.after, ...filter }, { signal }),
    placeholderData: (previous) => previous,
  });
  const rows = (query.data?.promotions?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

  const columns: Column<Promotion>[] = [
    {
      id: "name",
      header: "Promotion",
      fixed: true,
      cell: (p) => (
        <div className="min-w-0 max-w-md">
          <Link to="/promotions/$id" params={{ id: p.id }} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
            {p.name}
          </Link>
          {p.description ? <p className="truncate text-xs text-muted-foreground">{p.description}</p> : null}
        </div>
      ),
      csv: (p) => p.name,
    },
    { id: "discount", header: "Discount", cell: (p) => summarizeStoredAction(p.action), csv: (p) => summarizeStoredAction(p.action) },
    { id: "status", header: "Status", cell: (p) => <PromotionStateBadge promotion={p} />, csv: (p) => promotionState(p) },
    {
      id: "coupon",
      header: "Applies",
      cell: (p) => (p.requiresCoupon ? <Badge variant="outline">With coupon</Badge> : <span className="text-muted-foreground">Automatically</span>),
      csv: (p) => (p.requiresCoupon ? "coupon" : "automatic"),
    },
    { id: "priority", header: "Priority", align: "right", cell: (p) => p.priority, csv: (p) => p.priority },
    { id: "schedule", header: "Schedule", cell: (p) => <span className="text-muted-foreground">{schedule(p)}</span>, csv: (p) => schedule(p) },
    {
      id: "usage",
      header: "Used",
      align: "right",
      cell: (p) => (p.usageLimit ? `${formatNumber(p.timesUsed ?? 0)} / ${formatNumber(p.usageLimit)}` : formatNumber(p.timesUsed ?? 0)),
      csv: (p) => p.timesUsed,
    },
    { id: "channels", header: "Channels", cell: (p) => <span className="text-muted-foreground">{names(p.channels, "All channels")}</span>, csv: (p) => names(p.channels, "all"), hidden: true },
    { id: "groups", header: "Customer groups", cell: (p) => <span className="text-muted-foreground">{names(p.customerGroups, "Everyone")}</span>, csv: (p) => names(p.customerGroups, "all"), hidden: true },
    { id: "stop", header: "Stops later rules", cell: (p) => (p.stopFurtherRules ? "Yes" : "No"), csv: (p) => (p.stopFurtherRules ? "yes" : "no"), hidden: true },
    { id: "created", header: "Created", cell: (p) => <span className="text-muted-foreground">{formatDate(p.createdAt)}</span>, csv: (p) => p.createdAt, hidden: true },
  ];

  return (
    <Page wide>
      <PageHeader
        title="Promotions"
        description="Cart rules: automatic discounts and coupon codes, evaluated in priority order at checkout."
        actions={
          can("promotions:write") ? (
            <Button asChild>
              <Link to="/promotions/new">
                <Plus />
                Add promotion
              </Link>
            </Button>
          ) : null
        }
      />
      <DataTable
        id="promotions"
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        loading={query.isLoading}
        error={query.error}
        onRowClick={(p) => void navigate({ to: "/promotions/$id", params: { id: p.id } })}
        searchPlaceholder="Name or exact coupon code"
        total={query.data?.promotions?.totalCount}
        pageInfo={query.data?.promotions?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="promotions"
        fetchAll={() =>
          fetchAllPages(async (after) => {
            const data = await request(PromotionsQuery, { first: 100, after, ...filter });
            return { nodes: (data.promotions?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])), endCursor: data.promotions?.pageInfo.endCursor ?? null, hasNextPage: !!data.promotions?.pageInfo.hasNextPage };
          })
        }
        filters={<FilterSelect param="status" label="Status" options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }]} />}
        empty={
          rows.length === 0 && !query.isLoading && !search.q && !search.status ? (
            <EmptyState
              icon={TicketPercent}
              title="No promotions yet"
              description="Create a discount that applies automatically, or one that needs a coupon code."
              action={
                can("promotions:write") ? (
                  <Button asChild>
                    <Link to="/promotions/new">Add promotion</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
      />
    </Page>
  );
};
