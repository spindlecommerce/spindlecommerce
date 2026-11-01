import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, CalendarX2, Check, ChevronDown, CircleAlert, ExternalLink, EyeOff, Loader2, Plus, RefreshCw, Rocket, Undo2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { MutationError, request, unwrap } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { nodeLabel, TEMPLATE_KINDS, targetsSummary, type Selection } from "../model";
import {
  BUILDER_KEYS,
  OpenReleasesQuery,
  PageDiscardMutation,
  PagePublishMutation,
  PageScheduleMutation,
  PageUnpublishMutation,
  ReleaseAddPagesMutation,
  ReleaseCreateMutation,
  storefrontUrl,
} from "./api";
import { ComponentIcon } from "./icons";
import { useEditor, useEditorState, type PageMeta } from "./store";
import { fromLocalInput, indexTree, normalizeIssues, toLocalInput, type Issue } from "./util";

/** Publishing actions. Problems the API reports open a list that jumps to each field. */

type DialogName = "schedule" | "release" | "unpublish" | "discard" | null;

/** The live URL of a published page on the preview storefront. */
export const useLiveUrl = () => {
  const { frontend } = useEditor();
  const publishedPath = useEditorState((s) => s.meta.publishedPath);
  return storefrontUrl(frontend, publishedPath);
};

/** Where an API problem points, as a selection in the editor. */
export const issueSelection = (path: readonly string[], rootId: string): Selection | null => {
  if (path[0] === "node" && path[1]) {
    const rest = path.slice(2);
    const mapped = rest[0] === "variation" ? ["@variation"] : rest[0] === "visibility" ? ["@visibility", ...rest.slice(1)] : rest[0] === "hidden" ? ["@hidden"] : [...rest];
    return { nodeId: path[1], path: mapped };
  }
  if (path[0] === "title") return { nodeId: rootId, path: ["@title"] };
  if (path[0] === "path") return { nodeId: rootId, path: ["@path"] };
  if (path[0] === "seo") return { nodeId: rootId, path: ["@seo", ...(path[1] ? [path[1]] : [])] };
  return { nodeId: rootId, path: [] };
};

export const usePublishing = () => {
  const { actions, store, pageId, bridge, frontend, contentType } = useEditor();
  const queryClient = useQueryClient();
  const liveUrl = useLiveUrl();
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Issue[] | null>(null);

  const refreshLists = () => void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.pages });
  const failed = (error: unknown, fallback: string) => {
    if (error instanceof MutationError && error.typename === "ValidationError" && error.fieldErrors.length) {
      const issues = normalizeIssues(error.fieldErrors);
      actions.setIssues(issues);
      setProblems(issues);
      return;
    }
    if (error instanceof MutationError && error.typename === "ConflictError") {
      store.set({ conflict: error.message });
      return;
    }
    toast.error(error instanceof Error ? error.message : fallback);
  };
  /** Save what is pending; false (with a message) when that fails. */
  const saved = async () => {
    if (await actions.flush()) return true;
    const state = store.get();
    if (!state.conflict) toast.error("The latest changes are not saved yet", { description: state.saveError ?? "Try again in a moment." });
    return false;
  };
  const run = async (name: string, task: () => Promise<void>) => {
    setBusy(name);
    try {
      await task();
    } finally {
      setBusy(null);
    }
  };

  const publish = () =>
    run("publish", async () => {
      if (!(await saved())) return;
      try {
        const page = unwrap((await request(PagePublishMutation, { id: pageId, version: store.get().version })).pagePublish).page;
        if (page) actions.setMeta(page);
        actions.setIssues([]);
        setProblems(null);
        const url = storefrontUrl(frontend, page?.publishedPath);
        // Templates have no URL: they show wherever they are assigned.
        const description = contentType.templateFor
          ? targetsSummary(store.get().meta.templateTargets) === "Not assigned"
            ? `Not assigned yet: make it the default or assign it to ${TEMPLATE_KINDS[contentType.templateFor].many} in the page settings.`
            : `Visitors see it on the ${TEMPLATE_KINDS[contentType.templateFor].pages} it is assigned to.`
          : "The page is live.";
        toast.success("Published", { description, action: url ? { label: "View live", onClick: () => window.open(url, "_blank", "noopener") } : undefined });
        bridge.current?.refresh();
        refreshLists();
      } catch (error) {
        failed(error, "Could not publish");
      }
    });

  const schedule = (at: string) =>
    run("schedule", async () => {
      if (!(await saved())) return;
      const page = unwrap((await request(PageScheduleMutation, { id: pageId, at })).pageSchedule).page;
      if (page) actions.setMeta(page);
      actions.setIssues([]);
      toast.success(`Scheduled for ${formatDateTime(at)}`, { description: "The draft as it is then will be published." });
      refreshLists();
    });

  const cancelSchedule = () =>
    run("unschedule", async () => {
      try {
        const page = unwrap((await request(PageScheduleMutation, { id: pageId, at: null })).pageSchedule).page;
        if (page) actions.setMeta(page);
        toast.success("Schedule cancelled");
        refreshLists();
      } catch (error) {
        failed(error, "Could not cancel the schedule");
      }
    });

  const unpublish = () =>
    run("unpublish", async () => {
      try {
        const page = unwrap((await request(PageUnpublishMutation, { id: pageId })).pageUnpublish).page;
        if (page) actions.setMeta(page);
        toast.success("Unpublished", { description: contentType.templateFor ? "Visitors no longer see it; the draft and its assignments are kept." : "The page is offline; the draft is kept." });
        refreshLists();
      } catch (error) {
        failed(error, "Could not unpublish");
      }
    });

  const discard = () =>
    run("discard", async () => {
      try {
        await actions.settle();
        // The API keeps the discarded draft in history ("Before discarding changes").
        const page = unwrap((await request(PageDiscardMutation, { id: pageId })).pageDiscardDraft).page;
        if (page) {
          const { document, ...meta } = page;
          actions.replaceDocument(document as never, page.version ?? store.get().version, meta as Partial<PageMeta>);
        }
        void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.versions(pageId) });
        toast.success("Changes discarded", { description: "The draft is back to the published version. History has the discarded draft." });
        refreshLists();
      } catch (error) {
        failed(error, "Could not discard the changes");
      }
    });

  return { busy, problems, setProblems, publish, schedule, cancelSchedule, unpublish, discard, liveUrl, failed };
};

