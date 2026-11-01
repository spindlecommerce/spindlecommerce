import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DataTable, FilterSelect, fetchAllPages, type Column } from "@/components/data-table";
import { JsonView } from "@/components/inputs";
import { Page, PageHeader } from "@/components/layout/page";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Detail, EmptyState } from "@/components/ui/feedback";
import { Sheet, SheetContent, Tooltip } from "@/components/ui/overlay";
import { graphql, type ResultOf, type VariablesOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime, startOfDay } from "@/lib/format";
import { useCursorPages, useListSearch } from "@/lib/hooks";
import { humanize } from "@/lib/utils";
import { ParamFilter } from "../settings/shared";

const AuditLogQuery = graphql(`
  query AuditLog($first: Int!, $after: String, $filter: AuditLogFilter) {
    auditLog(first: $first, after: $after, filter: $filter) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          createdAt
          actorType
          actorLabel
          staffUser {
            id
            name
          }
          apiKey {
            id
            name
          }
          operation
          operationName
          targetType
          targetId
          outcome
          errorCode
          input
          ip
          userAgent
        }
      }
    }
  }
`);

const StaffOptionsQuery = graphql(`
  query AuditStaff {
    staffUsers {
      id
      name
    }
  }
`);

const OrderNumbersQuery = graphql(`
  query AuditOrderNumbers($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        number
      }
    }
  }
`);

type Entry = NonNullable<NonNullable<NonNullable<ResultOf<typeof AuditLogQuery>["auditLog"]>["edges"]>[number]>["node"] & {};

const SINCE: Record<string, () => string> = {
  today: () => startOfDay(0).toISOString(),
  "7d": () => startOfDay(6).toISOString(),
  "30d": () => startOfDay(29).toISOString(),
  "90d": () => startOfDay(89).toISOString(),
};

const actorName = (e: Entry) => e.staffUser?.name ?? e.apiKey?.name ?? e.actorLabel ?? "Unknown";

/** A link to the affected object when the admin has a screen for it. */
const Target = ({ entry, orderNumbers }: { entry: Entry; orderNumbers: Map<string, string> }): ReactNode => {
  const id = entry.targetId;
  if (!entry.targetType || !id) return <span className="text-muted-foreground">—</span>;
  const label = humanize(entry.targetType.replace(/([a-z])([A-Z])/g, "$1 $2"));
  if (entry.targetType === "Order" && orderNumbers.get(id)) {
    return (
      <Link to="/orders/$number" params={{ number: orderNumbers.get(id)! }} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
        Order {orderNumbers.get(id)}
      </Link>
    );
  }
  if (entry.targetType === "Product")
    return (
      <Link to="/products/$id" params={{ id }} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
        {label}
      </Link>
    );
  if (entry.targetType === "Customer")
    return (
      <Link to="/customers/$id" params={{ id }} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
        {label}
      </Link>
    );
  if (entry.targetType === "Promotion")
    return (
      <Link to="/promotions/$id" params={{ id }} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
        {label}
      </Link>
    );
  return <span>{label}</span>;
};

