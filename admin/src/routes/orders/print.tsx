import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Printer, RotateCcw } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { request } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { useListSearch } from "@/lib/hooks";
import { humanize } from "@/lib/utils";
import { Address, OrderQuery, type OrderDetail } from "./detail";

type Kind = "invoice" | "packing";

const DOCUMENTS = {
  both: { kinds: ["invoice", "packing"], one: "Invoice and packing slip", many: "Invoices and packing slips" },
  packing: { kinds: ["packing"], one: "Packing slip", many: "Packing slips" },
  invoice: { kinds: ["invoice"], one: "Invoice", many: "Invoices" },
} satisfies Record<string, { kinds: Kind[]; one: string; many: string }>;

type DocumentChoice = keyof typeof DOCUMENTS;

/** Which documents to print, kept in the URL as `doc`; both by default. */
const useDocumentChoice = () => {
  const [search, setSearch] = useListSearch();
  const doc: DocumentChoice = search.doc === "packing" || search.doc === "invoice" ? search.doc : "both";
  return [doc, (next: DocumentChoice) => setSearch({ doc: next === "both" ? undefined : next })] as const;
};

const DocumentSwitch = ({ value, onChange, many }: { value: DocumentChoice; onChange: (value: DocumentChoice) => void; many?: boolean }) => (
  <Tabs value={value} onValueChange={(next) => onChange(next as DocumentChoice)}>
    <TabsList aria-label="Documents to print">
      <TabsTrigger value="packing">{many ? "Packing slips" : "Packing slip"}</TabsTrigger>
      <TabsTrigger value="invoice">{many ? "Invoices" : "Invoice"}</TabsTrigger>
      <TabsTrigger value="both">Both</TabsTrigger>
    </TabsList>
  </Tabs>
);

const HOW = "Use your browser's print dialog to print or save as PDF.";

/** Plain HTML with print styles: the browser's print dialog also saves it as PDF. */
export const OrderPrintPage = () => {
  const { number } = useParams({ strict: false }) as { number: string };
  const [doc, setDoc] = useDocumentChoice();
  const query = useQuery({ queryKey: ["order", number], queryFn: ({ signal }) => request(OrderQuery, { number }, { signal }) });
  const order = query.data?.order;
  return (
    <Page className="print:max-w-none print:p-0">
      <div className="no-print">
        <PageHeader
          back={{ to: `/orders/${number}`, label: `Order ${number}` }}
          title="Print documents"
          description={`${DOCUMENTS[doc].one}. ${HOW}`}
          actions={
            <>
              <DocumentSwitch value={doc} onChange={setDoc} />
              <Button onClick={() => window.print()} disabled={!order}>
                <Printer />
                Print
              </Button>
            </>
          }
        />
      </div>
      {order ? (
        <div className="flex flex-col gap-8 print:gap-0">
          {DOCUMENTS[doc].kinds.map((kind) => (
            <Document key={kind} order={order} kind={kind} />
          ))}
        </div>
      ) : query.isPending ? (
        <Skeleton className="h-[40rem] w-full" />
      ) : (
        <EmptyState title="Order not found" description={query.error instanceof Error ? query.error.message : `No order ${number}.`} />
      )}
    </Page>
  );
};

