import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, ExternalLink, Info, LayoutTemplate, MoreHorizontal, Pencil, Plus, Trash2, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DataTable, FilterSelect, useListSort, type Column, type SortOption } from "@/components/data-table";
import { Field } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { EmptyState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import type { VariablesOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { languageName, relativeTime } from "@/lib/format";
import { useAction, useCursorPages, useListSearch, useReference } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import {
  BUILDER_KEYS,
  PageCreateMutation,
  PageDeleteMutation,
  PageDuplicateMutation,
  PagesQuery,
  rawIdOf,
  SingletonPageQuery,
  storefrontUrl,
  useFrontends,
  useLibrary,
  type PageRow,
} from "./editor/api";
import { ComponentIcon } from "./editor/icons";
import { PAGE_STATUSES, StatusBadge } from "./editor/status";
import { normalizePath, pathFromTitle, pathProblem } from "./editor/util";
import { TemplateForBadge } from "./library/ui";
import { TEMPLATE_KINDS, targetsSummary, type ComponentDef, type TemplateFor } from "./model";

/** Pages built from components: landing pages, the header and footer, and templates. */

const PAGE_SIZE = 50;
/** The API's page orders: by path (the default), or the latest draft saves first. */
const PAGE_SORTS = [
  { value: "path", label: "Path", column: "path", direction: "asc", api: "PATH" },
  { value: "updated", label: "Last edited", column: "updated", direction: "desc", api: "UPDATED" },
] as const satisfies readonly (SortOption & { api: NonNullable<VariablesOf<typeof PagesQuery>["sort"]> })[];
type StatusValue = (typeof PAGE_STATUSES)[number]["value"];
const isStatus = (value: string | undefined): value is StatusValue => PAGE_STATUSES.some((s) => s.value === value);

const channelSummary = (page: Pick<PageRow, "allChannels" | "channels">) => (page.allChannels || !page.channels?.length ? "All channels" : page.channels.map((c) => c.name).join(", "));

const templateHint = (kind: TemplateFor) => `${TEMPLATE_KINDS[kind].pages.charAt(0).toUpperCase()}${TEMPLATE_KINDS[kind].pages.slice(1)} render with it. It has no path: assign it to ${TEMPLATE_KINDS[kind].many}, or make it the default, in its page settings.`;

export const PagesPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const write = can("content:write");
  const [search, setSearch] = useListSearch();
  const cursor = useCursorPages();
  const sort = useListSort(PAGE_SORTS);
  const library = useLibrary();
  // Product and category sections are made and listed from their product or category.
  const pageTypes = library.contentTypes.filter((c) => !c.sectionsFor);
  const { preferred: frontend } = useFrontends();
  const [deleting, setDeleting] = useState<PageRow | null>(null);
  // ?new=page opens the dialog, so "New page" can be linked to.
  const creating = !!search.new;
  const setCreating = (open: boolean) => setSearch({ new: open ? "page" : undefined }, { keepCursor: true });

  const variables = { first: PAGE_SIZE, after: cursor.after, query: search.q || null, type: search.type || null, status: isStatus(search.status) ? search.status : null, sort: sort.api };
  const pages = useQuery({ queryKey: [...BUILDER_KEYS.pages, variables], queryFn: ({ signal }) => request(PagesQuery, variables, { signal }), placeholderData: (previous) => previous });
  const rows = (pages.data?.pages?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
  const typeOf = (code: string | null | undefined) => (code ? library.defs.get(code) : undefined);
  const edit = (page: Pick<PageRow, "id">) => void navigate({ to: "/pages/$id", params: { id: rawIdOf(page.id) } });

  const duplicate = useAction(async (page: PageRow) => unwrap((await request(PageDuplicateMutation, { id: page.id })).pageDuplicate).page, {
    invalidate: [BUILDER_KEYS.pages],
    onSuccess: (copy) => {
      if (!copy) return;
      toast.success(`Duplicated as ${copy.path ?? copy.title ?? "a new draft"}`, { action: { label: "Open", onClick: () => edit(copy) } });
    },
  });
  const remove = useAction(async (page: PageRow) => unwrap((await request(PageDeleteMutation, { id: page.id })).pageDelete), {
    invalidate: [BUILDER_KEYS.pages],
    success: "Page deleted",
    onSuccess: () => setDeleting(null),
  });

  const columns: Column<PageRow>[] = [
    {
      id: "title",
      header: "Title",
      fixed: true,
      cell: (p) => {
        const type = typeOf(p.type);
        return (
          <div className="flex min-w-0 items-center gap-2">
            <Link to="/pages/$id" params={{ id: rawIdOf(p.id) }} onClick={(e) => e.stopPropagation()} className="group flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ComponentIcon name={type?.icon} className="size-3.5" />
              </span>
              <span className="truncate font-medium text-foreground group-hover:underline">{p.title || <span className="text-muted-foreground italic">Untitled</span>}</span>
            </Link>
            <TemplateForBadge templateFor={p.templateFor} hint={p.templateFor ? templateHint(p.templateFor) : undefined} />
          </div>
        );
      },
      csv: (p) => p.title,
    },
    {
      id: "path",
      header: "Path",
      cell: (p) =>
        p.templateFor ? (
          // Templates have no path, so show where they are used.
          <Tooltip
            content={
              p.templateFor === "PRODUCT"
                ? "Where this template is used. Default: every product page without a more specific template. Categories: the products in them."
                : "Where this template is used. Default: every category page without a template of its own."
            }
          >
            <span className={cn("text-[13px]", p.templateTargets?.isDefault || p.templateTargets?.categories?.length || p.templateTargets?.products?.length ? "text-foreground" : "text-muted-foreground")}>
              {targetsSummary(p.templateTargets)}
            </span>
          </Tooltip>
        ) : p.path ? (
          <span className="flex items-center gap-1.5">
            <code className="font-mono text-xs">{p.path}</code>
            {p.publishedPath && p.publishedPath !== p.path ? (
              <Tooltip content={`Live at ${p.publishedPath} until the new path is published`}>
                <span className="font-mono text-[11px] text-muted-foreground line-through">{p.publishedPath}</span>
              </Tooltip>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      csv: (p) => (p.templateFor ? `${TEMPLATE_KINDS[p.templateFor].template}: ${targetsSummary(p.templateTargets)}` : p.path),
    },
    { id: "type", header: "Type", cell: (p) => <span className="text-muted-foreground">{typeOf(p.type)?.name ?? p.type}</span>, csv: (p) => typeOf(p.type)?.name ?? p.type },
    { id: "status", header: "Status", cell: (p) => <StatusBadge status={p.status} scheduledAt={p.scheduledAt} />, csv: (p) => p.status },
    {
      id: "updated",
      header: "Updated",
      cell: (p) => (
        <span className="text-muted-foreground">
          {relativeTime(p.draftUpdatedAt)}
          {p.draftUpdatedBy ? <span className="text-muted-foreground/80"> · {p.draftUpdatedBy.name ?? p.draftUpdatedBy.email}</span> : null}
        </span>
      ),
      csv: (p) => p.draftUpdatedAt,
    },
    { id: "channels", header: "Channels", cell: (p) => <span className="text-muted-foreground">{channelSummary(p)}</span>, csv: (p) => channelSummary(p) },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      fixed: true,
      className: "w-10",
      cell: (p) => {
        const live = p.publishedPath && (p.status === "PUBLISHED" || p.status === "CHANGED" || p.status === "SCHEDULED") ? storefrontUrl(frontend, p.publishedPath) : null;
        const type = typeOf(p.type);
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.title ?? "page"}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-48">
                <DropdownMenuItem onSelect={() => edit(p)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                {live ? (
                  <DropdownMenuItem asChild>
                    <a href={live} target="_blank" rel="noreferrer">
                      <ExternalLink /> View live
                    </a>
                  </DropdownMenuItem>
                ) : null}
                {write && !type?.singleton ? (
                  <DropdownMenuItem onSelect={() => duplicate.mutate(p)}>
                    <Copy /> Duplicate
                  </DropdownMenuItem>
                ) : null}
                {write ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => setDeleting(p)}>
                      <Trash2 /> Delete…
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const filtered = !!(search.q || search.type || search.status);
  return (
    <Page wide>
      <PageHeader
        title="Pages"
        description="Pages built from components and edited visually on your storefront: landing pages, campaigns, the site header and footer, and the templates product and category pages render with."
        actions={
          write ? (
            <Button onClick={() => setCreating(true)} disabled={!pageTypes.length}>
              <Plus /> New page
            </Button>
          ) : null
        }
      />
      <DataTable
        id="builder-pages"
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        loading={pages.isLoading}
        error={pages.error}
        onRowClick={edit}
        searchPlaceholder="Search by title or path"
        sortOptions={PAGE_SORTS}
        total={pages.data?.pages?.totalCount ?? null}
        pageInfo={pages.data?.pages?.pageInfo}
        page={cursor.page}
        onNext={cursor.next}
        onPrev={cursor.prev}
        exportName="pages"
        filters={
          <>
            <FilterSelect param="type" label="Type" options={pageTypes.map((c) => ({ value: c.code, label: c.name }))} />
            <FilterSelect param="status" label="Status" options={PAGE_STATUSES.map((s) => ({ value: s.value, label: s.label }))} />
          </>
        }
        empty={
          !pages.isLoading && !filtered && rows.length === 0 ? (
            <EmptyState
              icon={LayoutTemplate}
              title="No pages yet"
              description={pageTypes.length ? "Create a landing page, the site header or footer, and edit it on your storefront." : "Add a content type in Components first; pages are built from them."}
              action={
                write && pageTypes.length ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus /> New page
                  </Button>
                ) : undefined
              }
            />
          ) : undefined
        }
      />
      <NewPageDialog
        open={creating}
        onOpenChange={setCreating}
        contentTypes={pageTypes}
        onCreated={(id) => {
          void queryClient.invalidateQueries({ queryKey: BUILDER_KEYS.pages });
          void navigate({ to: "/pages/$id", params: { id: rawIdOf(id) } });
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.title ? `“${deleting.title}”` : "this page"}?`}
        description={
          deleting?.templateFor
            ? targetsSummary(deleting.templateTargets) !== "Not assigned"
              ? `It is assigned (${targetsSummary(deleting.templateTargets)}): those ${TEMPLATE_KINDS[deleting.templateFor].pages} fall back to the next template that applies, or the storefront's built-in layout. Its history is deleted too. This cannot be undone.`
              : "The template and its history are deleted. This cannot be undone."
            : deleting?.publishedPath
              ? `It is live at ${deleting.publishedPath}; deleting takes it offline and removes its history. Consider unpublishing instead, or a redirect to a replacement.`
              : "The page and its history are deleted. This cannot be undone."
        }
        confirmLabel={deleting?.templateFor ? "Delete template" : "Delete page"}
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Page>
  );
};

// ---------------------------------------------------------------- new page

const NewPageDialog = ({ open, onOpenChange, contentTypes, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; contentTypes: ComponentDef[]; onCreated: (id: string) => void }) => {
  const { channels, defaultLocale } = useReference();
  const singletons = contentTypes.filter((c) => c.singleton);
  // Singletons that already have their page cannot get another.
  const existing = useQueries({
    queries: singletons.map((c) => ({ queryKey: ["pages", "singleton", c.code], queryFn: () => request(SingletonPageQuery, { type: c.code }), enabled: open, staleTime: 10_000 })),
  });
  const taken = new Map(singletons.map((c, i) => [c.code, existing[i]?.data?.singletonPage?.id ?? null]));
  const available = contentTypes.filter((c) => !taken.get(c.code));
  const [type, setType] = useState<string>("");
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ title?: string; path?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const chosen = contentTypes.find((c) => c.code === type);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setPath("");
    setPathEdited(false);
    setChannelIds([]);
    setErrors({});
    setType((current) => current || "");
  }, [open]);
  // Pick the first available type once singletons are known.
  useEffect(() => {
    if (open && (!type || taken.get(type)) && available[0]) setType(available.find((c) => c.code === "landing_page")?.code ?? available[0].code);
  }, [open, available.map((c) => c.code).join()]);

  const normalized = path ? normalizePath(path) : "";
  const pathError = chosen?.routable ? (!path.trim() ? (title ? "A path is required" : undefined) : (pathProblem(normalized) ?? undefined)) : undefined;
  const submit = async () => {
    if (!chosen) return;
    if (!title.trim()) return setErrors({ title: "Give the page a title" });
    if (chosen.routable && (!path.trim() || pathProblem(normalized))) return setErrors({ path: pathProblem(normalized) ?? "A path is required" });
    setBusy(true);
    setErrors({});
    try {
      const page = unwrap(
        (await request(PageCreateMutation, { input: { type: chosen.code, titles: [{ locale: defaultLocale, value: title.trim() }], path: chosen.routable ? normalized : null, channelIds } })).pageCreate,
      ).page;
      toast.success(`Created ${title.trim()}`);
      onOpenChange(false);
      if (page) onCreated(page.id);
    } catch (error) {
      if (error instanceof MutationError && error.fieldErrors.length) {
        const pathMessage = error.fieldErrors.find((f) => f.path.includes("path"))?.message;
        setErrors({ path: pathMessage, form: pathMessage ? undefined : error.fieldErrors.map((f) => f.message).join(" ") });
      } else setErrors({ form: error instanceof Error ? error.message : "Could not create the page" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New page</DialogTitle>
          <DialogDescription>Choose what kind of page it is. You add its components in the visual editor next.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Content type">
            {contentTypes.map((c) => {
              const existingId = taken.get(c.code);
              const selected = c.code === type;
              return (
                <button
                  key={c.code}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!!existingId}
                  onClick={() => setType(c.code)}
                  className={cn(
                    "relative flex gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
                    selected && "border-primary bg-primary/5 ring-1 ring-primary/30",
                  )}
                >
                  <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground", selected && "border-primary/30 text-primary")}>
                    <ComponentIcon name={c.icon} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{c.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {c.description || (c.templateFor ? `A template for ${TEMPLATE_KINDS[c.templateFor].pages}.` : c.routable ? "A page at its own path." : "Shown on every page.")}
                    </span>
                    {existingId ? (
                      <Link to="/pages/$id" params={{ id: rawIdOf(existingId) }} onClick={(e) => e.stopPropagation()} className="mt-1 inline-block text-xs text-primary hover:underline">
                        Already exists — edit it
                      </Link>
                    ) : c.templateFor ? (
                      <span className="mt-1 inline-block text-[11px] text-info">{TEMPLATE_KINDS[c.templateFor].template} · no path</span>
                    ) : c.singleton ? (
                      <span className="mt-1 inline-block text-[11px] text-muted-foreground">One per store</span>
                    ) : null}
                  </span>
                  {selected ? <Check className="absolute top-2.5 right-2.5 size-4 text-primary" /> : null}
                </button>
              );
            })}
          </div>
          {chosen ? (
            <div className="grid gap-4">
              <Field label={`Title${channels.length && defaultLocale ? ` (${languageName(defaultLocale)})` : ""}`} required error={errors.title} hint="Translate it in the editor.">
                <Input
                  autoFocus
                  value={title}
                  placeholder={chosen.routable ? "Summer sale" : chosen.name}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (!pathEdited && chosen.routable) setPath(e.target.value.trim() ? pathFromTitle(e.target.value) : "");
                  }}
                />
              </Field>
              {chosen.routable ? (
                <Field label="Path" required error={errors.path ?? pathError} hint="Where the storefront serves the page. Lowercase letters, digits and hyphens.">
                  <div className="flex gap-1.5">
                    <Input
                      className="font-mono"
                      value={path}
                      placeholder="/summer-sale"
                      onChange={(e) => {
                        setPath(e.target.value);
                        setPathEdited(true);
                      }}
                      onBlur={() => path && !pathProblem(normalized) && setPath(normalized)}
                    />
                    <Tooltip content="Generate from the title">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Generate the path from the title"
                        onClick={() => {
                          setPath(pathFromTitle(title));
                          setPathEdited(false);
                        }}
                      >
                        <WandSparkles />
                      </Button>
                    </Tooltip>
                  </div>
                </Field>
              ) : null}
              {chosen.templateFor ? (
                <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  <Info className="mt-px size-3.5 shrink-0" />
                  <span>
                    A template has no path: {TEMPLATE_KINDS[chosen.templateFor].pages} render with it. In the editor&apos;s page settings, assign it to {TEMPLATE_KINDS[chosen.templateFor].many} or make it the default;
                    until then only previews use it.
                  </span>
                </p>
              ) : null}
              <Field label="Channels" hint={chosen.templateFor ? "Where the template is used. Empty means every channel." : "Where the page is served. Empty means every channel."}>
                <MultiSelect options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "Channel" }))} value={channelIds} onChange={setChannelIds} placeholder="Every channel" />
              </Field>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Every content type already has its page.</p>
          )}
          {errors.form ? <p className="text-sm text-destructive">{errors.form}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!chosen || !title.trim() || !!pathError}>
              Create and edit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