export type Publishing = ReturnType<typeof usePublishing>;

export const PublishMenu = ({ publishing }: { publishing: Publishing }) => {
  const { contentType } = useEditor();
  const template = contentType.templateFor ? TEMPLATE_KINDS[contentType.templateFor] : null;
  const status = useEditorState((s) => s.meta.status);
  const publishedAt = useEditorState((s) => s.meta.publishedAt);
  const scheduledAt = useEditorState((s) => s.meta.scheduledAt);
  const dirty = useEditorState((s) => s.doc !== s.savedDoc);
  const conflict = useEditorState((s) => !!s.conflict);
  const [dialog, setDialog] = useState<DialogName>(null);
  const { busy, publish, liveUrl, cancelSchedule, unpublish, discard } = publishing;
  const published = !!publishedAt;
  const upToDate = status === "PUBLISHED" && !dirty;
  const label = status === "SCHEDULED" ? "Publish now" : upToDate ? "Published" : published ? "Publish changes" : "Publish";
  const canDiscard = published && (dirty || status === "CHANGED" || status === "SCHEDULED");

  return (
    <>
      <div className="flex">
        <Button size="sm" className="rounded-r-none" onClick={() => void publish()} loading={busy === "publish"} disabled={upToDate || conflict || !!busy} variant={upToDate ? "secondary" : "default"}>
          {busy === "publish" ? null : upToDate ? <Check /> : <Upload />}
          {label}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant={upToDate ? "secondary" : "default"} className={cn("rounded-l-none border-l px-2", upToDate ? "border-border" : "border-primary-foreground/25")} aria-label="More publishing options" disabled={!!busy && busy !== "publish"}>
              {busy && busy !== "publish" ? <Loader2 className="animate-spin" /> : <ChevronDown />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Publishing</DropdownMenuLabel>
            <DropdownMenuItem disabled={upToDate || conflict} onSelect={() => void publish()}>
              <Upload /> Publish now
            </DropdownMenuItem>
            <DropdownMenuItem disabled={conflict} onSelect={() => setDialog("schedule")}>
              <CalendarClock /> {scheduledAt ? "Change schedule…" : "Schedule…"}
            </DropdownMenuItem>
            {scheduledAt ? (
              <DropdownMenuItem onSelect={() => void cancelSchedule()}>
                <CalendarX2 /> Cancel schedule
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => setDialog("release")}>
              <Rocket /> Add to release…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {liveUrl ? (
              <DropdownMenuItem asChild>
                <a href={liveUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> View live
                </a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={!published} onSelect={() => setDialog("unpublish")}>
              <EyeOff /> Unpublish…
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canDiscard} destructive onSelect={() => setDialog("discard")}>
              <Undo2 /> Discard changes…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScheduleDialog open={dialog === "schedule"} onOpenChange={(open) => setDialog(open ? "schedule" : null)} publishing={publishing} />
      <ReleaseDialog open={dialog === "release"} onOpenChange={(open) => setDialog(open ? "release" : null)} />
      <ConfirmDialog
        open={dialog === "unpublish"}
        onOpenChange={(open) => setDialog(open ? "unpublish" : null)}
        title={template ? "Unpublish this template?" : "Unpublish this page?"}
        description={
          template
            ? `Visitors stop seeing it right away: the ${template.pages} it renders fall back to the next template that applies, or the storefront's built-in layout. The draft and its assignments are kept, so you can publish it again.`
            : "It goes offline right away: the storefront shows a not-found page at its path. The draft is kept, so you can publish it again."
        }
        confirmLabel="Unpublish"
        destructive
        loading={busy === "unpublish"}
        onConfirm={() => void unpublish().then(() => setDialog(null))}
      />
      <ConfirmDialog
        open={dialog === "discard"}
        onOpenChange={(open) => setDialog(open ? "discard" : null)}
        title="Discard your changes?"
        description="The draft goes back to the published version. The discarded draft stays in History in case you need it."
        confirmLabel="Discard changes"
        destructive
        loading={busy === "discard"}
        onConfirm={() => void discard().then(() => setDialog(null))}
      />
      <ProblemsDialog publishing={publishing} />
    </>
  );
};

// ---------------------------------------------------------------- problems

const ProblemsDialog = ({ publishing }: { publishing: Publishing }) => {
  const { actions, defs, contentType, store } = useEditor();
  const locale = useEditorState((s) => s.locale);
  const { problems, setProblems } = publishing;
  const describe = (issue: Issue) => {
    const doc = store.get().doc;
    if (issue.path[0] === "node" && issue.path[1]) {
      const entry = indexTree(doc.root, defs).get(issue.path[1]);
      const def = entry ? defs.get(entry.node.component) : undefined;
      const field = def?.fields.find((f) => f.key === issue.path[2]);
      const item = field?.type === "list" && issue.path[3] ? field.fields?.find((f) => f.key === issue.path[4]) : undefined;
      const isRoot = entry?.node.id === doc.root.id;
      return {
        icon: def?.icon ?? contentType.icon,
        where: isRoot ? "Page" : entry ? `${def?.name ?? entry.node.component}${nodeLabel(entry.node, defs, locale) !== def?.name ? ` · ${nodeLabel(entry.node, defs, locale)}` : ""}` : "A component",
        field: [field?.label ?? (issue.path[2] === "variation" ? "Variation" : null), item?.label].filter(Boolean).join(" › "),
      };
    }
    const names: Record<string, string> = { title: "Title", path: "Path", seo: "SEO" };
    return { icon: contentType.icon, where: issue.path[0] === "seo" ? "SEO" : "Page settings", field: issue.path[0] === "seo" ? (issue.path[1] ?? "") : (names[issue.path[0] ?? ""] ?? issue.path.join(".")) };
  };
  const goTo = (issue: Issue) => {
    setProblems(null);
    const selection = issueSelection(issue.path, store.get().doc.root.id);
    // After the dialog closes, so focus lands in the inspector.
    setTimeout(() => actions.select(selection, { focus: true }), 50);
  };
  return (
    <Dialog open={!!problems} onOpenChange={(open) => !open && setProblems(null)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleAlert className="size-4 text-destructive" /> Not ready to publish
          </DialogTitle>
          <DialogDescription>
            {problems?.length === 1 ? "One thing needs fixing" : `${problems?.length ?? 0} things need fixing`} first. They are also marked in the structure tree and next to the fields.
          </DialogDescription>
        </DialogHeader>
        <ul className="-mx-2 flex max-h-[50vh] flex-col overflow-y-auto">
          {(problems ?? []).map((issue, i) => {
            const info = describe(issue);
            return (
              <li key={`${issue.path.join(".")}-${i}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/60">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                  <ComponentIcon name={info.icon} className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {info.where}
                    {info.field ? <span className="font-normal text-muted-foreground"> › {info.field}</span> : null}
                  </p>
                  <p className="text-xs text-destructive">{issue.message}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => goTo(issue)}>
                  Go to
                </Button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => setProblems(null)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- schedule

const tomorrowMorning = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d.toISOString());
};

const ScheduleDialog = ({ open, onOpenChange, publishing }: { open: boolean; onOpenChange: (open: boolean) => void; publishing: Publishing }) => {
  const scheduledAt = useEditorState((s) => s.meta.scheduledAt);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const at = fromLocalInput(value);
  const past = !!at && Date.parse(at) <= Date.now();
  const submit = async () => {
    if (!at || past) return;
    setError(null);
    try {
      await publishing.schedule(at);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof MutationError && e.fieldErrors.some((f) => f.path[0] === "at")) setError(e.fieldErrors.find((f) => f.path[0] === "at")!.message);
      else {
        onOpenChange(false);
        publishing.failed(e, "Could not schedule");
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setValue(scheduledAt ? toLocalInput(scheduledAt) : tomorrowMorning());
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule publishing</DialogTitle>
          <DialogDescription>The draft is checked now, and published as it is at that time. Keep editing until then; changes are included.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-at">Publish at</Label>
            <Input id="schedule-at" type="datetime-local" value={value} min={toLocalInput(new Date().toISOString())} onChange={(e) => setValue(e.target.value)} aria-invalid={past || !!error || undefined} />
            <p className={cn("text-xs text-muted-foreground", (past || error) && "text-destructive")}>{error ?? (past ? "Pick a time in the future, or publish now." : at ? `${formatDateTime(at)} (${relativeTime(at)}) in your time zone.` : "Choose a date and time.")}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!at || past} loading={publishing.busy === "schedule"}>
              <CalendarClock /> Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- releases

const ReleaseDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const { pageId, actions } = useEditor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const releasesIn = useEditorState((s) => s.meta.releases);
  const releases = useQuery({ queryKey: BUILDER_KEYS.releases, queryFn: () => request(OpenReleasesQuery), enabled: open, staleTime: 10_000 });
  const openReleases = (releases.data?.releases ?? []).filter((r) => r.status !== "PUBLISHED");
  const [choice, setChoice] = useState<string>("new");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const inRelease = new Set((releasesIn ?? []).map((r) => r.id));

  const submit = async () => {
    setBusy(true);
    try {
      const release =
        choice === "new"
          ? unwrap((await request(ReleaseCreateMutation, { input: { name: name.trim(), description: description.trim() || null, scheduledAt: fromLocalInput(at) }, pageIds: [pageId] })).releaseCreate).release
          : unwrap((await request(ReleaseAddPagesMutation, { id: choice, pageIds: [pageId] })).releaseAddPages).release;
      if (!release) return;
      const current = releasesIn ?? [];
      const known = openReleases.find((r) => r.id === release.id);
      actions.setMeta({ releases: [...current.filter((r) => r.id !== release.id), { id: release.id, name: release.name, status: known?.status ?? "OPEN", scheduledAt: known?.scheduledAt ?? fromLocalInput(at) }] });
      void queryClient.invalidateQueries({ queryKey: ["releases"] });
      toast.success(`Added to ${release.name}`, { description: "It publishes with the rest of the release.", action: { label: "Open release", onClick: () => void navigate({ to: "/releases/$id", params: { id: release.id } }) } });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof MutationError && error.fieldErrors.length ? error.fieldErrors.map((f) => f.message).join(" ") : error instanceof Error ? error.message : "Could not add to the release");
    } finally {
      setBusy(false);
    }
  };
  const valid = choice === "new" ? !!name.trim() && (!at || Date.parse(fromLocalInput(at) ?? "") > Date.now()) : !inRelease.has(choice);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName("");
          setDescription("");
          setAt("");
          setChoice("new");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to a release</DialogTitle>
          <DialogDescription>A release publishes several pages together, now or at a set time. The page&apos;s draft at that moment goes live.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[45vh] flex-col gap-1.5 overflow-y-auto" role="radiogroup" aria-label="Release">
          {releases.isLoading ? (
            <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading releases…
            </p>
          ) : null}
          {openReleases.map((r) => {
            const already = inRelease.has(r.id);
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={choice === r.id}
                disabled={already}
                onClick={() => setChoice(r.id)}
                className={cn("flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent/50 disabled:cursor-default disabled:opacity-60", choice === r.id && "border-primary bg-primary/5")}
              >
                <Rocket className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{r.scheduledAt ? `Publishes ${formatDateTime(r.scheduledAt)}` : (r.description ?? "Not scheduled")}</span>
                </span>
                {already ? <Badge variant="secondary">Already in it</Badge> : r.status === "FAILED" ? <Badge variant="destructive">Failed</Badge> : r.status === "SCHEDULED" ? <Badge variant="info">Scheduled</Badge> : null}
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={choice === "new"}
            onClick={() => setChoice("new")}
            className={cn("flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50", choice === "new" && "border-primary bg-primary/5")}
          >
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            New release
          </button>
        </div>
        {choice === "new" ? (
          <div className="grid gap-3 rounded-lg bg-muted/40 p-3">
            <div className="grid gap-1.5">
              <Label htmlFor="release-name">Name</Label>
              <Input id="release-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer campaign launch" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="release-description">Description</Label>
              <Textarea id="release-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="release-at">Publish at (optional)</Label>
              <Input id="release-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid} loading={busy}>
            <Rocket /> {choice === "new" ? "Create release" : "Add to release"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- banners

/** Scheduled, failed schedule, conflict and save problems, under the top bar. */
export const StatusBanners = ({ publishing, onReload }: { publishing: Publishing; onReload: () => void }) => {
  const scheduledAt = useEditorState((s) => s.meta.scheduledAt);
  const scheduleError = useEditorState((s) => s.meta.scheduleError);
  const conflict = useEditorState((s) => s.conflict);
  const saveError = useEditorState((s) => s.saveError);
  const saveIssues = useEditorState((s) => s.saveIssues);
  const { actions, store } = useEditor();
  const banners: React.ReactNode[] = [];
  if (conflict) {
    banners.push(
      <Strip key="conflict" tone="destructive" icon={<CircleAlert />}>
        <span className="min-w-0 flex-1">
          <strong className="font-medium">Someone else saved this page.</strong> {conflict} Your edits since then cannot be saved; reload to continue from the latest version.
        </span>
        <Button size="sm" variant="destructive" className="h-7" onClick={onReload}>
          <RefreshCw /> Reload
        </Button>
      </Strip>,
    );
  } else if (saveError && saveIssues.length) {
    banners.push(
      <Strip key="save" tone="destructive" icon={<CircleAlert />}>
        <span className="min-w-0 flex-1">
          <strong className="font-medium">Not saved:</strong> {saveIssues.map((i) => i.message).join(" ")}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => {
            const issue = saveIssues[0]!;
            actions.select(issueSelection(issue.path, store.get().doc.root.id), { focus: true });
          }}
        >
          Go to
        </Button>
      </Strip>,
    );
  }
  if (scheduleError) {
    banners.push(
      <Strip key="schedule-error" tone="destructive" icon={<CalendarX2 />}>
        <span className="min-w-0 flex-1">
          <strong className="font-medium">The scheduled publish failed.</strong> {scheduleError}
        </span>
      </Strip>,
    );
  }
  if (scheduledAt) {
    banners.push(
      <Strip key="scheduled" tone="info" icon={<CalendarClock />}>
        <span className="min-w-0 flex-1">
          Scheduled to publish <strong className="font-medium">{formatDateTime(scheduledAt)}</strong> ({relativeTime(scheduledAt)}). Edits until then are included.
        </span>
        <Button size="sm" variant="outline" className="h-7" onClick={() => void publishing.cancelSchedule()} loading={publishing.busy === "unschedule"}>
          Cancel schedule
        </Button>
      </Strip>,
    );
  }
  return banners.length ? <div className="flex shrink-0 flex-col">{banners}</div> : null;
};

const Strip = ({ tone, icon, children }: { tone: "info" | "destructive"; icon: React.ReactNode; children: React.ReactNode }) => (
  <div className={cn("flex items-center gap-2.5 border-b px-4 py-1.5 text-[13px] [&>svg]:size-4 [&>svg]:shrink-0", tone === "info" ? "bg-info/8 [&>svg]:text-info" : "bg-destructive/8 text-destructive [&>svg]:text-destructive")}>
    {icon}
    {children}
  </div>
);
