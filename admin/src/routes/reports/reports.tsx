import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionTabsList, SectionTabsTrigger, Tabs, TabsContent } from "@/components/ui/controls";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, NativeSelect } from "@/components/ui/input";
import { Select } from "@/components/ui/menu";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { graphql } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { formatAmount, formatDate, formatMoney, formatNumber, startOfDay, timeZone } from "@/lib/format";
import { useAdminCurrency, useListSearch, useReference } from "@/lib/hooks";
import { downloadText, toCsv } from "@/lib/utils";

const FIGURES = `currencyCode orders canceledOrders itemsSold gross { amount } subtotal { amount } discounts { amount } shipping { amount } tax { amount } refunded { amount } net { amount } averageOrderValue { amount }`;

const SalesQuery = graphql(`
  query SalesReport($range: DateRangeInput!, $granularity: ReportGranularity!, $channelId: ID, $currency: CurrencyCode, $timeZone: String) {
    salesReport(range: $range, granularity: $granularity, channelId: $channelId, currency: $currency, timeZone: $timeZone) {
      periods
      rows { period ${FIGURES} }
      totals { ${FIGURES} }
    }
  }
`);

const ProductsQuery = graphql(`
  query ProductSalesReport($range: DateRangeInput!, $channelId: ID, $currency: CurrencyCode, $sortBy: ProductSalesSort!) {
    productSalesReport(range: $range, channelId: $channelId, currency: $currency, sortBy: $sortBy, first: 100) {
      sku
      name
      quantity
      refundedQuantity
      orders
      currencyCode
      revenue {
        amount
        currencyCode
      }
      product {
        id
      }
    }
  }
`);

const CustomersQuery = graphql(`
  query CustomerReports($range: DateRangeInput!, $channelId: ID, $currency: CurrencyCode, $granularity: ReportGranularity!, $timeZone: String) {
    customerSalesReport(range: $range, channelId: $channelId, currency: $currency, first: 100) {
      email
      orders
      lastOrderAt
      currencyCode
      total {
        amount
        currencyCode
      }
      customer {
        id
        firstName
        lastName
      }
    }
    customerSignupsReport(range: $range, granularity: $granularity, timeZone: $timeZone) {
      period
      count
    }
  }
`);

const PromotionsQuery = graphql(`
  query PromotionUsageReport($range: DateRangeInput!, $channelId: ID, $currency: CurrencyCode) {
    promotionUsageReport(range: $range, channelId: $channelId, currency: $currency) {
      name
      couponCode
      orders
      currencyCode
      discount {
        amount
        currencyCode
      }
      promotion {
        id
        isActive
      }
    }
  }
`);

const LowStockQuery = graphql(`
  query LowStockReport($threshold: Int!, $locationId: ID) {
    lowStockReport(threshold: $threshold, locationId: $locationId, first: 200) {
      onHand
      variant {
        id
        sku
        name
        product {
          id
        }
      }
    }
  }
`);

const PRESETS = [
  { value: "6", label: "Last 7 days" },
  { value: "29", label: "Last 30 days" },
  { value: "89", label: "Last 90 days" },
  { value: "364", label: "Last 12 months" },
  { value: "custom", label: "Custom range" },
];

const toLocalDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const n = (m: { amount?: string | null } | null | undefined) => Number(m?.amount ?? 0);

const exportCsv = (name: string, header: string[], rows: unknown[][]) => downloadText(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([header, ...rows]));

