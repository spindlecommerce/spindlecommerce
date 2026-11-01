import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, CalendarClock, CalendarX2, Check, CircleCheck, ExternalLink, FilePlus2, MoreHorizontal, Pencil, Rocket, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime, timeZone } from "@/lib/format";
import { useAction, useDebounced, useReference } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { findNode, nodeLabel, type Definitions, type PageNode } from "./model";
import { fieldsOf, variationsOf } from "./library/definition";
import { ComponentsQuery, LIBRARY_KEY, globalId, invalidateMatching } from "./library/queries";
import { ComponentIcon } from "./library/icons";
import { PageStatusBadge, ReleaseStatusBadge, fromLocalInput, scheduleSuggestions, toLocalInput } from "./library/ui";

const ReleaseQuery = graphql(`
  query ReleaseDetail($id: ID!) {
    node(id: $id) {
      __typename
      ... on Release {
        id
        name
        description
        status
        scheduledAt
        publishedAt
        error
        createdAt
        createdBy {
          id
          name
          email
        }
        publishedBy {
          id
          name
          email
        }
        pages {
          id
          title
          path
          type
          status
          scheduledAt
          publishedAt
          draftUpdatedAt
          draftUpdatedBy {
            id
            name
            email
          }
          contentType {
            id
            name
            icon
            kind
          }
        }
      }
    }
  }
`);

const PagePickerQuery = graphql(`
  query ReleaseDetailPagePicker($first: Int!, $query: String) {
    pages(first: $first, query: $query) {
      totalCount
      edges {
        node {
          id
          title
          path
          type
          status
          contentType {
            id
            name
            icon
            kind
          }
        }
      }
    }
  }
`);

const ProblemDocumentsQuery = graphql(`
  query ReleaseDetailProblemDocuments($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Page {
        id
        document
      }
    }
  }
`);

