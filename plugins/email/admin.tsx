import { Eye, Mail, Send } from "lucide-react";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  defineAdminPlugin,
  Detail,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  EmptyState,
  ErrorFields,
  Field,
  formatDateTime,
  graphql,
  Input,
  keepPreviousData,
  Link,
  Page,
  PageHeader,
  relativeTime,
  request,
  Select,
  Sheet,
  SheetContent,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  Tooltip,
  unwrap,
  useAction,
  useAuth,
  useCursorPages,
  useDebounced,
  useListSearch,
  useQuery,
  type BadgeVariant,
  type Column,
  type ResultOf,
  type VariablesOf,
} from "@ecom/admin";

const MessagesQuery = graphql(`
  query EmailMessages($first: Int!, $after: String, $query: String, $status: EmailMessageStatus, $template: EmailTemplate) {
    emailMessages(first: $first, after: $after, query: $query, status: $status, template: $template) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          template
          to
          subject
          status
          provider
          providerMessageId
          error
          orderNumber
          createdAt
        }
      }
    }
  }
`);

const MessageQuery = graphql(`
  query EmailMessage($id: ID!) {
    emailMessage(id: $id) {
      id
      html
      text
    }
  }
`);

const PreviewQuery = graphql(`
  query EmailPreview($template: EmailTemplate!, $orderNumber: String, $locale: LocaleCode) {
    emailPreview(template: $template, orderNumber: $orderNumber, locale: $locale) {
      subject
      html
      text
    }
  }
`);

