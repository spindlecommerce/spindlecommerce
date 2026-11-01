import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Braces, ChevronDown, Component as ComponentGlyph, Download, FileUp, LayoutGrid, LayoutTemplate, List, Plus, Search, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useDebounced, useListSearch } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { fieldsOf, variationsOf } from "./library/definition";
import { DeployFromCodePanel, ImportDialog } from "./library/import-export";
import { ComponentsQuery, LIBRARY_KEY, useExportDefinitions, type LibraryComponent } from "./library/queries";
import { IconTile } from "./library/icons";
import { SectionsForBadge, SourceBadge, TemplateForBadge } from "./library/ui";
import { TEMPLATE_KINDS } from "./model";

const UNGROUPED = "Ungrouped";

/** "Product template", "Product data" or "Product sections", so searching for them finds them. */
const templateWords = (c: LibraryComponent) =>
  c.templateFor ? (c.kind === "CONTENT_TYPE" ? TEMPLATE_KINDS[c.templateFor].template : TEMPLATE_KINDS[c.templateFor].data) : c.sectionsFor ? TEMPLATE_KINDS[c.sectionsFor].sections : null;

const matches = (c: LibraryComponent, q: string) => {
  if (!q) return true;
  const haystack = [c.name, c.code, c.description, c.groupName, templateWords(c), ...fieldsOf(c.fields).flatMap((f) => [f.key, f.label])].filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const ComponentsPage = () => {
  const { can } = useAuth();
  const write = can("content:write");
  const navigate = useNavigate();
  const [search, setSearch] = useListSearch();
  const query = useQuery({ queryKey: [...LIBRARY_KEY], queryFn: ({ signal }) => request(ComponentsQuery, undefined, { signal }) });
  const [text, setText] = useState(search.q ?? "");
  const debounced = useDebounced(text.trim(), 200);
  useEffect(() => {
    // Only the typed text drives the URL here.
    if ((search.q ?? "") !== debounced) setSearch({ q: debounced || undefined });
  }, [debounced]);
  const [importing, setImporting] = useState(false);
  const [deployHelp, setDeployHelp] = useState(false);
  const exporter = useExportDefinitions();

  const all = useMemo(() => query.data?.components ?? [], [query.data]);
  const source = search.source === "CODE" || search.source === "ADMIN" ? search.source : null;
  const view = search.view === "table" ? "table" : "cards";
  const visible = all.filter((c) => (!source || c.source === source) && matches(c, debounced));
  const contentTypeGroups = groupByName(visible.filter((c) => c.kind === "CONTENT_TYPE"));
  const groups = groupByName(visible.filter((c) => c.kind === "COMPONENT"));
  const contentTypeCount = contentTypeGroups.reduce((n, g) => n + g.items.length, 0);
  const componentCount = groups.reduce((n, g) => n + g.items.length, 0);
  const fromCode = all.filter((c) => c.source === "CODE").length;
  const filtered = !!debounced || !!source;
  const open = (c: LibraryComponent) => void navigate({ to: "/components/$id", params: { id: c.id } });

  return (
    <Page wide>
      <PageHeader
        title="Components"
        description="The building blocks of pages: content types are the root of a page, components nest inside their blocks fields. Editors fill in the fields; storefronts render each component by its code."
        actions={
          <>
            <Button variant="outline" onClick={() => setDeployHelp(true)}>
              <Terminal />
              Deploy from code
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Braces />
                  JSON
                  <ChevronDown className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                {write ? (
                  <DropdownMenuItem onSelect={() => setImporting(true)}>
                    <FileUp />
                    Import definitions…
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem disabled={exporter.pending || !all.length} onSelect={() => void exporter.run()}>
                  <Download />
                  Export all as JSON
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {write ? (
              <>
                <Button variant="outline" asChild>
                  <Link to="/components/new" search={{ kind: "CONTENT_TYPE" }}>
                    <LayoutTemplate />
                    New content type
                  </Link>
                </Button>
                <Button asChild>
                  <Link to="/components/new" search={{ kind: "COMPONENT" }}>
                    <Plus />
                    New component
                  </Link>
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search names, codes, groups and fields" aria-label="Search components" className="h-9 pl-8" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant={source ? "secondary" : "outline"} className={cn(source && "border border-primary/30")}>
              Source
              {source ? <span className="font-normal text-muted-foreground">: {source === "CODE" ? "Code" : "Admin"}</span> : null}
              <ChevronDown className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Where definitions come from</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={!source} onCheckedChange={() => setSearch({ source: undefined })}>
              Any
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={source === "CODE"} onCheckedChange={() => setSearch({ source: "CODE" })}>
              Code (deployed with componentsSync)
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={source === "ADMIN"} onCheckedChange={() => setSearch({ source: "ADMIN" })}>
              Admin (edited here)
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              setSearch({ q: undefined, source: undefined });
            }}
          >
            <X />
            Reset
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {query.data ? (
            <span className="text-[13px] text-muted-foreground">
              {plural(contentTypeCount, "content type")} · {plural(componentCount, "component")}
              {fromCode ? ` · ${fromCode} from code` : ""}
            </span>
          ) : null}
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Layout">
            <Tooltip content="Cards">
              <Button variant={view === "cards" ? "secondary" : "ghost"} size="icon-sm" className="size-7" aria-pressed={view === "cards"} aria-label="Show as cards" onClick={() => setSearch({ view: undefined })}>
                <LayoutGrid />
              </Button>
            </Tooltip>
            <Tooltip content="Table">
              <Button variant={view === "table" ? "secondary" : "ghost"} size="icon-sm" className="size-7" aria-pressed={view === "table"} aria-label="Show as a table" onClick={() => setSearch({ view: "table" })}>
                <List />
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>

      {query.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : query.error ? (
        <Card>
          <EmptyState icon={ComponentGlyph} title="Could not load the library" description={query.error instanceof Error ? query.error.message : undefined} />
        </Card>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={ComponentGlyph}
            title="No components yet"
            description="Start with a content type (e.g. a landing page with a sections field), then add the components editors place inside it. Or deploy definitions from your storefront's code."
            action={
              write ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button asChild>
                    <Link to="/components/new" search={{ kind: "CONTENT_TYPE" }}>
                      New content type
                    </Link>
                  </Button>
                  <Button variant="outline" onClick={() => setImporting(true)}>
                    <FileUp />
                    Import JSON
                  </Button>
                </div>
              ) : undefined
            }
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={Search} title="No components match" description="Try another search, or clear the filters." />
        </Card>
      ) : view === "table" ? (
        <LibraryTable contentTypeGroups={contentTypeGroups} groups={groups} onOpen={open} />
      ) : (
        <div className="flex flex-col gap-8">
          {contentTypeCount ? (
            <Section title="Content types" count={contentTypeCount} description="The root of a page: what editors create from the Pages screen.">
              <GroupedCards groups={contentTypeGroups} />
            </Section>
          ) : null}
          {componentCount ? (
            <Section title="Components" count={componentCount} description="Placed inside blocks fields, grouped as editors see them in the picker.">
              <GroupedCards groups={groups} />
            </Section>
          ) : null}
        </div>
      )}

      <ImportDialog open={importing} onOpenChange={setImporting} library={all} />
      <DeployFromCodePanel open={deployHelp} onOpenChange={setDeployHelp} />
    </Page>
  );
};

type Group = { name: string; items: LibraryComponent[] };

/** By groupName, alphabetically, ungrouped last, as the page editor's picker shows them. */
const groupByName = (items: readonly LibraryComponent[]): Group[] => {
  const byGroup = new Map<string, LibraryComponent[]>();
  for (const c of items) {
    const group = c.groupName?.trim() || UNGROUPED;
    byGroup.set(group, [...(byGroup.get(group) ?? []), c]);
  }
  return [...byGroup.entries()]
    .sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)))
    .map(([name, list]) => ({ name, items: list.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")) }));
};

const showGroups = (groups: readonly Group[]) => groups.length > 1 || (groups[0] !== undefined && groups[0].name !== UNGROUPED);

const GroupedCards = ({ groups }: { groups: Group[] }) =>
  showGroups(groups) ? (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.name} className="flex flex-col gap-2.5">
          <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {group.name}
            <span className="rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tracking-normal normal-case">{group.items.length}</span>
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.items.map((c) => (
              <ComponentCard key={c.id} component={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {groups.flatMap((g) => g.items).map((c) => (
        <ComponentCard key={c.id} component={c} />
      ))}
    </div>
  );

const Section = ({ title, count, description, children }: { title: string; count: number; description: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <div>
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        {title}
        <Badge variant="secondary">{count}</Badge>
      </h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
    </div>
    {children}
  </section>
);

const Stat = ({ value, label, strong }: { value: number; label: string; strong?: boolean }) => (
  <span className={cn(strong && value > 0 && "text-foreground")}>
    <span className="font-medium tabular">{value}</span> {label}
    {value === 1 ? "" : "s"}
  </span>
);

const ComponentCard = ({ component: c }: { component: LibraryComponent }) => {
  const fields = fieldsOf(c.fields).length;
  const variations = variationsOf(c.variations).length;
  const usage = c.usageCount ?? 0;
  return (
    <Link
      to="/components/$id"
      params={{ id: c.id }}
      className="group flex flex-col rounded-xl border bg-card p-4 shadow-xs transition-[border-color,box-shadow] outline-none hover:border-primary/40 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-start gap-3">
        <IconTile name={c.icon} kind={c.kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium transition-colors group-hover:text-primary">{c.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{c.code}</p>
        </div>
        <SourceBadge source={c.source} />
      </div>
      <p className={cn("mt-3 line-clamp-2 min-h-[2.5rem] text-[13px] leading-5", c.description ? "text-muted-foreground" : "text-muted-foreground/60 italic")}>{c.description || "No description"}</p>
      {c.kind === "CONTENT_TYPE" ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {c.templateFor ? (
            <TemplateForBadge templateFor={c.templateFor} kind={c.kind} />
          ) : c.sectionsFor ? (
            <SectionsForBadge sectionsFor={c.sectionsFor} />
          ) : (
            <Badge variant="outline">{c.routable ? "Has a path" : "No path"}</Badge>
          )}
          {c.singleton ? <Badge variant="outline">Singleton</Badge> : null}
        </div>
      ) : c.templateFor ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <TemplateForBadge templateFor={c.templateFor} kind={c.kind} />
        </div>
      ) : null}
      <div className="min-h-3 flex-1" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <Stat value={fields} label="field" />
        <Stat value={variations} label="variation" />
        <Tooltip content={usage ? "Pages whose draft or published version uses it" : "No page uses it yet"}>
          <span className={cn(usage > 0 && "text-foreground")}>
            Used on <span className="font-medium tabular">{usage}</span> page{usage === 1 ? "" : "s"}
          </span>
        </Tooltip>
        <Tooltip content={`Updated ${formatDateTime(c.updatedAt)}`}>
          <span className="ml-auto">{relativeTime(c.updatedAt)}</span>
        </Tooltip>
      </div>
    </Link>
  );
};

const LibraryTable = ({ contentTypeGroups, groups, onOpen }: { contentTypeGroups: Group[]; groups: Group[]; onOpen: (c: LibraryComponent) => void }) => {
  const label = (kind: string, list: Group[], group: Group) => (showGroups(list) ? `${kind} · ${group.name}` : kind);
  const sections = [...contentTypeGroups.map((g) => ({ name: label("Content types", contentTypeGroups, g), items: g.items })), ...groups.map((g) => ({ name: label("Components", groups, g), items: g.items }))];
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Component</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Fields</TableHead>
            <TableHead className="text-right">Variations</TableHead>
            <TableHead className="text-right">Used on</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.map((section) => [
            <TableRow key={`h-${section.name}`} className="bg-muted/40 hover:bg-muted/40">
              <TableCell colSpan={7} className="py-1.5 text-xs font-semibold text-muted-foreground">
                {section.name} <span className="font-normal">({section.items.length})</span>
              </TableCell>
            </TableRow>,
            ...section.items.map((c) => (
              <TableRow key={c.id} className="cursor-pointer" onClick={() => onOpen(c)}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <IconTile name={c.icon} kind={c.kind} size="sm" />
                    <div className="min-w-0">
                      <Link to="/components/$id" params={{ id: c.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {c.name}
                      </Link>
                      <p className="max-w-md truncate font-mono text-xs text-muted-foreground">{c.code}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{c.kind === "CONTENT_TYPE" ? `Content type${c.singleton ? " · singleton" : ""}` : "Component"}</span>
                    <TemplateForBadge templateFor={c.templateFor} kind={c.kind} />
                    <SectionsForBadge sectionsFor={c.sectionsFor} />
                  </span>
                </TableCell>
                <TableCell className="tabular text-right">{fieldsOf(c.fields).length}</TableCell>
                <TableCell className="tabular text-right">{variationsOf(c.variations).length}</TableCell>
                <TableCell className={cn("tabular text-right whitespace-nowrap", !c.usageCount && "text-muted-foreground")}>{plural(c.usageCount ?? 0, "page")}</TableCell>
                <TableCell>
                  <SourceBadge source={c.source} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <Tooltip content={formatDateTime(c.updatedAt)}>
                    <span>{relativeTime(c.updatedAt)}</span>
                  </Tooltip>
                </TableCell>
              </TableRow>
            )),
          ])}
        </TableBody>
      </Table>
    </Card>
  );
};

