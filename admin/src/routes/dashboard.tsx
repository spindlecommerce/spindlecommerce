import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, Clock, PackageCheck, Radio, Receipt, Webhook } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Page, PageHeader } from "@/components/layout/page";
import { PluginWidgets } from "@/components/plugin-widgets";
import { StatusBadge } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { graphql } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatAmount, formatDate, formatMoney, formatNumber, formatPercent, relativeTime, startOfDay, timeZone } from "@/lib/format";
import { useAdminCurrency, useReference } from "@/lib/hooks";
import { useSubscription } from "@/lib/live";
import { cn, humanize } from "@/lib/utils";

const FIGURES = `currencyCode orders itemsSold gross { amount } net { amount } refunded { amount } averageOrderValue { amount } discounts { amount }`;

const DashboardQuery = graphql(`
  query Dashboard($range: DateRangeInput!, $channelId: ID, $timeZone: String) {
    dashboard(range: $range, channelId: $channelId, timeZone: $timeZone) {
      totals { ${FIGURES} }
      previousTotals { ${FIGURES} }
      series {
        period
        currencyCode
        orders
        gross {
          amount
        }
      }
      newCustomers
      previousNewCustomers
      topProducts(first: 6) {
        sku
        name
        quantity
        currencyCode
        revenue {
          amount
          currencyCode
        }
        product {
          id
          media {
            url
          }
        }
      }
      attention {
        awaitingFulfillment
        awaitingPayment
        failedWebhookDeliveries
        lowStockVariants
      }
    }
  }
`);