export const ReportsPage = () => {
  const [search, setSearch] = useListSearch();
  const { channels, currencies, stockLocations, defaultChannelId, loading } = useReference();
  const tab = search.tab ?? "sales";
  const [preset, setPreset] = useState("29");
  const [from, setFrom] = useState(toLocalDate(startOfDay(29)));
  const [to, setTo] = useState(toLocalDate(new Date()));
  const [granularity, setGranularity] = useState<"DAY" | "WEEK" | "MONTH">("DAY");
  const [channelId, setChannelId] = useState("");
  // The filter follows the top bar's currency once one is picked, and picking here changes it.
  // "All currencies" lasts for the visit, until the admin's currency changes.
  const admin = useAdminCurrency();
  const preferred = admin.picked ? admin.currency : null;
  const [allFor, setAllFor] = useState<string | null>(null);
  const currency = allFor === admin.key ? "" : preferred && currencies.includes(preferred) ? preferred : "";
  const pickCurrency = (value: string) => {
    setAllFor(value ? null : admin.key);
    if (value) admin.chooseCurrency(value);
  };
  const ready = !loading && !admin.loading;
  const [sortBy, setSortBy] = useState<"QUANTITY" | "REVENUE">("REVENUE");
  const [threshold, setThreshold] = useState(5);
  const [locationId, setLocationId] = useState("");

  const range = useMemo(() => {
    if (preset !== "custom") return { from: startOfDay(Number(preset)).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [preset, from, to]);
  const common = { range, channelId: channelId || null, currency: currency || null };

  const sales = useQuery({ queryKey: ["report", "sales", common, granularity], queryFn: () => request(SalesQuery, { ...common, granularity, timeZone: timeZone() }), enabled: ready && tab === "sales" });
  const products = useQuery({ queryKey: ["report", "products", common, sortBy], queryFn: () => request(ProductsQuery, { ...common, sortBy }), enabled: ready && tab === "products" });
  const customers = useQuery({ queryKey: ["report", "customers", common, granularity], queryFn: () => request(CustomersQuery, { ...common, granularity, timeZone: timeZone() }), enabled: ready && tab === "customers" });
  const promotions = useQuery({ queryKey: ["report", "promotions", common], queryFn: () => request(PromotionsQuery, common), enabled: ready && tab === "promotions" });
  const lowStock = useQuery({ queryKey: ["report", "low-stock", threshold, locationId], queryFn: () => request(LowStockQuery, { threshold, locationId: locationId || null }), enabled: tab === "stock" });

  const [shown, setShown] = useState("");
  // Unfiltered, show the last picked currency (else the busiest), with the others as a switch.
  const home = channels.find((c) => c.id === defaultChannelId)?.defaultCurrency;
  const salesCurrencies = [...(sales.data?.salesReport?.totals ?? [])]
    .sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0) || Number(b.currencyCode === home) - Number(a.currencyCode === home))
    .map((t) => t.currencyCode ?? "");
  const first = shown || preferred || "";
  const salesCurrency = currency || (salesCurrencies.includes(first) ? first : salesCurrencies[0]) || currencies[0] || "USD";
  const salesRows = (sales.data?.salesReport?.rows ?? []).filter((r) => r.currencyCode === salesCurrency);
  const salesTotals = sales.data?.salesReport?.totals?.find((t) => t.currencyCode === salesCurrency);

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={preset} onValueChange={setPreset} options={PRESETS} className="w-40" aria-label="Range" />
      {preset === "custom" ? (
        <>
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From" />
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
        </>
      ) : null}
      <Select value={channelId} onValueChange={setChannelId} allowEmpty emptyLabel="All channels" placeholder="All channels" options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} className="w-44" aria-label="Channel" />
      <Select value={currency} onValueChange={pickCurrency} allowEmpty emptyLabel="All currencies" placeholder="All currencies" options={currencies.map((c) => ({ value: c, label: c }))} className="w-36" aria-label="Currency" />
    </div>
  );

  return (
    <Page wide>
      <PageHeader title="Reports" description="Every figure is computed live from orders, carts and stock, so there is nothing to refresh." />
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value })}>
        <SectionTabsList className="mb-5">
          <SectionTabsTrigger value="sales">Sales</SectionTabsTrigger>
          <SectionTabsTrigger value="products">Best sellers</SectionTabsTrigger>
          <SectionTabsTrigger value="customers">Customers</SectionTabsTrigger>
          <SectionTabsTrigger value="promotions">Promotions</SectionTabsTrigger>
          <SectionTabsTrigger value="stock">Low stock</SectionTabsTrigger>
        </SectionTabsList>

        <TabsContent value="sales" className="flex flex-col gap-4">
          <Toolbar>
            {controls}
            <Select value={granularity} onValueChange={(v) => setGranularity(v as typeof granularity)} options={[{ value: "DAY", label: "By day" }, { value: "WEEK", label: "By week" }, { value: "MONTH", label: "By month" }]} className="w-32" aria-label="Group by" />
            <ExportButton
              onClick={() =>
                exportCsv(
                  "sales",
                  ["Period", "Currency", "Orders", "Canceled", "Items", "Subtotal", "Discounts", "Shipping", "Tax", "Gross", "Refunded", "Net"],
                  (sales.data?.salesReport?.rows ?? []).map((r) => [r.period, r.currencyCode, r.orders, r.canceledOrders, r.itemsSold, r.subtotal?.amount, r.discounts?.amount, r.shipping?.amount, r.tax?.amount, r.gross?.amount, r.refunded?.amount, r.net?.amount]),
                )
              }
            />
          </Toolbar>
          {!currency && salesCurrencies.length > 1 ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              Showing
              {salesCurrencies.map((c) => (
                <Button key={c} size="sm" variant={c === salesCurrency ? "secondary" : "ghost"} onClick={() => setShown(c)}>
                  {c}
                </Button>
              ))}
            </div>
          ) : null}
          {salesTotals ? (
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Stat label="Orders" value={formatNumber(salesTotals.orders)} />
              <Stat label="Gross" value={formatAmount(n(salesTotals.gross), salesCurrency)} />
              <Stat label="Discounts" value={formatAmount(n(salesTotals.discounts), salesCurrency)} />
              <Stat label="Tax" value={formatAmount(n(salesTotals.tax), salesCurrency)} />
              <Stat label="Refunded" value={formatAmount(n(salesTotals.refunded), salesCurrency)} />
              <Stat label="Net" value={formatAmount(n(salesTotals.net), salesCurrency)} />
            </div>
          ) : null}
          <Card>
            <CardContent className="h-72 pt-5 pr-2 pl-0">
              {!ready || sales.isLoading ? (
                <Skeleton className="mx-5 h-full" />
              ) : salesRows.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={salesRows.map((r) => ({ period: r.period, gross: n(r.gross), orders: r.orders }))} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="period" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" tickFormatter={(p: string) => formatDate(p, granularity === "MONTH" ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" })} minTickGap={20} />
                    <YAxis yAxisId="money" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" width={64} tickFormatter={(v: number) => formatAmount(v, salesCurrency, { notation: "compact", maximumFractionDigits: 1 })} />
                    <YAxis yAxisId="orders" orientation="right" tickLine={false} axisLine={false} fontSize={11} stroke="var(--muted-foreground)" width={32} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value, name) => [name === "gross" ? formatAmount(Number(value), salesCurrency) : String(value), name === "gross" ? "Gross" : "Orders"]} />
                    <Bar yAxisId="money" dataKey="gross" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
                    <Line yAxisId="orders" dataKey="orders" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No orders in this range" />
              )}
            </CardContent>
          </Card>
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                  <TableHead className="text-right">Discounts</TableHead>
                  <TableHead className="text-right">Shipping</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...salesRows].reverse().filter((r) => (r.orders ?? 0) > 0 || (r.canceledOrders ?? 0) > 0).map((r) => (
                  <TableRow key={r.period}>
                    <TableCell>{formatDate(r.period, granularity === "MONTH" ? { month: "long", year: "numeric" } : { dateStyle: "medium" })}</TableCell>
                    <TableCell className="tabular text-right">{r.orders}</TableCell>
                    <TableCell className="tabular text-right">{r.itemsSold}</TableCell>
                    <Money value={r.subtotal} currency={salesCurrency} />
                    <Money value={r.discounts} currency={salesCurrency} />
                    <Money value={r.shipping} currency={salesCurrency} />
                    <Money value={r.tax} currency={salesCurrency} />
                    <Money value={r.gross} currency={salesCurrency} strong />
                    <Money value={r.refunded} currency={salesCurrency} />
                    <Money value={r.net} currency={salesCurrency} />
                  </TableRow>
                ))}
              </TableBody>
              {salesTotals ? (
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell>Total</TableCell>
                    <TableCell className="tabular text-right">{salesTotals.orders}</TableCell>
                    <TableCell className="tabular text-right">{salesTotals.itemsSold}</TableCell>
                    <Money value={salesTotals.subtotal} currency={salesCurrency} />
                    <Money value={salesTotals.discounts} currency={salesCurrency} />
                    <Money value={salesTotals.shipping} currency={salesCurrency} />
                    <Money value={salesTotals.tax} currency={salesCurrency} />
                    <Money value={salesTotals.gross} currency={salesCurrency} strong />
                    <Money value={salesTotals.refunded} currency={salesCurrency} />
                    <Money value={salesTotals.net} currency={salesCurrency} />
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="products" className="flex flex-col gap-4">
          <Toolbar>
            {controls}
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)} options={[{ value: "REVENUE", label: "By revenue" }, { value: "QUANTITY", label: "By units" }]} className="w-32" aria-label="Sort" />
            <ExportButton onClick={() => exportCsv("best-sellers", ["SKU", "Name", "Currency", "Units", "Refunded units", "Orders", "Revenue"], (products.data?.productSalesReport ?? []).map((p) => [p.sku, p.name, p.currencyCode, p.quantity, p.refundedQuantity, p.orders, p.revenue?.amount]))} />
          </Toolbar>
          <ReportTable
            loading={!ready || products.isLoading}
            headers={["Product", "SKU", "Units", "Refunded", "Orders", "Revenue"]}
            rows={(products.data?.productSalesReport ?? []).map((p) => [
              p.product ? (
                <Link to="/products/$id" params={{ id: p.product.id }} className="font-medium hover:underline">
                  {p.name}
                </Link>
              ) : (
                p.name
              ),
              <span className="text-muted-foreground">{p.sku}</span>,
              p.quantity,
              p.refundedQuantity,
              p.orders,
              formatMoney(p.revenue),
            ])}
          />
        </TabsContent>

        <TabsContent value="customers" className="flex flex-col gap-4">
          <Toolbar>
            {controls}
            <ExportButton
              onClick={() =>
                exportCsv(
                  "top-customers",
                  ["Email", "Name", "Currency", "Orders", "Total", "Last order"],
                  (customers.data?.customerSalesReport ?? []).map((c) => [c.email, c.customer ? `${c.customer.firstName} ${c.customer.lastName}` : "Guest", c.currencyCode, c.orders, c.total?.amount, c.lastOrderAt]),
                )
              }
            />
          </Toolbar>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="New accounts in range" value={formatNumber((customers.data?.customerSignupsReport ?? []).reduce((s, p) => s + (p.count ?? 0), 0))} />
            <Stat label="Buying customers" value={formatNumber(customers.data?.customerSalesReport?.length ?? 0)} />
            <Stat label="Guest buyers" value={formatNumber((customers.data?.customerSalesReport ?? []).filter((c) => !c.customer).length)} />
          </div>
          <ReportTable
            loading={!ready || customers.isLoading}
            headers={["Customer", "Email", "Orders", "Total", "Last order"]}
            rows={(customers.data?.customerSalesReport ?? []).map((c) => [
              c.customer ? (
                <Link to="/customers/$id" params={{ id: c.customer.id }} className="font-medium hover:underline">
                  {c.customer.firstName} {c.customer.lastName}
                </Link>
              ) : (
                <span className="text-muted-foreground">Guest</span>
              ),
              c.email,
              c.orders,
              formatMoney(c.total),
              formatDate(c.lastOrderAt),
            ])}
          />
        </TabsContent>

        <TabsContent value="promotions" className="flex flex-col gap-4">
          <Toolbar>
            {controls}
            <ExportButton onClick={() => exportCsv("promotion-usage", ["Promotion", "Coupon", "Currency", "Orders", "Discount"], (promotions.data?.promotionUsageReport ?? []).map((p) => [p.name, p.couponCode, p.currencyCode, p.orders, p.discount?.amount]))} />
          </Toolbar>
          <ReportTable
            loading={!ready || promotions.isLoading}
            headers={["Promotion", "Coupon", "Orders", "Discount given"]}
            rows={(promotions.data?.promotionUsageReport ?? []).map((p) => [
              p.promotion ? (
                <Link to="/promotions/$id" params={{ id: p.promotion.id }} className="font-medium hover:underline">
                  {p.name}
                </Link>
              ) : (
                p.name
              ),
              p.couponCode ?? <span className="text-muted-foreground">Automatic</span>,
              p.orders,
              formatMoney(p.discount),
            ])}
          />
        </TabsContent>

        <TabsContent value="stock" className="flex flex-col gap-4">
          <Toolbar>
            <div className="flex items-center gap-2 text-[13px]">
              At most
              <Input type="number" min={0} value={threshold} onChange={(e) => setThreshold(Math.max(0, Number(e.target.value)))} className="h-9 w-20" aria-label="Threshold" />
              on hand at
              <NativeSelect value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-48" aria-label="Location">
                <option value="">All locations</option>
                {stockLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <ExportButton onClick={() => exportCsv("low-stock", ["SKU", "Name", "On hand"], (lowStock.data?.lowStockReport ?? []).map((r) => [r.variant?.sku, r.variant?.name, r.onHand]))} />
          </Toolbar>
          <ReportTable
            loading={lowStock.isLoading}
            headers={["Variant", "SKU", "On hand"]}
            rows={(lowStock.data?.lowStockReport ?? []).map((r) => [
              r.variant?.product ? (
                <Link to="/products/$id" params={{ id: r.variant.product.id }} className="font-medium hover:underline">
                  {r.variant.name}
                </Link>
              ) : (
                r.variant?.name
              ),
              <span className="text-muted-foreground">{r.variant?.sku}</span>,
              <span className={r.onHand === 0 ? "font-semibold text-destructive" : ""}>{r.onHand}</span>,
            ])}
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
};

const Toolbar = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center justify-between gap-2">{children}</div>;

const ExportButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="outline" size="sm" onClick={onClick} className="ml-auto">
    <Download />
    Export CSV
  </Button>
);

const Stat = ({ label, value }: { label: string; value: string }) => (
  <Card>
    <CardContent className="pt-4 pb-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold">{value}</p>
    </CardContent>
  </Card>
);

const Money = ({ value, currency, strong }: { value: { amount?: string | null } | null | undefined; currency: string; strong?: boolean }) => (
  <TableCell className={`tabular text-right ${strong ? "font-medium" : ""}`}>{formatAmount(n(value), currency)}</TableCell>
);

const ReportTable = ({ headers, rows, loading }: { headers: string[]; rows: ReactNode[][]; loading?: boolean }) => (
  <Card>
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {headers.map((h, i) => (
            <TableHead key={h} className={i > 1 ? "text-right" : undefined}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            {row.map((cell, j) => (
              <TableCell key={j} className={j > 1 ? "tabular text-right" : undefined}>
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
    {loading ? <Skeleton className="m-5 h-24" /> : rows.length === 0 ? <EmptyState title="Nothing to report for these filters" /> : null}
  </Card>
);