export const AuditLogPage = () => {
  const { can } = useAuth();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const [open, setOpen] = useState<Entry | null>(null);
  const actor = (search as Record<string, string | undefined>).actor;
  const filter: VariablesOf<typeof AuditLogQuery>["filter"] = {
    search: search.q?.trim() || null,
    outcome: (search.outcome as "SUCCESS" | "ERROR" | undefined) ?? null,
    actorId: actor ?? null,
    since: search.from ? (SINCE[search.from]?.() ?? null) : null,
  };
  const query = useQuery({
    queryKey: ["audit-log", filter, pages.after],
    queryFn: ({ signal }) => request(AuditLogQuery, { first: 50, after: pages.after, filter }, { signal }),
    placeholderData: (previous) => previous,
  });
  const staff = useQuery({ queryKey: ["audit-staff"], queryFn: () => request(StaffOptionsQuery), staleTime: 5 * 60_000 });
  const rows = (query.data?.auditLog?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
  const orderIds = [...new Set(rows.filter((r) => r.targetType === "Order" && r.targetId).map((r) => r.targetId!))];
  const orders = useQuery({
    queryKey: ["audit-order-numbers", orderIds],
    queryFn: () => request(OrderNumbersQuery, { ids: orderIds }),
    enabled: orderIds.length > 0 && can("orders:read"),
    staleTime: Infinity,
  });
  const orderNumbers = new Map((orders.data?.nodes ?? []).flatMap((n) => (n && "number" in n && n.id && n.number ? [[n.id, n.number] as const] : [])));

  const columns: Column<Entry>[] = [
    {
      id: "time",
      header: "Time",
      cell: (e) => (
        <Tooltip content={formatDateTime(e.createdAt)}>
          <span className="whitespace-nowrap text-muted-foreground">{relativeTime(e.createdAt)}</span>
        </Tooltip>
      ),
      csv: (e) => e.createdAt,
    },
    {
      id: "actor",
      header: "Actor",
      cell: (e) => (
        <span className="flex items-center gap-1.5">
          {actorName(e)}
          {e.actorType === "API_KEY" ? <Badge variant="secondary">API key</Badge> : e.actorType === "ANONYMOUS" ? <Badge variant="outline">Not signed in</Badge> : null}
        </span>
      ),
      csv: (e) => actorName(e),
    },
    { id: "operation", header: "Operation", fixed: true, cell: (e) => <span className="font-mono text-[13px]">{e.operation}</span>, csv: (e) => e.operation },
    { id: "target", header: "Target", cell: (e) => <Target entry={e} orderNumbers={orderNumbers} />, csv: (e) => (e.targetType ? `${e.targetType} ${e.targetId}` : "") },
    {
      id: "outcome",
      header: "Outcome",
      cell: (e) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge value={e.outcome} />
          {e.errorCode ? <span className="font-mono text-xs text-muted-foreground">{e.errorCode}</span> : null}
        </span>
      ),
      csv: (e) => e.errorCode ?? e.outcome,
    },
    { id: "ip", header: "IP", cell: (e) => <span className="font-mono text-xs text-muted-foreground">{e.ip ?? "—"}</span>, csv: (e) => e.ip },
    { id: "client", header: "Client operation", cell: (e) => <span className="text-xs text-muted-foreground">{e.operationName ?? "—"}</span>, csv: (e) => e.operationName, hidden: true },
  ];

  return (
    <Page wide>
      <PageHeader title="Audit log" description="Every admin mutation and sign-in attempt, newest first. Secrets in the recorded input are redacted." />
      <DataTable
        id="audit-log"
        rows={rows}
        columns={columns}
        rowKey={(e) => e.id ?? `${e.createdAt}${e.operation}`}
        loading={query.isLoading}
        error={query.error}
        onRowClick={setOpen}
        searchPlaceholder="Operation, email or key name"
        total={query.data?.auditLog?.totalCount}
        pageInfo={query.data?.auditLog?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="audit-log"
        fetchAll={() =>
          fetchAllPages(async (after) => {
            const data = await request(AuditLogQuery, { first: 100, after, filter });
            return { nodes: (data.auditLog?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])), endCursor: data.auditLog?.pageInfo.endCursor ?? null, hasNextPage: !!data.auditLog?.pageInfo.hasNextPage };
          })
        }
        filters={
          <>
            <FilterSelect param="outcome" label="Outcome" options={[{ value: "SUCCESS", label: "Succeeded" }, { value: "ERROR", label: "Failed" }]} />
            <ParamFilter param="actor" label="Staff" options={(staff.data?.staffUsers ?? []).map((s) => ({ value: s.id, label: s.name ?? s.id }))} />
            <FilterSelect param="from" label="When" options={[{ value: "today", label: "Today" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "90d", label: "Last 90 days" }]} />
          </>
        }
        empty={<EmptyState icon={ScrollText} title="No activity found" description={search.q ? "Search matches part of an operation name, such as refund, or of the actor's email or API key name." : undefined} />}
      />
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent aria-describedby={undefined}>
          {open ? (
            <div className="flex flex-col gap-5">
              <div>
                <h2 className="font-mono text-base font-semibold">{open.operation}</h2>
                <p className="text-[13px] text-muted-foreground">{formatDateTime(open.createdAt)}</p>
              </div>
              <dl>
                <Detail label="Actor">
                  {actorName(open)} <span className="text-muted-foreground">({humanize(open.actorType)})</span>
                </Detail>
                <Detail label="Outcome">
                  <span className="flex items-center gap-1.5">
                    <StatusBadge value={open.outcome} />
                    {open.errorCode ? <span className="font-mono text-xs">{open.errorCode}</span> : null}
                  </span>
                </Detail>
                <Detail label="Target">
                  <Target entry={open} orderNumbers={orderNumbers} />
                </Detail>
                {open.targetId ? (
                  <Detail label="Target id">
                    <span className="font-mono text-xs break-all">{open.targetId}</span>
                  </Detail>
                ) : null}
                <Detail label="Client operation">{open.operationName ?? "—"}</Detail>
                <Detail label="IP address">{open.ip ?? "—"}</Detail>
                <Detail label="User agent">
                  <span className="text-xs break-all text-muted-foreground">{open.userAgent ?? "—"}</span>
                </Detail>
              </dl>
              <div>
                <p className="mb-2 text-sm font-semibold">Input</p>
                <JsonView value={open.input ?? {}} />
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </Page>
  );
};
