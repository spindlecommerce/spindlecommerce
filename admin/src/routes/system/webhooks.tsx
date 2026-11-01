import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, RotateCw, Webhook } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { DataTable, FilterSelect, type Column } from "@/components/data-table";
import { Field, reportError } from "@/components/form";
import { JsonView } from "@/components/inputs";
import { Page, PageHeader } from "@/components/layout/page";
import { BooleanBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { SectionTabsList, SectionTabsTrigger, Switch, Tabs, TabsContent } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Sheet, SheetContent, Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { copyText, useAction, useCursorPages, useListSearch } from "@/lib/hooks";
import type { ListSearch } from "@/router";
import { Chips, ParamFilter, RowActions, SettingsCard } from "../settings/shared";

const WebhooksQuery = graphql(`
  query Webhooks {
    webhookSubscriptions {
      id
      name
      url
      events
      isActive
      createdAt
    }
    eventTypes
  }
`);

const DeliveriesQuery = graphql(`
  query WebhookDeliveries($first: Int!, $after: String, $status: WebhookDeliveryStatus, $subscriptionId: ID) {
    webhookDeliveries(first: $first, after: $after, status: $status, subscriptionId: $subscriptionId) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          eventType
          status
          attempts
          lastStatusCode
          lastError
          nextAttemptAt
          deliveredAt
          createdAt
          subscription {
            id
            name
            url
          }
        }
      }
    }
  }
`);

const DeliveryPayloadQuery = graphql(`
  query WebhookDeliveryPayload($id: ID!) {
    node(id: $id) {
      ... on WebhookDelivery {
        id
        payload
      }
    }
  }
`);

type Subscription = NonNullable<ResultOf<typeof WebhooksQuery>["webhookSubscriptions"]>[number];
type Delivery = NonNullable<NonNullable<NonNullable<ResultOf<typeof DeliveriesQuery>["webhookDeliveries"]>["edges"]>[number]>["node"] & {};

const SubscriptionCreate = graphql(
  `
    mutation WebhookSubscriptionCreate($name: String!, $url: String!, $events: [String!]!) {
      webhookSubscriptionCreate(name: $name, url: $url, events: $events) {
        __typename
        ... on WebhookSubscriptionCreatePayload {
          secret
          webhookSubscription {
            name
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const SubscriptionUpdate = graphql(
  `
    mutation WebhookSubscriptionUpdate($id: ID!, $name: String, $url: String, $events: [String!], $isActive: Boolean) {
      webhookSubscriptionUpdate(id: $id, name: $name, url: $url, events: $events, isActive: $isActive) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const SubscriptionDelete = graphql(`mutation WebhookSubscriptionDelete($id: ID!) { webhookSubscriptionDelete(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);
const DeliveryRetry = graphql(`mutation WebhookDeliveryRetry($id: ID!) { webhookDeliveryRetry(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);

/** Every event type, plus `area.*` prefixes and `*` for everything. */
const eventOptions = (types: readonly string[]) => [
  { value: "*", label: "Every event", hint: "*" },
  ...[...new Set(types.map((t) => t.split(".")[0]!))].sort().map((prefix) => ({ value: `${prefix}.*`, label: `All ${prefix} events`, hint: `${prefix}.*` })),
  ...[...types].sort().map((t) => ({ value: t, label: t })),
];

export const WebhooksPage = () => {
  const { can } = useAuth();
  const [search, setSearch] = useListSearch();
  const query = useQuery({ queryKey: ["webhooks"], queryFn: () => request(WebhooksQuery) });
  const [editing, setEditing] = useState<Subscription | "new" | null>(null);
  const [deleting, setDeleting] = useState<Subscription | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const write = can("integrations:write");
  const tab = search.tab ?? "subscriptions";
  const subscriptions = query.data?.webhookSubscriptions ?? [];

  const remove = useAction((id: string) => request(SubscriptionDelete, { id }).then((r) => unwrap(r.webhookSubscriptionDelete)), {
    success: "Subscription deleted",
    invalidate: [["webhooks"], ["webhook-deliveries"]],
    onSuccess: () => setDeleting(null),
  });

  return (
    <Page wide>
      <PageHeader
        title="Webhooks"
        description="POSTs a signed JSON body to your endpoint for each matching event, after the change commits. Failed deliveries retry with backoff."
        actions={
          write ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add subscription
            </Button>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value === "subscriptions" ? undefined : value, status: undefined })}>
        <SectionTabsList className="mb-5">
          <SectionTabsTrigger value="subscriptions">Subscriptions</SectionTabsTrigger>
          <SectionTabsTrigger value="deliveries">Deliveries</SectionTabsTrigger>
        </SectionTabsList>
        <TabsContent value="subscriptions">
          <SettingsCard title="Subscriptions" description="Patterns such as order.* match every event with that prefix.">
            {query.isLoading ? (
              <div className="space-y-2 px-5 pb-5">
                <Skeleton className="h-10" />
              </div>
            ) : subscriptions.length === 0 ? (
              <EmptyState icon={Webhook} title="No webhook subscriptions" description="Subscribe an ERP, email service or warehouse system to the events it needs." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Subscription</TableHead>
                    <TableHead>Events</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <span className="font-medium">{s.name}</span>
                        <p className="max-w-md truncate font-mono text-xs text-muted-foreground">{s.url}</p>
                      </TableCell>
                      <TableCell>
                        <Chips items={s.events ?? []} max={4} />
                      </TableCell>
                      <TableCell>
                        <BooleanBadge value={s.isActive} on="Active" off="Paused" />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{relativeTime(s.createdAt)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setSearch({ tab: "deliveries", subscription: s.id } as Partial<ListSearch>)}>
                            Deliveries
                          </Button>
                          {write ? <RowActions onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} /> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsCard>
        </TabsContent>
        <TabsContent value="deliveries">
          <Deliveries subscriptions={subscriptions} write={write} />
        </TabsContent>
      </Tabs>
      {editing !== null ? (
        <SubscriptionDialog
          key={editing === "new" ? "new" : editing.id}
          subscription={editing === "new" ? null : editing}
          eventTypes={query.data?.eventTypes ?? []}
          onClose={() => setEditing(null)}
          onCreated={(created) => {
            setEditing(null);
            setSecret(created);
          }}
        />
      ) : null}
      <SecretDialog value={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "subscription"}?`}
        description="Pending deliveries for it are dropped. To stop temporarily, pause it instead."
        destructive
        confirmLabel="Delete subscription"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  );
};

type SubscriptionForm = { name: string; url: string; events: string[]; isActive: boolean };

const SubscriptionDialog = ({
  subscription,
  eventTypes,
  onClose,
  onCreated,
}: {
  subscription: Subscription | null;
  eventTypes: readonly string[];
  onClose: () => void;
  onCreated: (created: { name: string; secret: string }) => void;
}) => {
  const form = useForm<SubscriptionForm>({
    defaultValues: { name: subscription?.name ?? "", url: subscription?.url ?? "", events: subscription?.events ?? [], isActive: subscription?.isActive ?? true },
  });
  const save = useAction(
    async (v: SubscriptionForm) => {
      if (subscription) {
        unwrap((await request(SubscriptionUpdate, { id: subscription.id, name: v.name.trim(), url: v.url.trim(), events: v.events, isActive: v.isActive })).webhookSubscriptionUpdate);
        return null;
      }
      const payload = unwrap((await request(SubscriptionCreate, { name: v.name.trim(), url: v.url.trim(), events: v.events })).webhookSubscriptionCreate);
      return { name: payload.webhookSubscription?.name ?? v.name, secret: payload.secret ?? "" };
    },
    {
      success: subscription ? "Subscription saved" : undefined,
      invalidate: [["webhooks"]],
      onSuccess: (created) => (created ? onCreated(created) : onClose()),
      onError: (error) => reportError(error, form, []),
    },
  );
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{subscription ? `Edit ${subscription.name}` : "New webhook subscription"}</DialogTitle>
          <DialogDescription>Endpoints must be public HTTPS URLs unless private URLs are allowed for development.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <Field label="Name" required error={errors.name?.message}>
            <Input placeholder="Email service" {...form.register("name", { required: "Required" })} />
          </Field>
          <Field label="Endpoint URL" required error={errors.url?.message}>
            <Input type="url" className="font-mono" placeholder="https://hooks.example.com/ecom" {...form.register("url", { required: "Required" })} />
          </Field>
          <Field label="Events" required error={errors.events?.message}>
            <Controller
              control={form.control}
              name="events"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one event" }}
              render={({ field }) => <MultiSelect options={eventOptions(eventTypes)} value={field.value} onChange={field.onChange} placeholder="Pick events" searchPlaceholder="Search events…" />}
            />
          </Field>
          {subscription ? (
            <Label className="font-normal">
              <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
              Active — paused subscriptions get no new deliveries
            </Label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {subscription ? "Save subscription" : "Create subscription"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// header: X-Spindle-Signature: t=<unix seconds>,v1=<hex>
const verify = (secret, rawBody, header) => {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
};`;

const SecretDialog = ({ value, onClose }: { value: { name: string; secret: string } | null; onClose: () => void }) => (
  <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
    <DialogContent wide onInteractOutside={(e) => e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>Signing secret for {value?.name}</DialogTitle>
        <DialogDescription>Use it to verify that deliveries come from this store.</DialogDescription>
      </DialogHeader>
      <Alert variant="warning" title="This is the only time the secret is shown">
        Store it with the receiving service now. Delete and recreate the subscription to get a new one.
      </Alert>
      <div className="flex gap-2">
        <Input readOnly value={value?.secret ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={() => value && void copyText(value.secret, "Secret copied")}>
          <Copy />
          Copy
        </Button>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Each request carries <code className="rounded bg-muted px-1 font-mono text-xs">X-Spindle-Signature: t=…,v1=…</code> where v1 is HMAC-SHA256(secret, "&lt;t&gt;.&lt;body&gt;") in hex. Reject stale timestamps.
      </p>
      <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{VERIFY}</pre>
      <DialogFooter>
        <Button onClick={onClose}>I have stored the secret</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

// ---------------------------------------------------------------- deliveries

const Deliveries = ({ subscriptions, write }: { subscriptions: Subscription[]; write: boolean }) => {
  const queryClient = useQueryClient();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const [open, setOpen] = useState<Delivery | null>(null);
  const subscriptionId = (search as Record<string, string | undefined>).subscription;
  const status = (search.status as "PENDING" | "SUCCEEDED" | "FAILED" | "DEAD" | undefined) ?? null;
  const variables = { first: 25, after: pages.after, status, subscriptionId: subscriptionId ?? null };
  const query = useQuery({
    queryKey: ["webhook-deliveries", variables],
    queryFn: ({ signal }) => request(DeliveriesQuery, variables, { signal }),
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
  });
  const retry = useAction((id: string) => request(DeliveryRetry, { id }).then((r) => unwrap(r.webhookDeliveryRetry)), {
    success: "Queued for another attempt",
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] }),
  });
  const rows = (query.data?.webhookDeliveries?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

  const columns: Column<Delivery>[] = [
    { id: "event", header: "Event", fixed: true, cell: (d) => <span className="font-mono text-[13px]">{d.eventType}</span>, csv: (d) => d.eventType },
    { id: "subscription", header: "Subscription", cell: (d) => d.subscription?.name ?? "—", csv: (d) => d.subscription?.name },
    { id: "status", header: "Status", cell: (d) => <StatusBadge value={d.status} />, csv: (d) => d.status },
    { id: "attempts", header: "Attempts", align: "right", cell: (d) => d.attempts, csv: (d) => d.attempts },
    {
      id: "response",
      header: "Last response",
      cell: (d) =>
        d.lastStatusCode || d.lastError ? (
          <Tooltip content={d.lastError ?? `HTTP ${d.lastStatusCode}`}>
            <span className="max-w-56 truncate text-[13px] text-muted-foreground">{d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : d.lastError}</span>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      csv: (d) => d.lastStatusCode ?? d.lastError,
    },
    {
      id: "when",
      header: "Delivered / next attempt",
      cell: (d) => <span className="text-muted-foreground">{d.deliveredAt ? `Delivered ${relativeTime(d.deliveredAt)}` : d.status === "DEAD" ? "Gave up" : `Next ${relativeTime(d.nextAttemptAt)}`}</span>,
      csv: (d) => d.deliveredAt ?? d.nextAttemptAt,
    },
    { id: "created", header: "Created", cell: (d) => <span className="text-muted-foreground">{relativeTime(d.createdAt)}</span>, csv: (d) => d.createdAt },
  ];

  return (
    <>
      <DataTable
        id="webhook-deliveries"
        rows={rows}
        columns={columns}
        rowKey={(d) => d.id}
        loading={query.isLoading}
        error={query.error}
        searchable={false}
        onRowClick={setOpen}
        total={query.data?.webhookDeliveries?.totalCount}
        pageInfo={query.data?.webhookDeliveries?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="webhook-deliveries"
        filters={
          <>
            <FilterSelect
              param="status"
              label="Status"
              options={[
                { value: "PENDING", label: "Pending" },
                { value: "SUCCEEDED", label: "Succeeded" },
                { value: "FAILED", label: "Failed (retrying)" },
                { value: "DEAD", label: "Dead (gave up)" },
              ]}
            />
            <ParamFilter param="subscription" label="Subscription" options={subscriptions.map((s) => ({ value: s.id, label: s.name ?? s.url ?? "" }))} />
          </>
        }
        empty={<EmptyState icon={Webhook} title="No deliveries" description="Deliveries appear when subscribed events happen." />}
      />
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent aria-describedby={undefined}>{open ? <DeliveryDetail delivery={rows.find((r) => r.id === open.id) ?? open} write={write} retry={retry} /> : null}</SheetContent>
      </Sheet>
    </>
  );
};

const DeliveryDetail = ({ delivery, write, retry }: { delivery: Delivery; write: boolean; retry: { mutate: (id: string) => void; isPending: boolean } }) => {
  const payload = useQuery({ queryKey: ["webhook-delivery-payload", delivery.id], queryFn: () => request(DeliveryPayloadQuery, { id: delivery.id }) });
  const body = payload.data?.node && "payload" in payload.data.node ? payload.data.node.payload : null;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-mono text-base font-semibold">{delivery.eventType}</h2>
        <p className="text-[13px] text-muted-foreground">to {delivery.subscription?.url}</p>
      </div>
      <dl>
        <Detail label="Status">
          <StatusBadge value={delivery.status} />
        </Detail>
        <Detail label="Attempts">{delivery.attempts}</Detail>
        <Detail label="Last response">{delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : "—"}</Detail>
        {delivery.lastError ? <Detail label="Last error">{delivery.lastError}</Detail> : null}
        <Detail label="Created">{formatDateTime(delivery.createdAt)}</Detail>
        <Detail label="Delivered">{delivery.deliveredAt ? formatDateTime(delivery.deliveredAt) : "—"}</Detail>
        {!delivery.deliveredAt && delivery.status !== "DEAD" ? <Detail label="Next attempt">{formatDateTime(delivery.nextAttemptAt)}</Detail> : null}
      </dl>
      {write && (delivery.status === "FAILED" || delivery.status === "DEAD") ? (
        <Button variant="outline" className="self-start" loading={retry.isPending} onClick={() => retry.mutate(delivery.id)}>
          <RotateCw />
          Retry now
        </Button>
      ) : null}
      <div>
        <p className="mb-2 text-sm font-semibold">Body</p>
        {payload.isLoading ? <Skeleton className="h-40" /> : body ? <JsonView value={body} /> : <p className="text-[13px] text-muted-foreground">The event is no longer available.</p>}
        <p className="mt-2 text-xs text-muted-foreground">Secrets such as password reset tokens are redacted here; the real request carries them.</p>
      </div>
    </div>
  );
};
