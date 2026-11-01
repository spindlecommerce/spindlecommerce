import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Ban, ChevronLeft, ChevronRight, CreditCard, MapPin, MessageSquarePlus, MoreHorizontal, Pencil, Printer, RotateCcw, Truck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { PluginWidgets } from "@/components/plugin-widgets";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Separator, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { COUNTRY_CODES, countryName, formatDateTime, formatMoney, relativeTime } from "@/lib/format";
import { useAction, useReference } from "@/lib/hooks";
import { humanize } from "@/lib/utils";
import { orderBlocker, remaining, useOrderQueue, type OrderQueueNav } from "./shared";

const ADDRESS = `firstName lastName company line1 line2 city region regionCode postalCode countryCode phone`;

export const OrderQuery = graphql(`
  query Order($number: String!) {
    order(number: $number) {
      id
      number
      status
      paymentStatus
      fulfillmentStatus
      placedAt
      canceledAt
      completedAt
      canCancel
      email
      currencyCode
      locale
      couponCodes
      paymentMethodCode
      metadata
      channel {
        id
        code
        name
      }
      customer {
        id
        firstName
        lastName
        email
        group {
          name
        }
      }
      shippingAddress { ${ADDRESS} }
      billingAddress { ${ADDRESS} }
      shippingMethod {
        code
        name
        carrier
        provider
        price {
          formatted
        }
      }
      shipmentProviders {
        code
        title
      }
      lines {
        id
        name
        sku
        quantity
        quantityFulfilled
        quantityRefunded
        quantityCanceled
        variantAttributes
        taxRate
        product {
          id
          media {
            url
          }
        }
        unitPrice {
          amount
          currencyCode
        }
        discount {
          amount
          currencyCode
        }
        tax {
          amount
          currencyCode
        }
        total {
          amount
          currencyCode
        }
      }
      totals {
        pricesIncludeTax
        subtotal {
          amount
          currencyCode
        }
        discountTotal {
          amount
          currencyCode
        }
        shipping {
          amount
          currencyCode
        }
        tax {
          amount
          currencyCode
        }
        total {
          amount
          currencyCode
        }
        paid {
          amount
          currencyCode
        }
        refunded {
          amount
          currencyCode
        }
        discounts {
          name
          couponCode
          amount {
            amount
            currencyCode
          }
        }
        taxLines {
          name
          rate
          amount {
            amount
            currencyCode
          }
        }
      }
      amountAuthorized {
        amount
        currencyCode
      }
      transactions {
        id
        kind
        status
        provider
        pspReference
        errorMessage
        createdAt
        amount {
          amount
          currencyCode
        }
      }
      invoices {
        id
        number
        createdAt
        amount {
          amount
          currencyCode
        }
      }
      fulfillments {
        id
        number
        status
        createdAt
        location {
          name
        }
        tracking {
          carrier
          number
          url
        }
        shipment {
          providerTitle
          labelUrl
          cost {
            amount
            currencyCode
          }
        }
        lines {
          quantity
          orderLine {
            id
            name
            sku
          }
        }
      }
      refunds {
        id
        number
        reason
        createdAt
        amount {
          amount
          currencyCode
        }
        shippingAmount {
          amount
          currencyCode
        }
        lines {
          quantity
          restocked
          orderLine {
            name
          }
        }
      }
      timeline {
        type
        message
        actorType
        actorId
        createdAt
      }
    }
  }
`);

export type OrderDetail = NonNullable<ResultOf<typeof OrderQuery>["order"]>;
type Line = NonNullable<OrderDetail["lines"]>[number];
type AddressValue = NonNullable<OrderDetail["shippingAddress"]>;

const StaffNames = graphql(`
  query StaffNames {
    staffUsers {
      id
      name
    }
  }
`);