const RecentOrdersQuery = graphql(`
  query RecentOrders {
    orders(first: 6) {
      edges {
        node {
          id
          number
          placedAt
          email
          paymentStatus
          fulfillmentStatus
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

const LiveActivity = graphql(`
  subscription DashboardActivity {
    orderActivity {
      eventType
      occurredAt
      order {
        number
        email
        totals {
          total {
            amount
            currencyCode
          }
        }
      }
    }
  }
`);

const RANGES = [
  { value: "0", label: "Today" },
  { value: "6", label: "Last 7 days" },
  { value: "29", label: "Last 30 days" },
  { value: "89", label: "Last 90 days" },
  { value: "364", label: "Last 12 months" },
];

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

const change = (current: number, previous: number) => (previous === 0 ? (current === 0 ? 0 : null) : (current - previous) / previous);

const Delta = ({ value }: { value: number | null }) =>
  value === null ? (
    <span className="text-xs text-muted-foreground">new</span>
  ) : (
    <span className={cn("inline-flex items-center text-xs font-medium", value >= 0 ? "text-success" : "text-destructive")}>
      {value >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {formatPercent(Math.abs(value))}
    </span>
  );

const Kpi = ({ label, value, delta, hint }: { label: string; value: ReactNode; delta: number | null; hint?: string }) => (
  <Card>
    <CardContent className="pt-5">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="tabular mt-1.5 text-2xl font-semibold tracking-tight">{value}</p>
      <div className="mt-1 flex items-center gap-1.5">
        <Delta value={delta} />
        <span className="text-xs text-muted-foreground">{hint ?? "vs previous period"}</span>
      </div>
    </CardContent>
  </Card>
);

type Event = { type: string; at: string; number: string; email: string; total: string };

export const DashboardPage = () => {
  const { viewer, can } = useAuth();
  const queryClient = useQueryClient();
  const { channels, defaultChannelId } = useReference();
  const [days, setDays] = useState("29");
  const [channelId, setChannelId] = useState("");
  const admin = useAdminCurrency();
  const [events, setEvents] = useState<Event[]>([]);

  const range = useMemo(() => ({ from: startOfDay(Number(days)).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }), [days]);
  const dashboard = useQuery({
    queryKey: ["dashboard", range.from, channelId],
    queryFn: () => request(DashboardQuery, { range, channelId: channelId || null, timeZone: timeZone() }),
    enabled: can("reports:read"),
    refetchInterval: 60_000,
  });
  const recent = useQuery({ queryKey: ["orders", "recent"], queryFn: () => request(RecentOrdersQuery), enabled: can("orders:read") });

  useSubscription(
    LiveActivity,
    (data) => {
      const update = data.orderActivity;
      if (!update?.order) return;
      setEvents((list) => [{ type: update.eventType ?? "", at: update.occurredAt ?? new Date().toISOString(), number: update.order!.number ?? "", email: update.order!.email ?? "", total: formatMoney(update.order!.totals?.total) }, ...list].slice(0, 8));
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
    can("orders:read"),
  );

  const data = dashboard.data?.dashboard;
  const loading = dashboard.isLoading || admin.loading;
  // Every currency the view sells in or has orders in, busiest first. Shows the top bar's currency
  // once the admin picks one, else the busiest.
  const home = channels.find((c) => c.id === defaultChannelId)?.defaultCurrency ?? channels[0]?.defaultCurrency ?? "USD";
  const busiest = [...(data?.totals ?? [])]
    .sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0) || Number(b.currencyCode === home) - Number(a.currencyCode === home))
    .map((t) => t.currencyCode ?? "");
  const sold = (channelId ? channels.filter((c) => c.id === channelId) : channels).flatMap((c) => c.currencies ?? []).sort((a, b) => Number(b === home) - Number(a === home));
  const currencies = [...new Set([...busiest, ...sold])];
  const currency = admin.picked && currencies.includes(admin.currency) ? admin.currency : (currencies[0] ?? home);
  const totals = data?.totals?.find((t) => t.currencyCode === currency);
  const previous = data?.previousTotals?.find((t) => t.currencyCode === currency);
  const num = (m: { amount?: string | null } | null | undefined) => Number(m?.amount ?? 0);
  const series = (data?.series ?? []).filter((s) => s.currencyCode === currency).map((s) => ({ period: s.period ?? "", revenue: num(s.gross), orders: s.orders ?? 0 }));
  const attention = data?.attention;

  if (!can("reports:read")) {
    return (
      <Page>
        <PageHeader title={`${greeting()}, ${viewer?.staffUser?.name?.split(" ")[0] ?? ""}`} description="Use the navigation or ⌘K to get to work." />
        <PluginWidgets zone="dashboard" />
      </Page>
    );
  }

  return (
    <Page wide>
      <PageHeader
        title={`${greeting()}, ${viewer?.staffUser?.name?.split(" ")[0] ?? ""}`}
        description="Live figures straight from orders; no statistics to refresh."
        actions={
          <>
            {currencies.length > 1 ? <Select value={currency} onValueChange={admin.chooseCurrency} options={currencies.map((c) => ({ value: c, label: c }))} className="w-24" aria-label="Currency" /> : null}
            <Select value={channelId} onValueChange={setChannelId} allowEmpty emptyLabel="All channels" placeholder="All channels" options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} className="w-44" aria-label="Channel" />
            <Select value={days} onValueChange={setDays} options={RANGES} className="w-40" aria-label="Period" />
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[118px] rounded-xl" />)
        ) : (
          <>
            <Kpi label="Revenue" value={formatAmount(num(totals?.gross), currency)} delta={change(num(totals?.gross), num(previous?.gross))} />
            <Kpi label="Orders" value={formatNumber(totals?.orders ?? 0)} delta={change(totals?.orders ?? 0, previous?.orders ?? 0)} />
            <Kpi label="Average order value" value={formatAmount(num(totals?.averageOrderValue), currency)} delta={change(num(totals?.averageOrderValue), num(previous?.averageOrderValue))} />
            <Kpi label="New customers" value={formatNumber(data?.newCustomers ?? 0)} delta={change(data?.newCustomers ?? 0, data?.previousNewCustomers ?? 0)} />
          </>
        )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Revenue</CardTitle>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {formatNumber(totals?.itemsSold ?? 0)} items sold · {formatAmount(num(totals?.refunded), currency)} refunded · net {formatAmount(num(totals?.net), currency)}
              </p>
            </div>
          </CardHeader>
          <CardContent className="h-72 pr-2 pl-0">
            {series.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ left: 8, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="revenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="period" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" tickFormatter={(p: string) => formatDate(p, { month: "short", day: "numeric" })} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" width={64} tickFormatter={(v: number) => formatAmount(v, currency, { notation: "compact", maximumFractionDigits: 1 })} />
                  <Tooltip
                    cursor={{ stroke: "var(--border)" }}
                    contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(p) => formatDate(String(p))}
                    formatter={(value, name) => [name === "revenue" ? formatAmount(Number(value), currency) : String(value), name === "revenue" ? "Revenue" : "Orders"]}
                  />
                  <Area type="monotone" dataKey="revenue" stroke="var(--chart-1)" strokeWidth={2} fill="url(#revenue)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : loading ? (
              <Skeleton className="mx-5 h-full" />
            ) : (
              <EmptyState title="No sales in this period" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <AttentionRow to="/orders" search={{ fulfillment: "UNFULFILLED", status: "OPEN" }} icon={PackageCheck} label="Orders to ship" value={attention?.awaitingFulfillment} />
            <AttentionRow to="/orders" search={{ payment: "PENDING", status: "OPEN" }} icon={Clock} label="Awaiting payment" value={attention?.awaitingPayment} />
            <AttentionRow to="/inventory" search={{ view: "low" }} icon={Boxes} label="Low-stock variants" value={attention?.lowStockVariants} />
            <AttentionRow to="/system/webhooks" search={{ status: "DEAD" }} icon={Webhook} label="Failed webhook deliveries" value={attention?.failedWebhookDeliveries} danger />
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
            <Link to="/reports" search={{ tab: "products" }} className="text-[13px] text-primary hover:underline">
              Report
            </Link>
          </CardHeader>
          <Table>
            <TableBody>
              {(data?.topProducts ?? [])
                .filter((p) => p.currencyCode === currency)
                .map((p) => (
                  <TableRow key={p.sku} className="hover:bg-transparent">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {p.product?.media?.[0]?.url ? <img src={p.product.media[0].url} alt="" className="size-9 rounded-md border object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} /> : <div className="size-9 rounded-md border bg-muted" />}
                        <div className="min-w-0">
                          {p.product ? (
                            <Link to="/products/$id" params={{ id: p.product.id }} className="block truncate font-medium hover:underline">
                              {p.name}
                            </Link>
                          ) : (
                            <span className="block truncate font-medium">{p.name}</span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {p.sku} · {p.quantity} sold
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="tabular text-right">{formatMoney(p.revenue)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          {!loading && !(data?.topProducts ?? []).some((p) => p.currencyCode === currency) ? <EmptyState title="No products sold yet" className="py-8" /> : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
            <Link to="/orders" className="text-[13px] text-primary hover:underline">
              All orders
            </Link>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Order</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(recent.data?.orders?.edges ?? []).map((edge) =>
                edge?.node ? (
                  <TableRow key={edge.node.id} className="hover:bg-transparent">
                    <TableCell>
                      <Link to="/orders/$number" params={{ number: edge.node.number! }} className="font-medium hover:underline">
                        {edge.node.number}
                      </Link>
                      <p className="max-w-44 truncate text-xs text-muted-foreground">
                        {relativeTime(edge.node.placedAt)} · {edge.node.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={edge.node.paymentStatus} />
                    </TableCell>
                    <TableCell className="tabular text-right">{formatMoney(edge.node.totals?.total)}</TableCell>
                  </TableRow>
                ) : null,
              )}
            </TableBody>
          </Table>
          {recent.data && !recent.data.orders?.edges?.length ? <EmptyState icon={Receipt} title="No orders yet" className="py-8" /> : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="size-4 text-success" /> Live
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Order events appear here as they happen.</p>
            ) : (
              <ol className="space-y-3">
                {events.map((event, i) => (
                  <li key={`${event.at}${i}`} className="text-[13px]">
                    <Link to="/orders/$number" params={{ number: event.number }} className="font-medium hover:underline">
                      {event.number}
                    </Link>{" "}
                    <span className="text-muted-foreground">{humanize(event.type.replace(/^order\./, ""))}</span>
                    <p className="text-xs text-muted-foreground">
                      {relativeTime(event.at)} · {event.total}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
      <PluginWidgets zone="dashboard" className="mt-6" />
    </Page>
  );
};

const AttentionRow = ({ to, search, icon: Icon, label, value, danger }: { to: string; search: Record<string, string>; icon: typeof AlertTriangle; label: string; value: number | null | undefined; danger?: boolean }) => (
  <Link to={to} search={search} className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent">
    <span className={cn("flex size-8 items-center justify-center rounded-md", value ? (danger ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning") : "bg-muted text-muted-foreground")}>
      <Icon className="size-4" />
    </span>
    <span className="flex-1 text-[13px]">{label}</span>
    <span className="tabular text-sm font-semibold">{value ?? "—"}</span>
  </Link>
);