const ReleaseUpdate = graphql(
  `
    mutation ReleaseDetailUpdate($id: ID!, $input: ReleaseInput!) {
      releaseUpdate(id: $id, input: $input) {
        __typename
        ... on ReleasePayload {
          release {
            id
            status
            scheduledAt
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const ReleaseAddPages = graphql(
  `
    mutation ReleaseDetailAddPages($id: ID!, $pageIds: [ID!]!) {
      releaseAddPages(id: $id, pageIds: $pageIds) {
        __typename
        ... on ReleasePayload {
          release {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const ReleaseRemovePages = graphql(
  `
    mutation ReleaseDetailRemovePages($id: ID!, $pageIds: [ID!]!) {
      releaseRemovePages(id: $id, pageIds: $pageIds) {
        __typename
        ... on ReleasePayload {
          release {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const ReleasePublish = graphql(
  `
    mutation ReleaseDetailPublish($id: ID!) {
      releasePublish(id: $id) {
        __typename
        ... on ReleasePayload {
          release {
            id
            status
            publishedAt
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const ReleaseDelete = graphql(
  `
    mutation ReleaseDetailDelete($id: ID!) {
      releaseDelete(id: $id) {
        __typename
        ... on DeletePayload {
          deletedId
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type ReleaseNode = NonNullable<ResultOf<typeof ReleaseQuery>["node"]>;
type Release = Extract<ReleaseNode, { __typename: "Release" }>;
type ReleasePageRow = NonNullable<Release["pages"]>[number];
type PickerPage = NonNullable<NonNullable<NonNullable<ResultOf<typeof PagePickerQuery>["pages"]>["edges"]>[number]>["node"] & {};

/** A problem from a failed publish: the page (global id) and where in it. */
type Problem = { pageId: string | null; rest: string[]; message: string };

const person = (user: { name?: string | null; email?: string | null } | null | undefined) => user?.name || user?.email || null;
const pageTitle = (page: { title?: string | null; path?: string | null; contentType?: { name?: string | null } | null }) => page.title || page.path || page.contentType?.name || "Untitled page";

/** releasePublish reports [pages, <uuid>, …] (e.g. [pages, id, node, nodeId, field]). */
const problemsFrom = (error: MutationError): Problem[] =>
  error.fieldErrors.map((f) => (f.path[0] === "pages" && f.path[1] ? { pageId: globalId("Page", f.path[1]), rest: f.path.slice(2), message: f.message } : { pageId: null, rest: f.path, message: f.message }));

/** What publishing the release does to a page in its current state. */
const effect = (page: ReleasePageRow) => {
  if (page.status === "DRAFT") return { text: "First publish", tone: "text-foreground" };
  if (page.status === "CHANGED") return { text: "Draft changes go live", tone: "text-foreground" };
  if (page.status === "SCHEDULED") return { text: `Also scheduled on its own ${relativeTime(page.scheduledAt)}; the release publishes it first`, tone: "text-warning" };
  return { text: "No unpublished changes", tone: "text-muted-foreground" };
};

/** /releases/$id: the pages in a release, its schedule, and publishing them together. */
export const ReleasePage = () => {
  const { id } = useParams({ strict: false }) as { id?: string };
  const releaseId = globalId("Release", id ?? "");
  const query = useQuery({ queryKey: ["builder-release", releaseId], queryFn: ({ signal }) => request(ReleaseQuery, { id: releaseId }, { signal }), refetchInterval: 60_000 });
  const release = query.data?.node?.__typename === "Release" ? (query.data.node as Release) : null;

  if (query.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-72" />
        <Skeleton className="mb-6 h-24" />
        <Skeleton className="h-80" />
      </Page>
    );
  }
  if (!release) {
    return (
      <Page>
        <EmptyState
          icon={Rocket}
          title="Release not found"
          description={query.error instanceof Error ? query.error.message : "It may have been deleted."}
          action={
            <Button asChild variant="outline">
              <Link to="/releases">Back to releases</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return <ReleaseDetail key={release.id} release={release} />;
};

const ReleaseDetail = ({ release }: { release: Release }) => {
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const published = release.status === "PUBLISHED";
  const write = can("content:write");
  const editable = write && !published;
  const pages = release.pages ?? [];
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failure, setFailure] = useState<{ message: string; problems: Problem[] } | null>(null);
  const refresh = () => invalidateMatching(queryClient, /release|page/i);

  const publish = useAction(async () => unwrap((await request(ReleasePublish, { id: release.id })).releasePublish), {
    onSuccess: () => {
      setConfirmPublish(false);
      setFailure(null);
      toast.success(`Published ${release.name}`, { description: `${pages.length} page${pages.length === 1 ? "" : "s"} went live together.` });
      void refresh();
    },
    onError: (error) => {
      setConfirmPublish(false);
      if (error instanceof MutationError && error.fieldErrors.length) {
        setFailure({ message: error.message, problems: problemsFrom(error) });
        toast.error("Nothing was published", { description: error.message });
        void refresh();
      } else reportError(error);
    },
  });

  const unschedule = useAction(async () => unwrap((await request(ReleaseUpdate, { id: release.id, input: { scheduledAt: null } })).releaseUpdate), {
    success: "Schedule removed; the release is open again",
    onSuccess: () => void refresh(),
  });

  const removePage = useAction(async (page: ReleasePageRow) => unwrap((await request(ReleaseRemovePages, { id: release.id, pageIds: [page.id] })).releaseRemovePages), {
    onSuccess: (_result, page) => {
      void refresh();
      toast(`Removed ${pageTitle(page)}`, {
        action: {
          label: "Undo",
          onClick: () =>
            void request(ReleaseAddPages, { id: release.id, pageIds: [page.id] })
              .then((r) => unwrap(r.releaseAddPages))
              .then(refresh)
              .catch((error: unknown) => reportError(error)),
        },
      });
    },
  });

  const remove = useAction(async () => unwrap((await request(ReleaseDelete, { id: release.id })).releaseDelete), {
    success: `Deleted ${release.name}`,
    onSuccess: async () => {
      setConfirmDelete(false);
      // Leave first, so this screen never renders "not found" for what it deleted.
      await navigate({ to: "/releases" });
      queryClient.removeQueries({ queryKey: ["builder-release", release.id] });
      await invalidateMatching(queryClient, /release/i);
    },
  });

  const problemCount = (pageId: string) => failure?.problems.filter((p) => p.pageId === pageId).length ?? 0;

  return (
    <Page>
      <PageHeader
        back={{ to: "/releases", label: "Releases" }}
        title={release.name ?? "Release"}
        badges={<ReleaseStatusBadge status={release.status} />}
        description={release.description || `Created ${relativeTime(release.createdAt)}${person(release.createdBy) ? ` by ${person(release.createdBy)}` : ""}`}
        actions={
          write ? (
            <>
              {editable ? (
                release.status === "SCHEDULED" ? (
                  <>
                    <Button variant="outline" onClick={() => setScheduling(true)}>
                      <CalendarClock />
                      Reschedule
                    </Button>
                    <Button variant="outline" loading={unschedule.isPending} onClick={() => unschedule.mutate(undefined)}>
                      {unschedule.isPending ? null : <CalendarX2 />}
                      Unschedule
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" onClick={() => setScheduling(true)}>
                    <CalendarClock />
                    {release.status === "FAILED" ? "Reschedule" : "Schedule"}
                  </Button>
                )
              ) : null}
              {editable ? (
                <Tooltip content={pages.length ? "Publish every page now, together" : "Add pages first"}>
                  <span>
                    <Button onClick={() => setConfirmPublish(true)} disabled={!pages.length}>
                      <Rocket />
                      Publish now
                    </Button>
                  </span>
                </Tooltip>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {editable ? (
                    <>
                      <DropdownMenuItem onSelect={() => setEditing(true)}>
                        <Pencil />
                        Edit name and description
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem destructive onSelect={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Delete release
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null
        }
      />

      <div className="flex flex-col gap-6">
        {published ? (
          <Alert variant="success" title={`Published ${formatDateTime(release.publishedAt)}${person(release.publishedBy) ? ` by ${person(release.publishedBy)}` : ""}`}>
            Its pages went live together. A published release is read-only; create a new release for further changes.
          </Alert>
        ) : release.status === "FAILED" ? (
          <Alert variant="destructive" title="The scheduled publish failed; nothing went live">
            <p>{release.error}</p>
            <p className="mt-1 opacity-80">Fix the pages, then publish now (problems are listed per page) or schedule it again.</p>
          </Alert>
        ) : null}

        {failure ? <ProblemsCard failure={failure} pages={pages} onDismiss={() => setFailure(null)} /> : null}

        <Card>
          <CardContent className="grid gap-6 pt-5 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Status">
              <ReleaseStatusBadge status={release.status} />
            </Fact>
            <Fact label={published ? "Published" : "Goes live"}>
              {published ? (
                <span title={formatDateTime(release.publishedAt)}>{relativeTime(release.publishedAt)}</span>
              ) : release.scheduledAt ? (
                <span>
                  {formatDateTime(release.scheduledAt)}
                  <span className="block text-xs text-muted-foreground">
                    {relativeTime(release.scheduledAt)} · {timeZone()}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">When you publish it</span>
              )}
            </Fact>
            <Fact label="Pages">
              <span className="text-lg font-semibold tabular">{pages.length}</span>
            </Fact>
            <Fact label="Created">
              <span title={formatDateTime(release.createdAt)}>
                {relativeTime(release.createdAt)}
                {person(release.createdBy) ? <span className="block text-xs text-muted-foreground">by {person(release.createdBy)}</span> : null}
              </span>
            </Fact>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                Pages
                <Badge variant="secondary">{pages.length}</Badge>
              </CardTitle>
              <CardDescription>{published ? "The pages published with this release." : "Each page's current draft goes live when the release publishes, including edits made after adding it."}</CardDescription>
            </div>
            {editable && pages.length ? (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <FilePlus2 />
                Add pages
              </Button>
            ) : null}
          </CardHeader>
          {pages.length === 0 ? (
            <EmptyState
              icon={FilePlus2}
              title="No pages yet"
              description="Add the pages of a campaign or launch: their drafts go live together."
              action={
                editable ? (
                  <Button onClick={() => setAdding(true)}>
                    <FilePlus2 />
                    Add pages
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Page</TableHead>
                  <TableHead>Status</TableHead>
                  {published ? null : <TableHead>On publish</TableHead>}
                  <TableHead>Last edited</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.map((page) => {
                  const problems = problemCount(page.id);
                  const what = effect(page);
                  return (
                    <TableRow key={page.id} className={cn(problems && "bg-destructive/5")}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                            <ComponentIcon name={page.contentType?.icon} kind="CONTENT_TYPE" />
                          </span>
                          <div className="min-w-0">
                            <Link to="/pages/$id" params={{ id: page.id }} className="font-medium hover:underline">
                              {pageTitle(page)}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">
                              {page.path ? <span className="font-mono">{page.path}</span> : "No path"} · {page.contentType?.name ?? page.type}
                            </p>
                          </div>
                          {problems ? (
                            <Badge variant="destructive">
                              <TriangleAlert />
                              {problems} problem{problems === 1 ? "" : "s"}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <PageStatusBadge status={page.status} />
                      </TableCell>
                      {published ? null : <TableCell className={cn("max-w-56 text-[13px]", what.tone)}>{what.text}</TableCell>}
                      <TableCell className="text-muted-foreground">
                        <span title={formatDateTime(page.draftUpdatedAt)}>{relativeTime(page.draftUpdatedAt)}</span>
                        {person(page.draftUpdatedBy) ? <p className="text-xs">by {person(page.draftUpdatedBy)}</p> : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-0.5">
                          <Tooltip content="Open in the page editor">
                            <Button asChild variant="ghost" size="icon-sm">
                              <Link to="/pages/$id" params={{ id: page.id }} aria-label={`Open ${pageTitle(page)} in the editor`}>
                                <ExternalLink />
                              </Link>
                            </Button>
                          </Tooltip>
                          {editable ? (
                            <Tooltip content="Remove from the release; the page itself is untouched">
                              <Button variant="ghost" size="icon-sm" disabled={removePage.isPending} onClick={() => removePage.mutate(page)} aria-label={`Remove ${pageTitle(page)} from the release`}>
                                <X />
                              </Button>
                            </Tooltip>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      {adding ? <AddPagesDialog release={release} onClose={() => setAdding(false)} onAdded={refresh} /> : null}
      {editing ? <EditDialog release={release} onClose={() => setEditing(false)} onSaved={refresh} /> : null}
      {scheduling ? <ScheduleDialog release={release} onClose={() => setScheduling(false)} onSaved={refresh} /> : null}

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish ${release.name} now?`}
        description={`${pages.length} page${pages.length === 1 ? "" : "s"} go live together, with the drafts they have now. If any page is not ready, nothing is published and the problems are listed per page.`}
        confirmLabel={`Publish ${pages.length} page${pages.length === 1 ? "" : "s"}`}
        loading={publish.isPending}
        onConfirm={() => publish.mutate(undefined)}
      >
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2 text-[13px]">
          {pages.map((page) => (
            <li key={page.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{pageTitle(page)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{effect(page).text.split(";")[0]}</span>
            </li>
          ))}
        </ul>
        {release.status === "SCHEDULED" ? <p className="text-xs text-muted-foreground">Publishing now also clears the schedule ({formatDateTime(release.scheduledAt)}).</p> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${release.name}?`}
        description={published ? "The release record goes; its pages stay published as they are." : "The release and its schedule go; its pages and their drafts are untouched."}
        destructive
        confirmLabel="Delete release"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </Page>
  );
};

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <div className="text-sm">{children}</div>
  </div>
);

// ---------------------------------------------------------------- publish problems

/** A refused publish's problems per page, named by component and field, with links to the editor. */
const ProblemsCard = ({ failure, pages, onDismiss }: { failure: { message: string; problems: Problem[] }; pages: ReleasePageRow[]; onDismiss: () => void }) => {
  const { defaultLocale } = useReference();
  const pageIds = [...new Set(failure.problems.flatMap((p) => (p.pageId ? [p.pageId] : [])))];
  const library = useQuery({ queryKey: [...LIBRARY_KEY], queryFn: ({ signal }) => request(ComponentsQuery, undefined, { signal }) });
  const documents = useQuery({ queryKey: ["builder-release-problem-docs", pageIds], queryFn: ({ signal }) => request(ProblemDocumentsQuery, { ids: pageIds }, { signal }), enabled: pageIds.length > 0 });
  const definitions: Definitions = useMemo(
    () => new Map((library.data?.components ?? []).map((c) => [c.code ?? "", { code: c.code ?? "", name: c.name ?? c.code ?? "", kind: c.kind ?? "COMPONENT", fields: fieldsOf(c.fields), variations: variationsOf(c.variations) }])),
    [library.data],
  );
  const roots = useMemo(() => {
    const map = new Map<string, PageNode>();
    for (const node of documents.data?.nodes ?? []) {
      if (node?.__typename !== "Page") continue;
      const document = (node as { id: string; document: unknown }).document as { root?: PageNode } | null;
      if (document?.root) map.set((node as { id: string }).id, document.root);
    }
    return map;
  }, [documents.data]);

  /** ["node", nodeId, field, itemId, subField] → "Hero “Built for the trail” › Buttons". */
  const locate = (problem: Problem): { where: string; nodeId: string | null } => {
    const [head, nodeId, field, itemId, subField] = problem.rest;
    if (head !== "node" || !nodeId) {
      const labels: Record<string, string> = { title: "Page title", path: "Path", seo: "SEO", root: "Root component", type: "Content type" };
      return { where: problem.rest.length ? problem.rest.map((p) => labels[p] ?? p).join(" › ") : "Page", nodeId: null };
    }
    const root = problem.pageId ? roots.get(problem.pageId) : undefined;
    const node = root ? findNode(root, definitions, nodeId) : null;
    const definition = node ? definitions.get(node.component) : undefined;
    const parts: string[] = [];
    if (node) {
      const label = nodeLabel(node, definitions, defaultLocale);
      parts.push(definition && label !== definition.name ? `${definition.name} “${label}”` : label);
    } else parts.push(`Component ${nodeId}`);
    if (field) {
      const special: Record<string, string> = { variation: "Variation", visibility: "Visibility", hidden: "Hidden" };
      const fieldDef = definition?.fields.find((f) => f.key === field);
      parts.push(special[field] ?? fieldDef?.label ?? field);
      if (itemId && fieldDef?.type === "list") {
        const items = Array.isArray(node?.fields[field]) ? (node!.fields[field] as { id?: string }[]) : [];
        const index = items.findIndex((item) => item?.id === itemId);
        parts.push(index >= 0 ? `Item ${index + 1}` : "Item");
        if (subField) parts.push(fieldDef.fields?.find((f) => f.key === subField)?.label ?? subField);
      } else if (itemId) parts.push(itemId);
    }
    return { where: parts.join(" › "), nodeId };
  };

  const groups = [...pageIds.map((id) => ({ id, problems: failure.problems.filter((p) => p.pageId === id) })), ...(failure.problems.some((p) => !p.pageId) ? [{ id: null, problems: failure.problems.filter((p) => !p.pageId) }] : [])];

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlert className="size-4" />
            Not published: {failure.message}
          </CardTitle>
          <CardDescription>Nothing went live. Fix these in the page editor, then publish again.</CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">
          <X />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {groups.map((group) => {
          const page = group.id ? pages.find((p) => p.id === group.id) : undefined;
          return (
            <div key={group.id ?? "release"} className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{group.id ? (page ? pageTitle(page) : "A page no longer in the release") : "Release"}</p>
                  {page?.path ? <p className="truncate font-mono text-xs text-muted-foreground">{page.path}</p> : null}
                </div>
                {group.id ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to="/pages/$id" params={{ id: group.id }}>
                      Open page
                    </Link>
                  </Button>
                ) : null}
              </div>
              <ul className="divide-y">
                {group.problems.map((problem, i) => {
                  const { where, nodeId } = locate(problem);
                  return (
                    <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0 text-[13px]">
                        <p className="font-medium">{where}</p>
                        <p className="text-muted-foreground">{problem.message}</p>
                      </div>
                      {group.id && nodeId ? (
                        <Button asChild variant="ghost" size="sm" className="shrink-0">
                          <Link to="/pages/$id" params={{ id: group.id }} search={{ node: nodeId }}>
                            Fix
                            <ArrowRight />
                          </Link>
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------- dialogs

const AddPagesDialog = ({ release, onClose, onAdded }: { release: Release; onClose: () => void; onAdded: () => void }) => {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const [selected, setSelected] = useState<Map<string, PickerPage>>(new Map());
  const results = useQuery({ queryKey: ["builder-release-page-picker", q], queryFn: ({ signal }) => request(PagePickerQuery, { first: 30, query: q || null }, { signal }), placeholderData: (previous) => previous });
  const inRelease = new Set((release.pages ?? []).map((p) => p.id));
  const found = (results.data?.pages?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
  const total = results.data?.pages?.totalCount ?? 0;
  const toggle = (page: PickerPage) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(page.id)) next.delete(page.id);
      else next.set(page.id, page);
      return next;
    });
  const add = useAction(async () => unwrap((await request(ReleaseAddPages, { id: release.id, pageIds: [...selected.keys()] })).releaseAddPages), {
    success: `Added ${selected.size} page${selected.size === 1 ? "" : "s"} to ${release.name}`,
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Add pages to {release.name}</DialogTitle>
          <DialogDescription>Search by title or path. Their drafts go live when the release publishes.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search pages, e.g. sale or /about" className="pl-8" aria-label="Search pages" />
        </div>
        <div className="max-h-[22rem] min-h-40 overflow-y-auto rounded-lg border">
          {results.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : found.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">{q ? `No page matches “${q}”.` : "No pages yet."}</p>
          ) : (
            <ul className="divide-y">
              {found.map((page) => {
                const already = inRelease.has(page.id);
                const checked = already || selected.has(page.id);
                return (
                  <li key={page.id}>
                    <label className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/40", already && "cursor-default opacity-60 hover:bg-transparent")}>
                      <Checkbox checked={checked} disabled={already} onCheckedChange={() => toggle(page)} aria-label={`Select ${pageTitle(page)}`} />
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
                        <ComponentIcon name={page.contentType?.icon} kind="CONTENT_TYPE" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{pageTitle(page)}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {page.path ? <span className="font-mono">{page.path}</span> : "No path"} · {page.contentType?.name ?? page.type}
                        </span>
                      </span>
                      {already ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Check className="size-3.5" />
                          In this release
                        </span>
                      ) : (
                        <PageStatusBadge status={page.status} />
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {total > found.length ? <p className="-mt-2 text-xs text-muted-foreground">Showing {found.length} of {total}; search to narrow down.</p> : null}
        <DialogFooter className="items-center">
          <p className="mr-auto text-[13px] text-muted-foreground">{selected.size ? `${selected.size} selected` : "Select pages to add"}</p>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!selected.size} loading={add.isPending} onClick={() => add.mutate(undefined)}>
            Add {selected.size || ""} page{selected.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const ScheduleDialog = ({ release, onClose, onSaved }: { release: Release; onClose: () => void; onSaved: () => void }) => {
  const suggestions = scheduleSuggestions();
  const [value, setValue] = useState(() => (release.scheduledAt && Date.parse(release.scheduledAt) > Date.now() ? toLocalInput(release.scheduledAt) : (suggestions.at(1)?.value ?? "")));
  const [error, setError] = useState<string | null>(null);
  const save = useAction(async () => unwrap((await request(ReleaseUpdate, { id: release.id, input: { scheduledAt: fromLocalInput(value) } })).releaseUpdate), {
    success: () => `Scheduled for ${formatDateTime(fromLocalInput(value))}`,
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (failure) => {
      if (failure instanceof MutationError && failure.fieldErrors.length) setError(failure.fieldErrors.map((f) => f.message).join("; "));
      else reportError(failure);
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{release.status === "SCHEDULED" ? "Reschedule" : "Schedule"} {release.name}</DialogTitle>
          <DialogDescription>Every page publishes automatically at this time, in {timeZone()}.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!value) return setError("Pick a date and time");
            if (new Date(value).getTime() <= Date.now()) return setError("Pick a time in the future, or publish now");
            setError(null);
            save.mutate(undefined);
          }}
        >
          <Field label="Publish at" error={error ?? undefined}>
            <Input
              type="datetime-local"
              autoFocus
              value={value}
              min={toLocalInput(new Date().toISOString())}
              aria-invalid={!!error}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <Button key={s.label} type="button" variant={value === s.value ? "secondary" : "outline"} size="sm" className="h-7 text-xs" onClick={() => setValue(s.value)}>
                {s.label}
              </Button>
            ))}
          </div>
          <Alert variant="info">Pages are checked when the time comes. If one is not ready then, nothing goes live and the release is marked Failed.</Alert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {save.isPending ? null : <CircleCheck />}
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const EditDialog = ({ release, onClose, onSaved }: { release: Release; onClose: () => void; onSaved: () => void }) => {
  const [name, setName] = useState(release.name ?? "");
  const [description, setDescription] = useState(release.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useAction(async () => unwrap((await request(ReleaseUpdate, { id: release.id, input: { name: name.trim(), description: description.trim() || null } })).releaseUpdate), {
    success: "Release saved",
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (failure) => {
      if (failure instanceof MutationError && failure.fieldErrors.length) setError(failure.fieldErrors.map((f) => f.message).join("; "));
      else reportError(failure);
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit release</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return setError("Name the release");
            save.mutate(undefined);
          }}
        >
          <Field label="Name" required error={error ?? undefined}>
            <Input autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