const CaptureMutation = graphql(
  `
    mutation CapturePayment($orderId: ID!, $amount: Decimal) {
      orderCapturePayment(orderId: $orderId, amount: $amount) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const FulfillMutation = graphql(
  `
    mutation Fulfill($orderId: ID!, $input: OrderFulfillInput) {
      orderFulfill(orderId: $orderId, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const RefundMutation = graphql(
  `
    mutation Refund($orderId: ID!, $input: OrderRefundInput!) {
      orderRefund(orderId: $orderId, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const CancelMutation = graphql(
  `
    mutation CancelOrder($orderId: ID!, $reason: String) {
      orderCancel(orderId: $orderId, reason: $reason) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const NoteMutation = graphql(
  `
    mutation AddNote($orderId: ID!, $message: String!) {
      orderNoteAdd(orderId: $orderId, message: $message) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const AddressMutation = graphql(
  `
    mutation UpdateAddresses($orderId: ID!, $shippingAddress: AddressInput, $billingAddress: AddressInput) {
      orderUpdateAddresses(orderId: $orderId, shippingAddress: $shippingAddress, billingAddress: $billingAddress) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const refundable = (l: Line) => (l.quantity ?? 0) - (l.quantityRefunded ?? 0) - (l.quantityCanceled ?? 0);
const money = (amount: number, currency: string) => formatMoney({ amount: amount.toFixed(currency === "JPY" ? 0 : 2), currencyCode: currency });

export const Address = ({ address }: { address: AddressValue | null | undefined }) =>
  address ? (
    <address className="text-[13px] leading-relaxed not-italic">
      {address.firstName} {address.lastName}
      {address.company ? (
        <>
          <br />
          {address.company}
        </>
      ) : null}
      <br />
      {address.line1}
      {address.line2 ? (
        <>
          <br />
          {address.line2}
        </>
      ) : null}
      <br />
      {address.postalCode} {address.city}
      {address.regionCode || address.region ? `, ${address.regionCode ?? address.region}` : ""}
      <br />
      {countryName(address.countryCode)}
      {address.phone ? (
        <>
          <br />
          <span className="text-muted-foreground">{address.phone}</span>
        </>
      ) : null}
    </address>
  ) : (
    <p className="text-[13px] text-muted-foreground">None</p>
  );

const options = (attrs: unknown) =>
  attrs && typeof attrs === "object"
    ? Object.entries(attrs as Record<string, string>)
        .map(([k, v]) => `${humanize(k)}: ${v}`)
        .join(" · ")
    : "";

/** "‹ 3 of 25 ›": steps through the orders list this order was opened from. */
const QueueNav = ({ queue }: { queue: OrderQueueNav }) => (
  <div role="group" aria-label="Orders in the list" className="mr-1 flex items-center gap-1 border-r pr-3">
    <Tooltip content="Previous order (K or [)">
      <Button variant="outline" size="icon" disabled={!queue.previous} onClick={queue.goPrevious} aria-label="Previous order">
        <ChevronLeft />
      </Button>
    </Tooltip>
    <span className="tabular min-w-16 text-center text-[13px] text-muted-foreground">{queue.label}</span>
    <Tooltip content="Next order (J or ])">
      <Button variant="outline" size="icon" disabled={!queue.hasNext} loading={queue.loading} onClick={() => void queue.goNext()} aria-label="Next order">
        {queue.loading ? null : <ChevronRight />}
      </Button>
    </Tooltip>
  </div>
);

const nextOrderAction = (queue: OrderQueueNav | null) => (queue?.hasNext ? { action: { label: "Next order →", onClick: () => void queue.goNext() }, duration: 10_000 } : undefined);

/** Keyed by number, so stepping to another order drops any half-written note or open dialog. */
export const OrderPage = () => {
  const { number } = useParams({ strict: false }) as { number: string };
  return <OrderView key={number} number={number} />;
};

const OrderView = ({ number }: { number: string }) => {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["order", number], queryFn: ({ signal }) => request(OrderQuery, { number }, { signal }) });
  const staff = useQuery({ queryKey: ["staff-names"], queryFn: () => request(StaffNames), enabled: can("staff:read"), staleTime: 5 * 60_000 });
  const queue = useOrderQueue(number);
  const [dialog, setDialog] = useState<"capture" | "fulfill" | "refund" | "cancel" | "shipping" | "billing" | null>(null);
  const [note, setNote] = useState("");
  const write = can("orders:write");
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["order", number] }), queryClient.invalidateQueries({ queryKey: ["orders"] })]);
  const closeDialog = () => setDialog(null);

  // The neighbours in the queue open instantly.
  useEffect(() => {
    for (const neighbour of [queue?.next, queue?.previous]) {
      if (neighbour) void queryClient.prefetchQuery({ queryKey: ["order", neighbour], queryFn: () => request(OrderQuery, { number: neighbour }) });
    }
  }, [queue?.next, queue?.previous, queryClient]);

  const addNote = useAction((message: string) => request(NoteMutation, { orderId: order!.id, message }).then((r) => unwrap(r.orderNoteAdd)), {
    success: "Note added",
    onSuccess: () => {
      setNote("");
      void refresh();
    },
  });

  if (query.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  }
  const order = query.data?.order;
  if (!order) {
    return (
      <Page>
        <EmptyState title="Order not found" description={query.error instanceof Error ? query.error.message : `No order ${number}.`} action={<Button asChild variant="outline"><Link to="/orders">Back to orders</Link></Button>} />
      </Page>
    );
  }

  const currency = order.currencyCode ?? "USD";
  const total = Number(order.totals?.total?.amount ?? 0);
  const paid = Number(order.totals?.paid?.amount ?? 0);
  const refunded = Number(order.totals?.refunded?.amount ?? 0);
  const outstanding = Math.max(0, total - paid);
  const open = order.status === "OPEN";
  // The same rules decide which orders the list's bulk actions count and skip.
  const canCapture = write && !orderBlocker("capture", order);
  const canFulfill = write && !orderBlocker("fulfill", order);
  const canCancel = write && !orderBlocker("cancel", order);
  const canRefund = write && paid - refunded > 0;
  const staffName = (id: string | null | undefined) => staff.data?.staffUsers?.find((s) => s.id.endsWith(id ?? "#"))?.name;

  return (
    <Page>
      <PageHeader
        back={{ to: "/orders", label: "Orders" }}
        title={`Order ${order.number}`}
        badges={
          <>
            <StatusBadge value={order.status} />
            <StatusBadge value={order.paymentStatus} />
            <StatusBadge value={order.fulfillmentStatus} />
          </>
        }
        description={`Placed ${formatDateTime(order.placedAt)} in ${order.channel?.name} · ${order.locale}`}
        actions={
          <>
            {queue ? <QueueNav queue={queue} /> : null}
            {canCapture ? (
              <Button variant="outline" onClick={() => setDialog("capture")}>
                <CreditCard />
                Capture payment
              </Button>
            ) : null}
            {canFulfill ? (
              <Button onClick={() => setDialog("fulfill")}>
                <Truck />
                Ship items
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem asChild>
                  <Link to="/orders/$number/print" params={{ number: order.number! }}>
                    <Printer />
                    Print invoice and packing slip
                  </Link>
                </DropdownMenuItem>
                {canRefund ? (
                  <DropdownMenuItem onSelect={() => setDialog("refund")}>
                    <RotateCcw />
                    Refund
                  </DropdownMenuItem>
                ) : null}
                {canCancel ? (
                  <DropdownMenuItem destructive onSelect={() => setDialog("cancel")}>
                    <Ban />
                    Cancel order
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <TwoColumn
        main={
          <>
            <Card>
              <CardHeader>
                <CardTitle>Items</CardTitle>
                <span className="text-[13px] text-muted-foreground">{order.totals?.pricesIncludeTax ? "Prices include tax" : "Prices exclude tax"}</span>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(order.lines ?? []).map((line) => (
                    <TableRow key={line.id} className="hover:bg-transparent">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {line.product?.media?.[0]?.url ? (
                            <img src={line.product.media[0].url} alt="" className="size-10 shrink-0 rounded-md border object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                          ) : (
                            <div className="size-10 shrink-0 rounded-md border bg-muted" />
                          )}
                          <div className="min-w-0">
                            {line.product ? (
                              <Link to="/products/$id" params={{ id: line.product.id }} className="font-medium hover:underline">
                                {line.name}
                              </Link>
                            ) : (
                              <span className="font-medium">{line.name}</span>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {line.sku}
                              {options(line.variantAttributes) ? ` · ${options(line.variantAttributes)}` : ""}
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                              {line.quantityFulfilled ? <span>{line.quantityFulfilled} shipped</span> : null}
                              {line.quantityRefunded ? <span>· {line.quantityRefunded} refunded</span> : null}
                              {line.quantityCanceled ? <span>· {line.quantityCanceled} canceled</span> : null}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-right">{formatMoney(line.unitPrice)}</TableCell>
                      <TableCell className="tabular text-right">{line.quantity}</TableCell>
                      <TableCell className="tabular text-right">
                        {formatMoney(line.total)}
                        {Number(line.discount?.amount) > 0 ? <p className="text-xs text-success">−{formatMoney(line.discount)}</p> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <CardContent className="border-t pt-4">
                <dl className="ml-auto max-w-sm space-y-1.5 text-[13px]">
                  <Row label="Subtotal" value={formatMoney(order.totals?.subtotal)} />
                  {(order.totals?.discounts ?? []).map((d) => (
                    <Row key={`${d.name}${d.couponCode}`} label={`Discount: ${d.name}${d.couponCode ? ` (${d.couponCode})` : ""}`} value={`−${formatMoney(d.amount)}`} tone="text-success" />
                  ))}
                  <Row label={`Shipping${order.shippingMethod ? ` · ${order.shippingMethod.name}` : ""}`} value={formatMoney(order.totals?.shipping)} />
                  {(order.totals?.taxLines ?? []).map((t) => (
                    <Row key={t.name} label={`${t.name} (${t.rate}%)`} value={formatMoney(t.amount)} muted />
                  ))}
                  <Row label="Tax" value={formatMoney(order.totals?.tax)} />
                  <Separator className="my-2" />
                  <Row label="Total" value={formatMoney(order.totals?.total)} strong />
                  <Row label="Paid" value={formatMoney(order.totals?.paid)} />
                  {refunded > 0 ? <Row label="Refunded" value={`−${formatMoney(order.totals?.refunded)}`} /> : null}
                  {outstanding > 0 && order.status !== "CANCELED" ? <Row label="Outstanding" value={money(outstanding, currency)} tone="text-warning" strong /> : null}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Payments</CardTitle>
                <span className="text-[13px] text-muted-foreground">{order.paymentMethodCode}</span>
              </CardHeader>
              {(order.transactions ?? []).length === 0 ? (
                <CardContent className="text-[13px] text-muted-foreground">No transactions yet.</CardContent>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Transaction</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(order.transactions ?? []).map((t) => (
                      <TableRow key={t.id} className="hover:bg-transparent">
                        <TableCell>
                          <span className="font-medium">{humanize(t.kind)}</span>
                          <p className="text-xs text-muted-foreground">
                            {t.provider} · {relativeTime(t.createdAt)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge value={t.status?.toUpperCase()} />
                          {t.errorMessage ? <p className="mt-1 text-xs text-destructive">{t.errorMessage}</p> : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{t.pspReference ?? "—"}</TableCell>
                        <TableCell className="tabular text-right">{formatMoney(t.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {(order.invoices ?? []).length ? (
                <CardContent className="flex flex-wrap gap-2 border-t pt-3 text-[13px]">
                  {(order.invoices ?? []).map((invoice) => (
                    <span key={invoice.id} className="rounded-md bg-muted px-2 py-1">
                      Invoice {invoice.number} · {formatMoney(invoice.amount)}
                    </span>
                  ))}
                </CardContent>
              ) : null}
            </Card>

            {(order.fulfillments ?? []).length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Shipments</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(order.fulfillments ?? []).map((f) => (
                    <div key={f.id} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{f.number}</span>
                        <span className="text-xs text-muted-foreground">
                          From {f.location?.name} · {formatDateTime(f.createdAt)}
                        </span>
                      </div>
                      <ul className="mt-2 space-y-0.5 text-[13px]">
                        {(f.lines ?? []).map((l, i) => (
                          <li key={i}>
                            {l.quantity} × {l.orderLine?.name} <span className="text-muted-foreground">({l.orderLine?.sku})</span>
                          </li>
                        ))}
                      </ul>
                      {(f.tracking ?? []).length ? (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          {(f.tracking ?? []).map((t) => (
                            <a key={t.number} href={t.url ?? undefined} target="_blank" rel="noreferrer noopener" className="rounded bg-muted px-2 py-0.5 hover:underline">
                              {t.carrier} {t.number}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {f.shipment ? (
                        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>
                            Label by {f.shipment.providerTitle}
                            {f.shipment.cost ? ` · ${formatMoney(f.shipment.cost)}` : ""}
                          </span>
                          {f.shipment.labelUrl ? (
                            <a href={f.shipment.labelUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                              <Printer className="size-3.5" />
                              Print label
                            </a>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {(order.refunds ?? []).length ? (
              <Card>
                <CardHeader>
                  <CardTitle>Refunds</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(order.refunds ?? []).map((r) => (
                    <div key={r.id} className="rounded-lg border p-3 text-[13px]">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium">
                          {r.number} · {formatMoney(r.amount)}
                        </span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                      </div>
                      {r.reason ? <p className="mt-1 text-muted-foreground">{r.reason}</p> : null}
                      <ul className="mt-1 text-muted-foreground">
                        {(r.lines ?? []).map((l, i) => (
                          <li key={i}>
                            {l.quantity} × {l.orderLine?.name}
                            {l.restocked ? " (restocked)" : ""}
                          </li>
                        ))}
                        {Number(r.shippingAmount?.amount) > 0 ? <li>Shipping {formatMoney(r.shippingAmount)}</li> : null}
                      </ul>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                {write ? (
                  <form
                    className="mb-5 flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (note.trim()) addNote.mutate(note.trim());
                    }}
                  >
                    <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for your team…" rows={2} />
                    <Button type="submit" size="sm" variant="outline" className="self-end" loading={addNote.isPending} disabled={!note.trim()}>
                      <MessageSquarePlus />
                      Add note
                    </Button>
                  </form>
                ) : null}
                <ol className="relative space-y-4 border-l pl-5">
                  {[...(order.timeline ?? [])].reverse().map((event, i) => (
                    <li key={i} className="relative">
                      <span className={`absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-background ${event.type === "note" ? "bg-primary" : "bg-muted-foreground/50"}`} />
                      <p className="text-[13px]">{event.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                        {event.actorType === "staff" ? ` · ${staffName(event.actorId) ?? "Staff"}` : event.actorType && event.actorType !== "system" ? ` · ${humanize(event.actorType)}` : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </>
        }
        side={
          <>
            <Card>
              <CardHeader>
                <CardTitle>Customer</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-[13px]">
                {order.customer ? (
                  <Link to="/customers/$id" params={{ id: order.customer.id }} className="font-medium text-primary hover:underline">
                    {order.customer.firstName} {order.customer.lastName}
                  </Link>
                ) : (
                  <p className="font-medium">Guest checkout</p>
                )}
                <p>{order.email}</p>
                {order.customer?.group ? <p className="text-muted-foreground">Group: {order.customer.group.name}</p> : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <MapPin className="size-4 text-muted-foreground" /> Shipping address
                </CardTitle>
                {write && open && order.shippingAddress && order.fulfillmentStatus === "UNFULFILLED" ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => setDialog("shipping")} aria-label="Edit shipping address">
                    <Pencil />
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <Address address={order.shippingAddress} />
                {order.shippingMethod ? (
                  <p className="mt-3 text-[13px] text-muted-foreground">
                    {order.shippingMethod.name} · {order.shippingMethod.price?.formatted}
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Billing address</CardTitle>
                {write && open ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => setDialog("billing")} aria-label="Edit billing address">
                    <Pencil />
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                <Address address={order.billingAddress} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent>
                <dl>
                  <Detail label="Channel">{order.channel?.name}</Detail>
                  <Detail label="Currency">{order.currencyCode}</Detail>
                  <Detail label="Payment method">{order.paymentMethodCode}</Detail>
                  <Detail label="Coupons">{order.couponCodes?.length ? order.couponCodes.join(", ") : "—"}</Detail>
                  {order.completedAt ? <Detail label="Completed">{formatDateTime(order.completedAt)}</Detail> : null}
                  {order.canceledAt ? <Detail label="Canceled">{formatDateTime(order.canceledAt)}</Detail> : null}
                </dl>
              </CardContent>
            </Card>
            <PluginWidgets zone="order.detail" id={order.id} />
          </>
        }
      />

      {/* Mounted while open, so each opening starts from the order as it is now. */}
      {dialog === "capture" ? <CaptureDialog onClose={closeDialog} order={order} outstanding={outstanding} onDone={refresh} queue={queue} /> : null}
      {dialog === "fulfill" ? <FulfillDialog onClose={closeDialog} order={order} onDone={refresh} queue={queue} /> : null}
      {dialog === "refund" ? <RefundDialog onClose={closeDialog} order={order} onDone={refresh} /> : null}
      {dialog === "cancel" ? <CancelDialog onClose={closeDialog} order={order} onDone={refresh} /> : null}
      {dialog === "shipping" || dialog === "billing" ? <AddressDialog kind={dialog} onClose={closeDialog} order={order} onDone={refresh} /> : null}
    </Page>
  );
};

const Row = ({ label, value, strong, muted, tone }: { label: string; value: string; strong?: boolean; muted?: boolean; tone?: string }) => (
  <div className={`flex justify-between gap-4 ${strong ? "font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}>
    <dt>{label}</dt>
    <dd className={`tabular ${tone ?? ""}`}>{value}</dd>
  </div>
);

type DialogProps = { onClose: () => void; order: OrderDetail; onDone: () => Promise<unknown> };

const CaptureDialog = ({ onClose, order, outstanding, onDone, queue }: DialogProps & { outstanding: number; queue: OrderQueueNav | null }) => {
  const [amount, setAmount] = useState("");
  const capture = useAction(() => request(CaptureMutation, { orderId: order.id, amount: amount.trim() || null }).then((r) => unwrap(r.orderCapturePayment)), {
    onSuccess: () => {
      toast.success("Payment captured", nextOrderAction(queue));
      onClose();
      void onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dirty={!!amount.trim()}>
        <DialogHeader>
          <DialogTitle>Capture payment</DialogTitle>
          <DialogDescription>Charges the customer and creates an invoice. Leave the amount empty to capture everything outstanding.</DialogDescription>
        </DialogHeader>
        <Field label={`Amount (${order.currencyCode})`} hint={`Outstanding: ${money(outstanding, order.currencyCode ?? "USD")}`}>
          <Input inputMode="decimal" placeholder={outstanding.toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={capture.isPending} onClick={() => capture.mutate(undefined)}>
            <CreditCard />
            Capture
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const FulfillDialog = ({ onClose, order, onDone, queue }: DialogProps & { queue: OrderQueueNav | null }) => {
  const { stockLocations } = useReference();
  const lines = (order.lines ?? []).filter((l) => remaining(l) > 0);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [locationId, setLocationId] = useState("");
  const [tracking, setTracking] = useState({ carrier: "", number: "", url: "" });
  // Providers that can buy a label, the order's own first; that one is the default.
  const labelProviders = order.shipmentProviders ?? [];
  const [label, setLabel] = useState(labelProviders[0] && labelProviders[0].code === order.shippingMethod?.provider ? labelProviders[0].code! : "");
  const labelTitle = labelProviders.find((p) => p.code === label)?.title ?? labelProviders[0]?.title;
  const dirty = lines.some((l) => (quantities[l.id!] ?? remaining(l)) !== remaining(l)) || !!locationId || Object.values(tracking).some((v) => v.trim());
  const fulfill = useAction(
    () =>
      request(FulfillMutation, {
        orderId: order.id,
        input: {
          locationId: locationId || null,
          lines: lines.map((l) => ({ orderLineId: l.id!, quantity: quantities[l.id!] ?? remaining(l) })).filter((l) => l.quantity > 0),
          tracking: tracking.number ? [{ carrier: tracking.carrier || "Carrier", number: tracking.number, url: tracking.url || null }] : null,
          createShipment: label ? true : null,
          shipmentProvider: label || null,
        },
      }).then((r) => unwrap(r.orderFulfill)),
    {
      onSuccess: () => {
        toast.success(label ? "Label bought and shipment created" : "Shipment created", nextOrderAction(queue));
        onClose();
        void onDone();
      },
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide dirty={dirty}>
        <DialogHeader>
          <DialogTitle>Ship items</DialogTitle>
          <DialogDescription>Deducts stock at the chosen location and records the shipment.</DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead className="w-32 text-right">To ship</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id} className="hover:bg-transparent">
                <TableCell>
                  {l.name}
                  <p className="text-xs text-muted-foreground">
                    {l.sku} · {remaining(l)} left
                  </p>
                </TableCell>
                <TableCell className="text-right">
                  <Input type="number" min={0} max={remaining(l)} aria-label={`Quantity of ${l.name} to ship`} className="ml-auto h-8 w-20 text-right" value={quantities[l.id!] ?? remaining(l)} onChange={(e) => setQuantities({ ...quantities, [l.id!]: Math.min(remaining(l), Math.max(0, Number(e.target.value))) })} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {labelProviders.length ? (
          <div className="grid gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="font-normal">
                <Checkbox checked={!!label} onCheckedChange={(v) => setLabel(v === true ? (labelProviders[0]?.code ?? "") : "")} />
                {labelProviders.length > 1 && label ? "Buy a label with" : `Buy a label with ${labelTitle}`}
              </Label>
              {labelProviders.length > 1 && label ? (
                <NativeSelect value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-auto" aria-label="Label provider">
                  {labelProviders.map((p) => (
                    <option key={p.code} value={p.code ?? ""}>
                      {p.title}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {label
                ? `${labelTitle} buys the label first and its tracking number is added to the shipment. If buying fails, nothing is shipped.`
                : "Or ship without a label and enter the tracking number yourself."}
            </p>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ship from" hint="Defaults to the channel stock's first location.">
            <NativeSelect value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Default location</option>
              {stockLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Carrier">
            <Input value={tracking.carrier} onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })} placeholder="UPS, DHL, …" />
          </Field>
          <Field label="Tracking number" hint={label ? "Optional: the label brings its own." : undefined}>
            <Input value={tracking.number} onChange={(e) => setTracking({ ...tracking, number: e.target.value })} />
          </Field>
          <Field label="Tracking URL" hint={labelProviders.length ? "Filled in for carriers the shipping providers know." : undefined}>
            <Input type="url" value={tracking.url} onChange={(e) => setTracking({ ...tracking, url: e.target.value })} placeholder="https://" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={fulfill.isPending} onClick={() => fulfill.mutate(undefined)}>
            <Truck />
            {label ? "Buy label and ship" : "Create shipment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const RefundDialog = ({ onClose, order, onDone }: DialogProps) => {
  const lines = (order.lines ?? []).filter((l) => refundable(l) > 0);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [shipping, setShipping] = useState("");
  const [reason, setReason] = useState("");
  const paid = Number(order.totals?.paid?.amount ?? 0) - Number(order.totals?.refunded?.amount ?? 0);
  const refund = useAction(
    () =>
      request(RefundMutation, {
        orderId: order.id,
        input: {
          lines: lines.flatMap((l) => ((quantities[l.id!] ?? 0) > 0 ? [{ orderLineId: l.id!, quantity: quantities[l.id!]!, restock }] : [])),
          shippingAmount: shipping.trim() || null,
          reason: reason.trim() || null,
        },
      }).then((r) => unwrap(r.orderRefund)),
    {
      success: "Refund issued",
      onSuccess: () => {
        onClose();
        void onDone();
      },
    },
  );
  const nothing = Object.values(quantities).every((q) => !q) && !shipping.trim();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide dirty={!nothing || !restock || !!reason.trim()}>
        <DialogHeader>
          <DialogTitle>Refund</DialogTitle>
          <DialogDescription>Line amounts are prorated from what the customer paid, discounts and tax included.</DialogDescription>
        </DialogHeader>
        <Alert variant="info">Up to {money(paid, order.currencyCode ?? "USD")} can be refunded.</Alert>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead className="w-32 text-right">Quantity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.id} className="hover:bg-transparent">
                <TableCell>
                  {l.name}
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(l.unitPrice)} · up to {refundable(l)}
                  </p>
                </TableCell>
                <TableCell className="text-right">
                  <Input type="number" min={0} max={refundable(l)} aria-label={`Quantity of ${l.name} to refund`} className="ml-auto h-8 w-20 text-right" value={quantities[l.id!] ?? 0} onChange={(e) => setQuantities({ ...quantities, [l.id!]: Math.min(refundable(l), Math.max(0, Number(e.target.value))) })} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Label className="font-normal">
          <Checkbox checked={restock} onCheckedChange={(v) => setRestock(v === true)} />
          Put refunded items back in stock
        </Label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Shipping refund (${order.currencyCode})`} hint={`Shipping charged: ${formatMoney(order.totals?.shipping)}`}>
            <Input inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Reason">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged in transit" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={refund.isPending} disabled={nothing} onClick={() => refund.mutate(undefined)}>
            <RotateCcw />
            Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const CancelDialog = ({ onClose, order, onDone }: DialogProps) => {
  const [reason, setReason] = useState("");
  const cancel = useAction(() => request(CancelMutation, { orderId: order.id, reason: reason.trim() || null }).then((r) => unwrap(r.orderCancel)), {
    success: "Order canceled",
    onSuccess: () => {
      onClose();
      void onDone();
    },
  });
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onClose()} title={`Cancel order ${order.number}?`} description="Voids the payment authorization and releases reserved stock. This cannot be undone." destructive confirmLabel="Cancel order" loading={cancel.isPending} onConfirm={() => cancel.mutate(undefined)}>
      <Field label="Reason (optional)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
};

type AddressForm = Omit<AddressValue, "countryCode"> & { countryCode: string };

const ADDRESS_KEYS = ["firstName", "lastName", "company", "line1", "line2", "city", "region", "regionCode", "postalCode", "countryCode", "phone"] as const;

const AddressDialog = ({ onClose, order, onDone, kind }: DialogProps & { kind: "shipping" | "billing" }) => {
  const current = kind === "shipping" ? order.shippingAddress : order.billingAddress;
  // Empty fields as "", so clearing a field you typed in leaves the form unchanged.
  const form = useForm<AddressForm>({ defaultValues: Object.fromEntries(ADDRESS_KEYS.map((key) => [key, current?.[key] ?? ""])) as AddressForm });
  const save = useAction(
    (values: AddressForm) => {
      const address = Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== "__typename" && v !== "" && v !== null)) as AddressForm;
      return request(AddressMutation, { orderId: order.id, [kind === "shipping" ? "shippingAddress" : "billingAddress"]: address }).then((r) => unwrap(r.orderUpdateAddresses));
    },
    {
      success: "Address updated",
      onSuccess: () => {
        onClose();
        void onDone();
      },
      onError: (error) => reportError(error, form, ["input", kind === "shipping" ? "shippingAddress" : "billingAddress"]),
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>Edit {kind} address</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-3">
          <AddressFields form={form} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save address
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code), hint: code })).sort((a, b) => a.label.localeCompare(b.label));

/** The country is stored as its ISO code; `countries` (ISO codes) are listed first in its picker. */
export const AddressFields = ({ form, prefix = "", countries }: { form: ReturnType<typeof useForm<AddressForm>> | ReturnType<typeof useForm<any>>; prefix?: string; countries?: readonly string[] }) => {
  const f = form as ReturnType<typeof useForm<Record<string, string>>>;
  const name = (field: string) => `${prefix}${field}`;
  const countryKey = countries?.join(",") ?? "";
  const countryOptions = useMemo(() => {
    const first = new Set(countryKey.toUpperCase().split(",").filter(Boolean));
    return first.size ? [...COUNTRY_OPTIONS.filter((o) => first.has(o.value)), ...COUNTRY_OPTIONS.filter((o) => !first.has(o.value))] : COUNTRY_OPTIONS;
  }, [countryKey]);
  const err = (field: string) => {
    const parts = name(field).split(".");
    let node: unknown = f.formState.errors;
    for (const p of parts) node = (node as Record<string, unknown> | undefined)?.[p];
    return (node as { message?: string } | undefined)?.message;
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="First name" required error={err("firstName")}>
        <Input {...f.register(name("firstName"), { required: "Required" })} />
      </Field>
      <Field label="Last name" required error={err("lastName")}>
        <Input {...f.register(name("lastName"), { required: "Required" })} />
      </Field>
      <Field label="Company" className="sm:col-span-2" error={err("company")}>
        <Input {...f.register(name("company"))} />
      </Field>
      <Field label="Address" required className="sm:col-span-2" error={err("line1")}>
        <Input {...f.register(name("line1"), { required: "Required" })} />
      </Field>
      <Field label="Address line 2" className="sm:col-span-2" error={err("line2")}>
        <Input {...f.register(name("line2"))} />
      </Field>
      <Field label="City" required error={err("city")}>
        <Input {...f.register(name("city"), { required: "Required" })} />
      </Field>
      <Field label="Postal code" required error={err("postalCode")}>
        <Input {...f.register(name("postalCode"), { required: "Required" })} />
      </Field>
      <Field label="Region" hint="State, province or county" error={err("region")}>
        <Input {...f.register(name("region"))} />
      </Field>
      <Field label="Region code" hint="e.g. NY, BY" error={err("regionCode")}>
        <Input {...f.register(name("regionCode"))} />
      </Field>
      <Field label="Country" required hint="Search by name or ISO code" error={err("countryCode")}>
        <Controller
          control={f.control}
          name={name("countryCode")}
          rules={{ required: "Required", validate: (v) => !v || COUNTRY_CODES.includes(v) || "Pick a country from the list" }}
          render={({ field }) => <Combobox options={countryOptions} value={field.value ?? ""} onChange={field.onChange} placeholder="Pick a country" />}
        />
      </Field>
      <Field label="Phone" error={err("phone")}>
        <Input type="tel" {...f.register(name("phone"))} />
      </Field>
    </div>
  );
};
