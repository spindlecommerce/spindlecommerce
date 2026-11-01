import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarClock, Plus, Rocket } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch, Tabs, TabsList, TabsTrigger } from "@/components/ui/controls";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime, timeZone } from "@/lib/format";
import { useAction, useListSearch } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { invalidateMatching } from "./library/queries";
import { ReleaseStatusBadge, fromLocalInput, scheduleSuggestions, toLocalInput } from "./library/ui";

const ReleasesQuery = graphql(`
  query ReleaseList {
    releases {
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
      }
    }
  }
`);

const ReleaseCreate = graphql(
  `
    mutation ReleaseListCreate($input: ReleaseInput!, $pageIds: [ID!]) {
      releaseCreate(input: $input, pageIds: $pageIds) {
        __typename
        ... on ReleasePayload {
          release {
            id
            name
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type Release = NonNullable<ResultOf<typeof ReleasesQuery>["releases"]>[number];

const RELEASES_KEY = ["builder-releases"] as const;

const TABS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Failed" },
] as const;

const person = (user: { name?: string | null; email?: string | null } | null | undefined) => user?.name || user?.email || null;

/** When a release goes (or went) live, in words. */
const timing = (r: Release) => {
  if (r.status === "PUBLISHED") return { main: `Published ${relativeTime(r.publishedAt)}`, sub: formatDateTime(r.publishedAt), title: person(r.publishedBy) ? `by ${person(r.publishedBy)}` : null };
  if (r.status === "SCHEDULED") return { main: formatDateTime(r.scheduledAt), sub: relativeTime(r.scheduledAt), title: null };
  if (r.status === "FAILED") return { main: `Was due ${relativeTime(r.scheduledAt)}`, sub: formatDateTime(r.scheduledAt), title: null };
  return { main: "Not scheduled", sub: null, title: null };
};

export const ReleasesPage = () => {
  const { can } = useAuth();
  const write = can("content:write");
  const navigate = useNavigate();
  const [search, setSearch] = useListSearch();
  // Scheduled releases publish on their own; refresh now and then so the list keeps up.
  const query = useQuery({ queryKey: [...RELEASES_KEY], queryFn: ({ signal }) => request(ReleasesQuery, undefined, { signal }), refetchInterval: 60_000 });
  const [creating, setCreating] = useState(false);
  const releases = query.data?.releases ?? [];
  const tab = TABS.some((t) => t.value === search.status) ? (search.status as (typeof TABS)[number]["value"]) : "all";
  const count = (value: string) => (value === "all" ? releases.length : releases.filter((r) => r.status === value.toUpperCase()).length);
  const rows = tab === "all" ? releases : releases.filter((r) => r.status === tab.toUpperCase());
  const upcoming = releases.filter((r) => r.status === "SCHEDULED").sort((a, b) => Date.parse(a.scheduledAt ?? "") - Date.parse(b.scheduledAt ?? ""))[0];

  return (
    <Page>
      <PageHeader
        title="Releases"
        description="Bundle page changes and publish them together, now or at a scheduled time. All pages go live in one transaction, with the drafts they have at that moment."
        actions={
          write ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New release
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(value) => setSearch({ status: value === "all" ? undefined : value })}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
                <span className={cn("rounded-full px-1.5 text-[11px] tabular", tab === t.value ? "bg-muted" : "bg-background/60")}>{count(t.value)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {upcoming ? (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <CalendarClock className="size-4" />
            Next:{" "}
            <Link to="/releases/$id" params={{ id: upcoming.id }} className="font-medium text-foreground hover:underline">
              {upcoming.name}
            </Link>{" "}
            {relativeTime(upcoming.scheduledAt)}
          </p>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        {query.isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : query.error ? (
          <EmptyState icon={Rocket} title="Could not load releases" description={query.error instanceof Error ? query.error.message : undefined} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Rocket}
            title={releases.length ? `No ${tab} releases` : "No releases yet"}
            description={releases.length ? "Pick another tab to see the rest." : "Create a release, add the pages of a campaign or a launch, then publish them together or schedule them."}
            action={
              write && !releases.length ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus />
                  New release
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Release</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Goes live</TableHead>
                <TableHead className="text-right">Pages</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const when = timing(r);
                const pages = r.pages?.length ?? 0;
                return (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => void navigate({ to: "/releases/$id", params: { id: r.id } })}>
                    <TableCell className="max-w-md">
                      <Link to="/releases/$id" params={{ id: r.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Link>
                      {r.status === "FAILED" && r.error ? (
                        <Tooltip content={r.error}>
                          <p className="truncate text-xs text-destructive">{r.error}</p>
                        </Tooltip>
                      ) : r.description ? (
                        <p className="truncate text-xs text-muted-foreground">{r.description}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <ReleaseStatusBadge status={r.status} />
                    </TableCell>
                    <TableCell>
                      <span className={cn(r.status === "OPEN" && "text-muted-foreground")}>{when.main}</span>
                      {when.sub || when.title ? <p className="text-xs text-muted-foreground">{[when.sub, when.title].filter(Boolean).join(" · ")}</p> : null}
                    </TableCell>
                    <TableCell className={cn("tabular text-right", !pages && "text-muted-foreground")}>{pages}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <Tooltip content={formatDateTime(r.createdAt)}>
                        <span>{relativeTime(r.createdAt)}</span>
                      </Tooltip>
                      {person(r.createdBy) ? <p className="text-xs">by {person(r.createdBy)}</p> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {creating ? <CreateReleaseDialog onClose={() => setCreating(false)} /> : null}
    </Page>
  );
};

type CreateForm = { name: string; description: string; schedule: boolean; scheduledAt: string };

const CreateReleaseDialog = ({ onClose }: { onClose: () => void }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<CreateForm>({ defaultValues: { name: "", description: "", schedule: false, scheduledAt: scheduleSuggestions().at(1)?.value ?? "" } });
  const schedule = form.watch("schedule");
  const create = useAction(
    async (v: CreateForm) =>
      unwrap(
        (
          await request(ReleaseCreate, {
            input: { name: v.name.trim(), description: v.description.trim() || null, scheduledAt: v.schedule ? fromLocalInput(v.scheduledAt) : null },
          })
        ).releaseCreate,
      ).release,
    {
      success: (release) => `Created ${release?.name ?? "the release"}`,
      onSuccess: (release) => {
        void invalidateMatching(queryClient, /release/i);
        onClose();
        if (release) void navigate({ to: "/releases/$id", params: { id: release.id } });
      },
      onError: (error) => reportError(error, form),
    },
  );
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New release</DialogTitle>
          <DialogDescription>Add pages after creating it. Publish it by hand, or schedule it to go live on its own.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={form.handleSubmit((v) => {
            if (v.schedule) {
              if (!v.scheduledAt) return form.setError("scheduledAt", { message: "Pick a date and time" });
              if (new Date(v.scheduledAt).getTime() <= Date.now()) return form.setError("scheduledAt", { message: "Pick a time in the future" });
            }
            create.mutate(v);
          })}
        >
          <Field label="Name" required error={errors.name?.message}>
            <Input autoFocus placeholder="e.g. Summer sale launch" maxLength={200} {...form.register("name", { validate: (v) => !!v.trim() || "Name the release" })} />
          </Field>
          <Field label="Description" hint="Optional: what goes live and why.">
            <Textarea rows={2} {...form.register("description")} placeholder="Campaign pages, new home hero and the sale banner" />
          </Field>
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <Label className="justify-between font-normal">
              <span>
                <span className="block text-sm">Schedule</span>
                <span className="text-xs text-muted-foreground">Publish automatically at a set time ({timeZone()}).</span>
              </span>
              <Controller control={form.control} name="schedule" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            </Label>
            {schedule ? (
              <Field error={errors.scheduledAt?.message}>
                <div className="flex flex-col gap-2">
                  <Input type="datetime-local" min={toLocalInput(new Date().toISOString())} {...form.register("scheduledAt")} />
                  <div className="flex flex-wrap gap-1.5">
                    {scheduleSuggestions().map((s) => (
                      <Button key={s.label} type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => form.setValue("scheduledAt", s.value, { shouldDirty: true })}>
                        {s.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </Field>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create release
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