/** The list's Print bulk action: /orders/print?numbers=1001,1002&doc=packing. */
export const OrdersPrintPage = () => {
  const [search] = useListSearch();
  const [doc, setDoc] = useDocumentChoice();
  const numbers = [
    ...new Set(
      (search.numbers ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
  const queries = useQueries({ queries: numbers.map((number) => ({ queryKey: ["order", number], queryFn: ({ signal }: { signal: AbortSignal }) => request(OrderQuery, { number }, { signal }) })) });
  const loaded = queries.filter((q) => q.data?.order).length;
  const loading = queries.some((q) => q.isPending);
  const failed = numbers.flatMap((number, i) => {
    const q = queries[i]!;
    if (q.isError) return [{ number, reason: q.error instanceof Error ? q.error.message : "Could not load" }];
    return q.isSuccess && !q.data.order ? [{ number, reason: "Not found" }] : [];
  });
  const pages = loaded * DOCUMENTS[doc].kinds.length;

  if (!numbers.length) {
    return (
      <Page>
        <EmptyState
          icon={Printer}
          title="No orders to print"
          description="Select orders in the list, then choose Print."
          action={
            <Button asChild variant="outline">
              <Link to="/orders">Back to orders</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page className="print:max-w-none print:p-0">
      <div className="no-print">
        <PageHeader
          back={{ to: "/orders", label: "Orders" }}
          title={DOCUMENTS[doc].many}
          description={loading ? `Loaded ${loaded} of ${numbers.length} orders…` : `${loaded} ${loaded === 1 ? "order" : "orders"}, ${pages} ${pages === 1 ? "page" : "pages"}. ${HOW}`}
          actions={
            <>
              <DocumentSwitch value={doc} onChange={setDoc} many />
              <Button onClick={() => window.print()} disabled={loading || !loaded}>
                <Printer />
                Print
              </Button>
            </>
          }
        />
        {loading ? (
          <div role="progressbar" aria-label="Loading orders" aria-valuemin={0} aria-valuemax={numbers.length} aria-valuenow={loaded} className="mb-6 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(loaded / numbers.length) * 100}%` }} />
          </div>
        ) : null}
        {failed.length ? (
          <Alert
            variant="warning"
            className="mb-6"
            title={`${failed.length} of ${numbers.length} orders could not be loaded and are left out`}
            action={
              <Button size="sm" variant="outline" onClick={() => queries.forEach((q) => q.isError && void q.refetch())}>
                <RotateCcw />
                Try again
              </Button>
            }
          >
            {failed.map((f) => `${f.number}: ${f.reason}`).join(" · ")}
          </Alert>
        ) : null}
      </div>
      <div className="flex flex-col gap-8 print:gap-0">
        {numbers.map((number, i) => {
          const order = queries[i]!.data?.order;
          if (order) return DOCUMENTS[doc].kinds.map((kind) => <Document key={`${number}-${kind}`} order={order} kind={kind} />);
          return queries[i]!.isPending ? <Skeleton key={number} className="no-print mx-auto h-72 w-full max-w-[52rem]" /> : null;
        })}
      </div>
    </Page>
  );
};

const Document = ({ order, kind }: { order: OrderDetail; kind: Kind }) => {
  const invoice = kind === "invoice";
  const lines = order.lines ?? [];
  return (
    <article className="mx-auto w-full max-w-[52rem] rounded-xl border bg-white p-10 text-[13px] text-zinc-900 shadow-sm print:max-w-none print:break-after-page print:rounded-none print:border-0 print:p-8 print:shadow-none print:last:break-after-auto">
      <header className="flex items-start justify-between gap-6 border-b border-zinc-200 pb-6">
        <div>
          <p className="text-lg font-semibold">{order.channel?.name}</p>
          <p className="text-zinc-500">{invoice ? "Invoice" : "Packing slip"}</p>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-right">
          <dt className="text-zinc-500">Order</dt>
          <dd className="font-medium">{order.number}</dd>
          <dt className="text-zinc-500">Date</dt>
          <dd>{formatDate(order.placedAt)}</dd>
          {invoice && order.invoices?.length ? (
            <>
              <dt className="text-zinc-500">Invoice</dt>
              <dd>{order.invoices.map((i) => i.number).join(", ")}</dd>
            </>
          ) : null}
          {invoice ? (
            <>
              <dt className="text-zinc-500">Payment</dt>
              <dd>{humanize(order.paymentStatus)}</dd>
            </>
          ) : (
            <>
              <dt className="text-zinc-500">Shipping</dt>
              <dd>{order.shippingMethod?.name ?? "—"}</dd>
            </>
          )}
        </dl>
      </header>
      <section className="grid grid-cols-2 gap-6 border-b border-zinc-200 py-6">
        <div>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{invoice ? "Bill to" : "Ship to"}</p>
          <Address address={invoice ? order.billingAddress : (order.shippingAddress ?? order.billingAddress)} />
          <p className="mt-1 text-zinc-500">{order.email}</p>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{invoice ? "Ship to" : "Bill to"}</p>
          <Address address={invoice ? order.shippingAddress : order.billingAddress} />
        </div>
      </section>
      <table className="mt-6 w-full">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
            <th className="py-2 font-medium">Item</th>
            <th className="py-2 font-medium">SKU</th>
            <th className="py-2 text-right font-medium">Qty</th>
            {invoice ? (
              <>
                <th className="py-2 text-right font-medium">Price</th>
                <th className="py-2 text-right font-medium">Tax</th>
                <th className="py-2 text-right font-medium">Total</th>
              </>
            ) : (
              <th className="w-20 py-2 text-right font-medium">Packed</th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-zinc-100 align-top">
              <td className="py-2.5 pr-4">
                {line.name}
                {line.variantAttributes && typeof line.variantAttributes === "object" ? (
                  <p className="text-xs text-zinc-500">
                    {Object.entries(line.variantAttributes as Record<string, string>)
                      .map(([k, v]) => `${humanize(k)}: ${v}`)
                      .join(" · ")}
                  </p>
                ) : null}
              </td>
              <td className="py-2.5 pr-4 font-mono text-xs">{line.sku}</td>
              <td className="tabular py-2.5 text-right">{invoice ? line.quantity : (line.quantity ?? 0) - (line.quantityCanceled ?? 0) - (line.quantityRefunded ?? 0)}</td>
              {invoice ? (
                <>
                  <td className="tabular py-2.5 text-right">{formatMoney(line.unitPrice)}</td>
                  <td className="tabular py-2.5 text-right">{formatMoney(line.tax)}</td>
                  <td className="tabular py-2.5 text-right">{formatMoney(line.total)}</td>
                </>
              ) : (
                <td className="py-2.5 text-right">
                  <span className="inline-block size-4 rounded border border-zinc-400" />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {invoice ? (
        <dl className="mt-6 ml-auto max-w-xs space-y-1">
          <Line label="Subtotal" value={formatMoney(order.totals?.subtotal)} />
          {(order.totals?.discounts ?? []).map((d) => (
            <Line key={`${d.name}${d.couponCode}`} label={d.couponCode ? `${d.name} (${d.couponCode})` : (d.name ?? "Discount")} value={`−${formatMoney(d.amount)}`} />
          ))}
          <Line label="Shipping" value={formatMoney(order.totals?.shipping)} />
          {(order.totals?.taxLines ?? []).map((t) => (
            <Line key={t.name} label={`${t.name} (${t.rate}%)`} value={formatMoney(t.amount)} />
          ))}
          <div className="flex justify-between border-t border-zinc-300 pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular">{formatMoney(order.totals?.total)}</dd>
          </div>
          <Line label="Paid" value={formatMoney(order.totals?.paid)} />
          {Number(order.totals?.refunded?.amount) > 0 ? <Line label="Refunded" value={`−${formatMoney(order.totals?.refunded)}`} /> : null}
          <p className="pt-2 text-xs text-zinc-500">{order.totals?.pricesIncludeTax ? "Prices include tax." : "Prices exclude tax."}</p>
        </dl>
      ) : (
        <p className="mt-8 text-xs text-zinc-500">Thank you for your order. Questions? Reply to your order confirmation email.</p>
      )}
    </article>
  );
};

const Line = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-4 text-zinc-600">
    <dt>{label}</dt>
    <dd className="tabular text-zinc-900">{value}</dd>
  </div>
);
