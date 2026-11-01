import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, FileUp, Plus, SignpostBig, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { BulkActionDialog } from "@/components/bulk-action";
import { DataTable, fetchAllPages, type Column } from "@/components/data-table";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState } from "@/components/ui/feedback";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { useAction, useCursorPages, useListSearch } from "@/lib/hooks";

const RedirectsQuery = graphql(`
  query UrlRedirects($first: Int!, $after: String, $query: String) {
    urlRedirects(first: $first, after: $after, query: $query) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          fromPath
          toPath
          statusCode
          createdAt
        }
      }
    }
  }
`);

type Redirect = NonNullable<NonNullable<NonNullable<ResultOf<typeof RedirectsQuery>["urlRedirects"]>["edges"]>[number]>["node"] & {};

const CreateMutation = graphql(
  `
    mutation UrlRedirectCreate($input: UrlRedirectInput!) {
      urlRedirectCreate(input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const DeleteMutation = graphql(
  `
    mutation UrlRedirectDelete($id: ID!) {
      urlRedirectDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const STATUS: Record<number, string> = { 301: "Permanent", 302: "Temporary", 307: "Temporary, keeps method", 308: "Permanent, keeps method" };
const isExternal = (path: string | null | undefined) => !!path && /^https?:\/\//i.test(path);

export const RedirectsPage = () => {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [search] = useListSearch();
  const pages = useCursorPages();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<{ redirects: Redirect[]; done?: () => void } | null>(null);
  const write = can("catalog:write");

  const query = useQuery({
    queryKey: ["redirects", search.q ?? "", pages.after],
    queryFn: ({ signal }) => request(RedirectsQuery, { first: 50, after: pages.after, query: search.q ?? null }, { signal }),
    placeholderData: (previous) => previous,
  });
  const rows = (query.data?.urlRedirects?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["redirects"] });

  const columns: Column<Redirect>[] = [
    { id: "from", header: "From", fixed: true, cell: (r) => <code className="font-mono text-[13px]">{r.fromPath}</code>, csv: (r) => r.fromPath },
    {
      id: "to",
      header: "To",
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="font-mono text-[13px] break-all">{r.toPath}</code>
          {isExternal(r.toPath) ? (
            <a href={r.toPath!} target="_blank" rel="noreferrer noopener" aria-label="Open target" onClick={(e) => e.stopPropagation()} className="text-muted-foreground hover:text-foreground">
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </span>
      ),
      csv: (r) => r.toPath,
    },
    {
      id: "status",
      header: "Type",
      cell: (r) => (
        <Badge variant={r.statusCode === 301 || r.statusCode === 308 ? "secondary" : "outline"}>
          {r.statusCode} · {STATUS[r.statusCode ?? 0] ?? "Redirect"}
        </Badge>
      ),
      csv: (r) => r.statusCode,
    },
    { id: "created", header: "Created", cell: (r) => <span className="text-muted-foreground">{formatDate(r.createdAt)}</span>, csv: (r) => r.createdAt },
    ...(write
      ? [
          {
            id: "actions",
            header: "",
            fixed: true,
            align: "right" as const,
            cell: (r: Redirect) => (
              <Button variant="ghost" size="icon-sm" aria-label={`Delete redirect from ${r.fromPath}`} onClick={(e) => (e.stopPropagation(), setDeleting({ redirects: [r] }))}>
                <Trash2 />
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Page wide>
      <PageHeader
        title="Redirects"
        description="Send old storefront URLs to new ones. Changing a product or category slug adds one automatically; storefronts resolve them with the route query."
        actions={
          write ? (
            <>
              <Button variant="outline" onClick={() => setImporting(true)}>
                <FileUp />
                Import
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus />
                Add redirect
              </Button>
            </>
          ) : null
        }
      />
      <DataTable
        id="redirects"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id!}
        loading={query.isLoading}
        error={query.error}
        searchPlaceholder="Find a path"
        selectable={write}
        bulkActions={(selected, clear) => (
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDeleting({ redirects: selected, done: clear })}>
            <Trash2 />
            Delete
          </Button>
        )}
        total={query.data?.urlRedirects?.totalCount}
        pageInfo={query.data?.urlRedirects?.pageInfo}
        page={pages.page}
        onNext={pages.next}
        onPrev={pages.prev}
        exportName="redirects"
        fetchAll={() =>
          fetchAllPages(async (after) => {
            const data = await request(RedirectsQuery, { first: 100, after, query: search.q ?? null });
            return { nodes: (data.urlRedirects?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : [])), endCursor: data.urlRedirects?.pageInfo.endCursor ?? null, hasNextPage: !!data.urlRedirects?.pageInfo.hasNextPage };
          })
        }
        empty={
          !query.isLoading && rows.length === 0 && !search.q ? (
            <EmptyState icon={SignpostBig} title="No redirects yet" description="They appear here when slugs change, or add your own for moved or retired pages." />
          ) : undefined
        }
      />
      {creating ? <CreateDialog onClose={() => setCreating(false)} onSaved={refresh} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} onDone={refresh} /> : null}
      {deleting ? (
        <BulkActionDialog
          items={deleting.redirects}
          title={deleting.redirects.length === 1 ? `Delete the redirect from ${deleting.redirects[0]!.fromPath}?` : `Delete ${deleting.redirects.length} redirects?`}
          description="Visitors and search engines following the old URL will get a not-found page."
          noun={["redirect", "redirects"]}
          verbs={["Deleting", "Deleted"]}
          confirmLabel={deleting.redirects.length === 1 ? "Delete" : `Delete ${deleting.redirects.length} redirects`}
          destructive
          itemKey={(r) => r.id!}
          itemLabel={(r) => <code className="font-mono">{r.fromPath}</code>}
          run={async (r) => unwrap((await request(DeleteMutation, { id: r.id! })).urlRedirectDelete)}
          onClose={() => setDeleting(null)}
          onFinished={(outcome) => {
            void refresh();
            // Redirects that could not be deleted stay selected, ready for another try.
            if (!outcome.failed.length && !outcome.stopped) deleting.done?.();
          }}
        />
      ) : null}
    </Page>
  );
};

type RedirectForm = { fromPath: string; toPath: string; statusCode: string };

/** A storefront path; a pasted full storefront URL keeps only its path. */
const toStorefrontPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (isExternal(trimmed)) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed;
    }
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const toTarget = (value: string) => (isExternal(value.trim()) ? value.trim() : toStorefrontPath(value));

const CreateDialog = ({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<unknown> }) => {
  const form = useForm<RedirectForm>({ defaultValues: { fromPath: "", toPath: "", statusCode: "301" } });
  const save = useAction(
    (v: RedirectForm) => {
      return request(CreateMutation, { input: { fromPath: toStorefrontPath(v.fromPath), toPath: toTarget(v.toPath), statusCode: Number(v.statusCode) } }).then((r) => unwrap(r.urlRedirectCreate));
    },
    {
      success: "Redirect added",
      onSuccess: () => {
        onClose();
        void onSaved();
      },
      onError: (error) => reportError(error, form),
    },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>Add redirect</DialogTitle>
          <DialogDescription>Paths are relative to the storefront root. A full URL as the target sends visitors to another site.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <Field label="From path" required error={form.formState.errors.fromPath?.message}>
            <Input autoFocus className="font-mono" placeholder="/old-collection" {...form.register("fromPath", { required: "Required" })} />
          </Field>
          <Field label="To path or URL" required error={form.formState.errors.toPath?.message}>
            <Input className="font-mono" placeholder="/new-collection or https://…" {...form.register("toPath", { required: "Required" })} />
          </Field>
          <Field label="Type" hint="Use 301 for moves search engines should remember, 302 for temporary ones.">
            <NativeSelect {...form.register("statusCode")}>
              {Object.entries(STATUS).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} · {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Add redirect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Paste `from,to[,status]` lines, e.g. from a spreadsheet or an old site's export. */
const ImportDialog = ({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<unknown> }) => {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: number; failed: string[] } | null>(null);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^from[,;\t]/i.test(line));
  const parsed = lines.map((line) => {
    const [from = "", to = "", status = "301"] = line.split(/[,;\t]/).map((cell) => cell.trim().replace(/^"|"$/g, ""));
    return { fromPath: toStorefrontPath(from), toPath: toTarget(to), statusCode: Number(status) || 301 };
  });

  const run = async () => {
    setRunning(true);
    let ok = 0;
    const failed: string[] = [];
    for (const row of parsed) {
      try {
        unwrap((await request(CreateMutation, { input: row })).urlRedirectCreate);
        ok++;
      } catch (error) {
        failed.push(`${row.fromPath}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    setRunning(false);
    setResult({ ok, failed });
    await onDone();
    if (ok) toast.success(`Imported ${ok} redirect${ok === 1 ? "" : "s"}`);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide dirty={!result && !!text.trim()}>
        <DialogHeader>
          <DialogTitle>Import redirects</DialogTitle>
          <DialogDescription>One redirect per line as from,to or from,to,status. A header line starting with "from" is ignored.</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-3">
            <Alert variant={result.failed.length ? "warning" : "success"} title={`Imported ${result.ok} of ${parsed.length}`}>
              {result.failed.length ? (
                <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-4">
                  {result.failed.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              ) : (
                "Every line was imported."
              )}
            </Alert>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-3">
            <Textarea rows={10} className="font-mono text-xs" placeholder={"/old-page,/new-page\n/sale-2025,/sale,302\n/blog,https://blog.example.com"} value={text} onChange={(e) => setText(e.target.value)} />
            <p className="text-xs text-muted-foreground">{parsed.length ? `${parsed.length} redirect${parsed.length === 1 ? "" : "s"} ready to import.` : "Nothing to import yet."}</p>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!parsed.length} loading={running} onClick={() => void run()}>
                <FileUp />
                Import {parsed.length || ""}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