const SendTestMutation = graphql(
  `
    mutation EmailSendTest($to: EmailAddress!) {
      emailSendTest(to: $to) {
        __typename
        ... on EmailSendTestPayload {
          emailMessage {
            id
            to
            status
            error
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** The plugin's transport, for staff who may read settings. */
const TransportQuery = graphql(`
  query EmailTransport {
    plugin(name: "email") {
      settings {
        key
        value
      }
    }
  }
`);

type Message = NonNullable<NonNullable<NonNullable<ResultOf<typeof MessagesQuery>["emailMessages"]>["edges"]>[number]>["node"] & {};
type Template = VariablesOf<typeof PreviewQuery>["template"];
type Status = NonNullable<VariablesOf<typeof MessagesQuery>["status"]>;

const TEMPLATES: readonly { value: Template; label: string }[] = [
  { value: "ORDER_CONFIRMATION", label: "Order confirmation" },
  { value: "ORDER_SHIPPED", label: "Shipped" },
  { value: "ORDER_REFUNDED", label: "Refunded" },
  { value: "ORDER_CANCELED", label: "Canceled" },
  { value: "CUSTOMER_PASSWORD_RESET", label: "Customer password reset" },
  { value: "STAFF_PASSWORD_RESET", label: "Staff password reset" },
  { value: "STAFF_NEW_ORDER", label: "New order (staff)" },
  { value: "LOW_STOCK", label: "Low stock (staff)" },
  { value: "TEST", label: "Test email" },
];
const STATUSES: readonly { value: Status; label: string; tone: BadgeVariant }[] = [
  { value: "SENT", label: "Sent", tone: "success" },
  { value: "LOGGED", label: "Logged", tone: "secondary" },
  { value: "FAILED", label: "Failed", tone: "destructive" },
];
const LOCALES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "de-DE", label: "German" },
  { value: "fr-FR", label: "French" },
];

const templateLabel = (value: string | null | undefined) => TEMPLATES.find((t) => t.value === value)?.label ?? value ?? "—";

const StatusBadge = ({ message }: { message: Pick<Message, "status" | "error"> }) => {
  const status = STATUSES.find((s) => s.value === message.status);
  const badge = (
    <Badge variant={status?.tone ?? "secondary"} dot>
      {status?.label ?? message.status}
    </Badge>
  );
  return message.error ? <Tooltip content={message.error}>{badge}</Tooltip> : badge;
};

/** A filter in the list's toolbar, kept in the URL like the admin's own lists. */
const Filter = ({ param, label, options }: { param: "status" | "type"; label: string; options: readonly { value: string; label: string }[] }) => {
  const [search, set] = useListSearch();
  const value = search[param] ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={value ? "secondary" : "outline"} size="sm">
          {label}
          {value ? <span className="font-normal text-muted-foreground">: {options.find((o) => o.value === value)?.label ?? value}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuCheckboxItem checked={!value} onCheckedChange={() => set({ [param]: undefined })}>
          Any
        </DropdownMenuCheckboxItem>
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.value} checked={value === o.value} onCheckedChange={() => set({ [param]: o.value })}>
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Sandboxed: no scripts or access to the admin. Links open in a new tab via a base target. */
const EmailFrame = ({ html, title }: { html: string; title: string }) => (
  <iframe
    title={title}
    sandbox="allow-popups allow-popups-to-escape-sandbox"
    srcDoc={html.replace(/<head>/i, '<head><base target="_blank">')}
    className="h-[34rem] w-full rounded-lg border bg-white"
  />
);

const Rendered = ({ html, text, title, loading }: { html: string | null | undefined; text: string | null | undefined; title: string; loading?: boolean }) => (
  <Tabs defaultValue="html" className="flex flex-col gap-3">
    <TabsList>
      <TabsTrigger value="html">Email</TabsTrigger>
      <TabsTrigger value="text">Plain text</TabsTrigger>
    </TabsList>
    <TabsContent value="html">{loading || html == null ? <Skeleton className="h-[34rem] w-full" /> : <EmailFrame html={html} title={title} />}</TabsContent>
    <TabsContent value="text">
      {loading || text == null ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <pre className="max-h-[34rem] overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{text}</pre>
      )}
    </TabsContent>
  </Tabs>
);

const MessageSheet = ({ message, onClose }: { message: Message | null; onClose: () => void }) => {
  const body = useQuery({
    queryKey: ["email", "message", message?.id],
    queryFn: () => request(MessageQuery, { id: message!.id! }),
    enabled: !!message?.id,
    staleTime: Infinity,
  });
  return (
    <Sheet open={!!message} onOpenChange={(open) => !open && onClose()}>
      <SheetContent aria-describedby={undefined} className="sm:w-[42rem] sm:max-w-[42rem]">
        {message ? (
          <div className="flex flex-col gap-5">
            <div className="pr-8">
              <h2 className="text-base font-semibold">{message.subject}</h2>
              <p className="text-[13px] text-muted-foreground">
                To {message.to} · {formatDateTime(message.createdAt)}
              </p>
            </div>
            {message.error ? (
              <Alert variant="destructive" title="Not sent">
                {message.error}
              </Alert>
            ) : null}
            <dl>
              <Detail label="Status">
                <StatusBadge message={{ ...message, error: null }} />
              </Detail>
              <Detail label="Template">{templateLabel(message.template)}</Detail>
              <Detail label="Provider">
                {message.provider === "log" ? "Log only (not sent)" : message.provider}
                {message.providerMessageId ? <span className="ml-2 font-mono text-xs break-all text-muted-foreground">{message.providerMessageId}</span> : null}
              </Detail>
              {message.orderNumber ? (
                <Detail label="Order">
                  <Link to="/orders/$number" params={{ number: message.orderNumber }} className="text-primary hover:underline">
                    {message.orderNumber}
                  </Link>
                </Detail>
              ) : null}
            </dl>
            <Rendered html={body.data?.emailMessage?.html} text={body.data?.emailMessage?.text} title={message.subject ?? "Email"} loading={body.isLoading} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
};

/** Any template in any language, from an order or sample data, without sending it. */
const PreviewDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const [template, setTemplate] = useState<Template>("ORDER_CONFIRMATION");
  const [locale, setLocale] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const number = useDebounced(orderNumber.trim(), 400);
  const preview = useQuery({
    queryKey: ["email", "preview", template, locale, number],
    queryFn: () => request(PreviewQuery, { template, locale: locale || null, orderNumber: number || null }),
    enabled: open,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const rendered = preview.data?.emailPreview;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Preview templates</DialogTitle>
          <DialogDescription>Rendered with the current settings. Nothing is sent.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Template">
            <Select value={template} onValueChange={(v) => setTemplate(v as Template)} options={TEMPLATES} />
          </Field>
          <Field label="Language" hint="Default: the order's, else the channel's">
            <Select value={locale} onValueChange={setLocale} options={LOCALES} allowEmpty emptyLabel="Default" />
          </Field>
          <Field label="Order number" hint="Empty: sample data">
            <Input value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="US-000123" />
          </Field>
        </div>
        {preview.error ? (
          <Alert variant="destructive">{preview.error instanceof Error ? preview.error.message : "The preview failed"}</Alert>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <span className="text-muted-foreground">Subject:</span> {rendered?.subject ?? "…"}
            </p>
            <Rendered html={rendered?.html} text={rendered?.text} title="Template preview" loading={preview.isLoading} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

const SendTestDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const { viewer } = useAuth();
  const [to, setTo] = useState(viewer?.staffUser?.email ?? "");
  const send = useAction(async (address: string) => unwrap((await request(SendTestMutation, { to: address })).emailSendTest), {
    invalidate: [["email", "messages"]],
    onSuccess: ({ emailMessage: message }) => {
      if (message?.status === "FAILED") toast.error("The test email was not sent", { description: message.error ?? undefined });
      else if (message?.status === "LOGGED") toast.success("Logged, not sent", { description: "The transport is Log only: choose Resend or Postmark in the plugin settings to send." });
      else toast.success(`Test email sent to ${message?.to}`);
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (to.trim()) send.mutate(to.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Send a test email</DialogTitle>
            <DialogDescription>A short email through the active transport. It shows in the log like any other.</DialogDescription>
          </DialogHeader>
          <Field label="To" required>
            <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!to.trim() || send.isPending}>
              <Send />
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** The message log, kept 30 days. */
const EmailsPage = () => {
  const { can } = useAuth();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const [open, setOpen] = useState<Message | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [testing, setTesting] = useState(false);
  const variables = {
    first: 50,
    after: pages.after,
    query: search.q?.trim() || null,
    status: (STATUSES.find((s) => s.value === search.status)?.value ?? null) as Status | null,
    template: (TEMPLATES.find((t) => t.value === search.type)?.value ?? null) as Template | null,
  };
  const query = useQuery({
    queryKey: ["email", "messages", variables],
    queryFn: ({ signal }) => request(MessagesQuery, variables, { signal }),
    placeholderData: keepPreviousData,
  });
  const transport = useQuery({ queryKey: ["email", "transport"], queryFn: () => request(TransportQuery), enabled: can("settings:read"), staleTime: 60_000 });
  const logOnly = transport.data?.plugin?.settings?.find((s) => s.key === "transport")?.value === "log";
  const rows = (query.data?.emailMessages?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));

  const columns: Column<Message>[] = [
    {
      id: "time",
      header: "Time",
      cell: (m) => (
        <Tooltip content={formatDateTime(m.createdAt)}>
          <span className="whitespace-nowrap text-muted-foreground">{relativeTime(m.createdAt)}</span>
        </Tooltip>
      ),
      csv: (m) => m.createdAt,
    },
    // Min and max widths: an address never wraps a letter per line, and a long one truncates.
    { id: "to", header: "To", fixed: true, cell: (m) => <span className="block min-w-40 max-w-64 truncate" title={m.to ?? undefined}>{m.to}</span>, csv: (m) => m.to },
    { id: "subject", header: "Subject", cell: (m) => <span className="line-clamp-1">{m.subject}</span>, csv: (m) => m.subject },
    { id: "template", header: "Template", cell: (m) => templateLabel(m.template), csv: (m) => m.template },
    { id: "status", header: "Status", cell: (m) => <StatusBadge message={m} />, csv: (m) => m.status },
    {
      id: "order",
      header: "Order",
      cell: (m) =>
        m.orderNumber ? (
          <Link to="/orders/$number" params={{ number: m.orderNumber }} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
            {m.orderNumber}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      csv: (m) => m.orderNumber,
    },
    { id: "provider", header: "Provider", hidden: true, cell: (m) => m.provider, csv: (m) => m.provider },
    { id: "error", header: "Error", hidden: true, cell: (m) => <span className="text-xs text-muted-foreground">{m.error ?? "—"}</span>, csv: (m) => m.error },
  ];

  return (
    <Page wide>
      <PageHeader
        title="Emails"
        description="Every email of the last 30 days: sent, only logged, or failed. Failed emails are retried for about an hour."
        actions={
          <>
            <Button variant="outline" onClick={() => setPreviewing(true)}>
              <Eye />
              Preview templates
            </Button>
            {can("email:send") ? (
              <Button onClick={() => setTesting(true)}>
                <Send />
                Send test email
              </Button>
            ) : null}
          </>
        }
      />
      {logOnly ? (
        <Alert variant="info" title="Emails are logged, not sent" className="mb-4">
          The transport is Log only. Choose Resend or Postmark in{" "}
          <Link to="/settings/plugins/$name" params={{ name: "email" }} className="font-medium underline">
            the plugin settings
          </Link>{" "}
          to send them.
        </Alert>
      ) : null}
      <DataTable
        id="email-messages"
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id ?? `${m.createdAt}${m.to}`}
        loading={query.isLoading}
        error={query.error}
        onRowClick={setOpen}
        searchPlaceholder="Recipient, subject or order number"
        total={query.data?.emailMessages?.totalCount}
        pageInfo={query.data?.emailMessages?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="emails"
        filters={
          <>
            <Filter param="status" label="Status" options={STATUSES} />
            <Filter param="type" label="Template" options={TEMPLATES} />
          </>
        }
        empty={<EmptyState icon={Mail} title="No emails yet" description="Emails show here once orders are placed, shipped or refunded, or someone asks for a password reset." />}
      />
      <MessageSheet message={open} onClose={() => setOpen(null)} />
      <PreviewDialog open={previewing} onOpenChange={setPreviewing} />
      {testing ? <SendTestDialog open={testing} onOpenChange={setTesting} /> : null}
    </Page>
  );
};

export default defineAdminPlugin({
  pages: [
    {
      path: "",
      title: "Emails",
      component: EmailsPage,
      nav: { label: "Emails", group: "Settings", icon: Mail, permission: "email:read", keywords: "email log notifications resend postmark templates preview test" },
    },
  ],
});
