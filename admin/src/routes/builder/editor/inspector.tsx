import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronRight, Copy, Eye, EyeOff, Globe, Plus, Search, Trash2, WandSparkles } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { SectionTabsList, SectionTabsTrigger, Switch, Tabs, TabsContent } from "@/components/ui/controls";
import { Alert } from "@/components/ui/feedback";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/overlay";
import { request, unwrap } from "@/lib/api";
import { formatDateTime, languageName, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { nodeLabel, TEMPLATE_KINDS, textIn, visibleFields, withText, type FieldDefinition, type NodeVisibility, type PageNode, type PageSeo } from "../model";
import { PageSettingsMutation, storefrontUrl } from "./api";
import { FieldShell, ImageEditor, LocaleDots, ValueEditor } from "./fields";
import { ComponentIcon } from "./icons";
import { useEditor, useEditorState } from "./store";
import { OwnerLink } from "./sections";
import { StatusBadge } from "./status";
import { TEMPLATE_FOCUS, TemplateSettings } from "./template";
import { docTitle, fromLocalInput, indexTree, issuesForNode, MOD, nodeLimits, normalizePath, pageIssues, pathFromTitle, pathProblem, toLocalInput } from "./util";

/** The selected component's fields, or the page's settings when nothing or the page is selected. */

const DEFAULT_GROUP = "Content";
const VISIBILITY_TAB = "Visibility";
const TEMPLATE_TAB = "Template";

const groupsOf = (fields: readonly FieldDefinition[]) => {
  const groups: string[] = [];
  for (const field of fields) {
    const group = field.group || DEFAULT_GROUP;
    if (!groups.includes(group)) groups.push(group);
  }
  // Content first, whatever order the definition lists groups in.
  return groups.sort((a, b) => (a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : 0));
};

/** Scroll to the selected field and focus it (unless only revealing it), flashing it briefly. */
const useFocusField = (container: React.RefObject<HTMLElement | null>, path: string, request: number, ready: boolean) => {
  const { store } = useEditor();
  useEffect(() => {
    if (!request || !ready) return;
    const reveal = store.get().focusMode === "reveal";
    const frame = requestAnimationFrame(() => {
      const root = container.current;
      if (!root) return;
      // The deepest element for the path: "items.itemId.question", else "items.itemId", else "items".
      const parts = path.split(".").filter(Boolean);
      let target: HTMLElement | null = null;
      for (let n = parts.length; n > 0 && !target; n--) target = root.querySelector<HTMLElement>(`[data-field-path="${CSS.escape(parts.slice(0, n).join("."))}"]`);
      // No field named (a newly added component): its first content field, not the variation picker.
      target ??= root.querySelector<HTMLElement>('[role="tabpanel"] [data-field-path]:not([data-field-path^="@"])') ?? root.querySelector<HTMLElement>("[data-field-path]");
      if (!target) return;
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (!reveal) (target.querySelector<HTMLElement>("input:not([type=hidden]):not([type=file]), textarea, [role=combobox], button[role=switch], select, button[aria-haspopup]") ?? target.querySelector<HTMLElement>("button:not([disabled])"))?.focus({ preventScroll: true });
      target.dataset.flash = "true";
      setTimeout(() => delete target.dataset.flash, 900);
    });
    return () => cancelAnimationFrame(frame);
  }, [request, ready]);
};

export const Inspector = () => {
  const { defs } = useEditor();
  const selectedId = useEditorState((s) => s.selection?.nodeId ?? null);
  const rootId = useEditorState((s) => s.doc.root.id);
  const exists = useEditorState((s) => !selectedId || indexTree(s.doc.root, defs).has(selectedId));
  if (!selectedId || selectedId === rootId) return <PageSettings />;
  if (!exists) return <MissingNode />;
  return <NodeInspector key={selectedId} nodeId={selectedId} />;
};

const MissingNode = () => {
  const { actions } = useEditor();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p>That component is no longer on the page.</p>
      <Button variant="outline" size="sm" onClick={() => actions.select(null)}>
        Show page settings
      </Button>
    </div>
  );
};

const PanelHeader = ({ icon, title, subtitle, actions }: { icon: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) => (
  <div className="flex items-start gap-2.5 border-b px-4 pt-3.5 pb-3">
    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</span>
    <div className="min-w-0 flex-1">
      <h2 className="truncate text-sm font-semibold">{title}</h2>
      {subtitle ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div> : null}
    </div>
    {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
  </div>
);

const HeaderButton = ({ label, onClick, children, destructive, disabled }: { label: string; onClick: () => void; children: ReactNode; destructive?: boolean; disabled?: boolean }) => (
  <Tooltip content={label}>
    <span>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled} className={cn("size-7 text-muted-foreground", destructive && "hover:text-destructive")}>
        {children}
      </Button>
    </span>
  </Tooltip>
);

// ---------------------------------------------------------------- a component

const NodeInspector = ({ nodeId }: { nodeId: string }) => {
  const { actions, defs, locales } = useEditor();
  const node = useEditorState((s) => indexTree(s.doc.root, defs).get(nodeId)?.node ?? null);
  const trail = useEditorState((s) => indexTree(s.doc.root, defs).get(nodeId)?.trail);
  const root = useEditorState((s) => s.doc.root);
  const locale = useEditorState((s) => s.locale);
  const issues = useEditorState((s) => s.issues);
  const saveIssues = useEditorState((s) => s.saveIssues);
  const selectionPath = useEditorState((s) => (s.selection?.nodeId === nodeId ? s.selection.path.join(".") : ""));
  const focusRequest = useEditorState((s) => s.focusRequest);
  const container = useRef<HTMLDivElement>(null);
  const def = node ? defs.get(node.component) : undefined;
  const fields = useMemo(() => (def && node ? visibleFields(def, node) : []), [def, node?.variation]);
  const groups = useMemo(() => [...groupsOf(fields), VISIBILITY_TAB], [fields]);
  const nodeIssues = useMemo(() => issuesForNode([...issues, ...saveIssues], nodeId), [issues, saveIssues, nodeId]);
  const [tab, setTab] = useState(groups[0]!);

  // A field picked in the preview may be on another tab.
  useEffect(() => {
    if (!focusRequest) return;
    const key = selectionPath.split(".")[0];
    if (!key) return;
    if (key === "@visibility" || key === "@hidden") return setTab(VISIBILITY_TAB);
    const field = fields.find((f) => f.key === key);
    if (field) setTab(field.group || DEFAULT_GROUP);
  }, [focusRequest]);
  useFocusField(container, selectionPath, focusRequest, !!node);

  if (!node) return null;
  if (!def) {
    return (
      <div className="p-4">
        <Alert variant="warning" title={`Unknown component ${node.component}`}>
          It is not in the component library, so it cannot be edited. Remove it, or add the component back in Components.
        </Alert>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => actions.remove(nodeId)}>
          <Trash2 />
          Remove
        </Button>
      </div>
    );
  }
  const parents = (trail ?? []).map((id) => indexTree(root, defs).get(id)?.node).filter((n): n is PageNode => !!n);
  const limits = nodeLimits(root, defs, nodeId);
  const hasVisibility = !!node.visibility && (!!node.visibility.channelIds?.length || !!node.visibility.locales?.length || !!node.visibility.from || !!node.visibility.until);
  const errorCount = (group: string) => fields.filter((f) => (f.group || DEFAULT_GROUP) === group && [...nodeIssues.fields.keys()].some((k) => k === f.key || k.startsWith(`${f.key}.`))).length;
  const variation = def.variations.find((v) => v.code === (node.variation ?? def.variations[0]?.code));

  return (
    <div ref={container} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        icon={<ComponentIcon name={def.icon} />}
        title={
          <span className="flex items-center gap-1.5">
            {def.name}
            {node.hidden ? (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                Hidden
              </Badge>
            ) : null}
          </span>
        }
        subtitle={
          <span className="flex min-w-0 items-center gap-0.5">
            {parents.map((p, i) => (
              <span key={p.id} className="flex min-w-0 items-center gap-0.5">
                {i > 0 ? <ChevronRight className="size-3 shrink-0" /> : null}
                <button type="button" className="truncate hover:text-foreground hover:underline" onClick={() => actions.select(i === 0 ? null : { nodeId: p.id, path: [] })}>
                  {i === 0 ? "Page" : nodeLabel(p, defs, locale)}
                </button>
              </span>
            ))}
          </span>
        }
        actions={
          <>
            <HeaderButton label={node.hidden ? "Show on the storefront" : "Hide on the storefront"} onClick={() => actions.toggleHidden(nodeId)}>
              {node.hidden ? <EyeOff /> : <Eye />}
            </HeaderButton>
            <HeaderButton label={`Duplicate (${MOD}D)`} disabled={!limits?.abilities.duplicate} onClick={() => actions.duplicate(nodeId)}>
              <Copy />
            </HeaderButton>
            <HeaderButton label={limits?.abilities.remove === false ? `${limits.field?.label ?? "This field"} needs at least ${limits.min}` : "Delete (⌫)"} destructive disabled={limits?.abilities.remove === false} onClick={() => actions.remove(nodeId)}>
              <Trash2 />
            </HeaderButton>
          </>
        }
      />
      {def.variations.length > 1 ? (
        <div data-field-path="@variation" className="border-b px-4 py-2.5 transition-colors data-[flash=true]:bg-primary/8">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">Variation</span>
            <Select
              aria-label="Variation"
              className="h-8"
              value={node.variation ?? def.variations[0]!.code}
              options={def.variations.map((v) => ({ value: v.code, label: v.name, description: v.description }))}
              onValueChange={(code) => actions.setNode(nodeId, { variation: code })}
            />
          </div>
          {nodeIssues.fields.get("variation") ? <p className="mt-1 text-xs text-destructive">{nodeIssues.fields.get("variation")}</p> : variation?.description ? <p className="mt-1 pl-[4.5rem] text-xs text-muted-foreground">{variation.description}</p> : null}
        </div>
      ) : null}
      {nodeIssues.self.length ? (
        <div className="border-b px-4 py-2.5">
          <Alert variant="destructive">{nodeIssues.self.join(" ")}</Alert>
        </div>
      ) : null}
      <Tabs value={groups.includes(tab) ? tab : groups[0]!} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <SectionTabsList className="shrink-0 gap-4 overflow-x-auto px-4 pt-2">
          {groups.map((group) => (
            <SectionTabsTrigger key={group} value={group} className="flex items-center gap-1 pb-2 text-[13px]">
              {group}
              {group === VISIBILITY_TAB && (node.hidden || hasVisibility) ? <span className="size-1.5 rounded-full bg-warning" /> : null}
              {errorCount(group) ? <span className="rounded-full bg-destructive px-1.5 text-[10px] leading-4 font-semibold text-white">{errorCount(group)}</span> : null}
            </SectionTabsTrigger>
          ))}
        </SectionTabsList>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group) =>
            group === VISIBILITY_TAB ? (
              <TabsContent key={group} value={group} className="p-4">
                <VisibilityEditor node={node} />
              </TabsContent>
            ) : (
              <TabsContent key={group} value={group} className="flex flex-col gap-5 p-4">
                {fields
                  .filter((f) => (f.group || DEFAULT_GROUP) === group)
                  .map((field) => (
                    <NodeField
                      key={field.key}
                      nodeId={nodeId}
                      field={field}
                      value={node.fields[field.key]}
                      locale={locale}
                      locales={locales}
                      error={nodeIssues.fields.get(field.key) ?? null}
                      errors={nodeIssues.fields}
                      openItem={selectionPath.startsWith(`${field.key}.`) ? (selectionPath.split(".")[1] ?? null) : null}
                    />
                  ))}
                {fields.every((f) => (f.group || DEFAULT_GROUP) !== group) ? <p className="text-sm text-muted-foreground">No fields here.</p> : null}
              </TabsContent>
            ),
          )}
        </div>
      </Tabs>
    </div>
  );
};

/** Memoized, so typing re-renders only this field. */
export const NodeField = memo(
  ({
    nodeId,
    field,
    value,
    locale,
    locales,
    error,
    errors,
    openItem,
  }: {
    nodeId: string;
    field: FieldDefinition;
    value: unknown;
    locale: string;
    locales: readonly string[];
    error: string | null;
    errors: ReadonlyMap<string, string>;
    openItem: string | null;
  }) => {
    const { actions, store } = useEditor();
    const id = useId();
    const onChange = useCallback((next: unknown) => actions.setField(nodeId, field.key, next), [actions, nodeId, field.key]);
    const onText = useCallback((text: string) => actions.patchPreview(nodeId, [field.key], text), [actions, nodeId, field.key]);
    const onItemText = useCallback((itemId: string, subKey: string, text: string) => actions.patchPreview(nodeId, [field.key, itemId, subKey], text), [actions, nodeId, field.key]);
    const onLocale = useCallback((next: string) => store.set({ locale: next }), [store]);
    if (field.type === "blocks") return <BlocksField nodeId={nodeId} field={field} value={value} error={error} locale={locale} />;
    return (
      <FieldShell
        path={field.key}
        label={field.label}
        required={field.required}
        description={field.description}
        error={error}
        htmlFor={id}
        inline={field.type === "boolean"}
        aside={field.localized ? <LocaleDots value={value} locale={locale} locales={locales} onLocale={onLocale} /> : null}
      >
        <ValueEditor
          id={id}
          field={field}
          value={value}
          onChange={onChange}
          locale={locale}
          locales={locales}
          invalid={!!error}
          onText={field.type === "text" ? onText : undefined}
          focusPath={field.key}
          errors={errors}
          errorPrefix={`${field.key}.`}
          openItem={openItem}
          onItemText={onItemText}
          onLocale={onLocale}
        />
      </FieldShell>
    );
  },
);

/** A blocks field's components, to select or add to; the tree does the rest. */
const BlocksField = ({ nodeId, field, value, error, locale }: { nodeId: string; field: FieldDefinition; value: unknown; error: string | null; locale: string }) => {
  const { actions, defs } = useEditor();
  const children = Array.isArray(value) ? (value as PageNode[]) : [];
  const full = field.max != null && children.length >= field.max;
  return (
    <FieldShell path={field.key} label={field.label} required={field.required || !!field.min} description={field.description} error={error}>
      <div className="flex flex-col gap-1">
        {children.length ? (
          <ul className="flex flex-col overflow-hidden rounded-md border">
            {children.map((child) => {
              const def = defs.get(child.component);
              return (
                <li key={child.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => actions.select({ nodeId: child.id, path: [] })}
                    onMouseEnter={() => actions.hover(child.id)}
                    onMouseLeave={() => actions.hover(null)}
                    className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-accent/60", child.hidden && "text-muted-foreground")}
                  >
                    <ComponentIcon name={def?.icon} className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{nodeLabel(child, defs, locale)}</span>
                    {def && nodeLabel(child, defs, locale) !== def.name ? <span className="shrink-0 text-[11px] text-muted-foreground">{def.name}</span> : null}
                    {child.hidden ? <EyeOff className="size-3.5 shrink-0" /> : null}
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">Empty</p>
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => actions.openPicker({ parentId: nodeId, fieldKey: field.key })}>
            <Plus />
            Add to {field.label.toLowerCase()}
          </Button>
          <span className="text-xs text-muted-foreground">
            {children.length}
            {field.max != null ? ` / ${field.max}` : ""}
          </span>
        </div>
      </div>
    </FieldShell>
  );
};

// ---------------------------------------------------------------- visibility

const cleanVisibility = (v: NodeVisibility): NodeVisibility | undefined => {
  const next: NodeVisibility = {};
  if (v.channelIds?.length) next.channelIds = v.channelIds;
  if (v.locales?.length) next.locales = v.locales;
  if (v.from) next.from = v.from;
  if (v.until) next.until = v.until;
  return Object.keys(next).length ? next : undefined;
};

const VisibilityEditor = ({ node }: { node: PageNode }) => {
  const { actions, channels, locales } = useEditor();
  const visibility = node.visibility ?? {};
  const set = (patch: Partial<NodeVisibility>, coalesce?: string) => actions.setNode(node.id, { visibility: cleanVisibility({ ...visibility, ...patch }) }, coalesce);
  const channelNames = (visibility.channelIds ?? []).map((id) => channels.find((c) => c.id === id)?.name ?? "a channel");
  const late = visibility.from && visibility.until && Date.parse(visibility.until) <= Date.parse(visibility.from);
  const summary = node.hidden
    ? "Hidden: not shown anywhere until you switch it back on."
    : [
        channelNames.length ? `Only in ${channelNames.join(", ")}` : "In every channel",
        visibility.locales?.length ? `only in ${visibility.locales.map(languageName).join(", ")}` : "every language",
        visibility.from || visibility.until ? `${visibility.from ? `from ${formatDateTime(visibility.from)}` : ""}${visibility.from && visibility.until ? " " : ""}${visibility.until ? `until ${formatDateTime(visibility.until)}` : ""}` : "always",
      ].join(", ") + ".";
  return (
    <div className="flex flex-col gap-5" data-field-path="@visibility">
      <div data-field-path="@hidden" className="flex items-start justify-between gap-3 rounded-lg border p-3 data-[flash=true]:bg-primary/8">
        <div>
          <p className="text-[13px] font-medium">Hide this component</p>
          <p className="mt-0.5 text-xs text-muted-foreground">It stays in the draft but is not shown on the storefront.</p>
        </div>
        <Switch checked={!!node.hidden} onCheckedChange={(checked) => actions.setNode(node.id, { hidden: checked || undefined })} aria-label="Hidden" />
      </div>
      <div className={cn("flex flex-col gap-4", node.hidden && "pointer-events-none opacity-50")}>
        <FieldShell path="@visibility.channels" label="Channels" description="Empty shows it in every channel the page is in.">
          <MultiSelect options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "Channel" }))} value={visibility.channelIds ?? []} onChange={(channelIds) => set({ channelIds })} placeholder="Every channel" />
        </FieldShell>
        <FieldShell path="@visibility.locales" label="Languages" description="Empty shows it in every language.">
          <MultiSelect options={locales.map((l) => ({ value: l, label: languageName(l), hint: l }))} value={visibility.locales ?? []} onChange={(next) => set({ locales: next })} placeholder="Every language" />
        </FieldShell>
        <div className="grid grid-cols-2 gap-3">
          <FieldShell path="@visibility.from" label="Show from">
            <Input type="datetime-local" className="text-[13px]" value={toLocalInput(visibility.from)} onChange={(e) => set({ from: fromLocalInput(e.target.value) }, "from")} />
          </FieldShell>
          <FieldShell path="@visibility.until" label="Show until" error={late ? "Must be after the start" : null}>
            <Input type="datetime-local" className="text-[13px]" value={toLocalInput(visibility.until)} onChange={(e) => set({ until: fromLocalInput(e.target.value) }, "until")} />
          </FieldShell>
        </div>
        <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <CalendarClock className="mt-px size-3.5 shrink-0" />
          {summary} Preview a date with the storefront&apos;s schedule preview, or publish to see it live.
        </p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- the page

const PageSettings = () => {
  const { contentType, locales, store } = useEditor();
  const root = useEditorState((s) => s.doc.root);
  const locale = useEditorState((s) => s.locale);
  const title = useEditorState((s) => s.doc.title);
  const issues = useEditorState((s) => s.issues);
  const saveIssues = useEditorState((s) => s.saveIssues);
  const selectionPath = useEditorState((s) => (s.selection?.nodeId === s.doc.root.id ? s.selection.path.join(".") : ""));
  const focusRequest = useEditorState((s) => s.focusRequest);
  const container = useRef<HTMLDivElement>(null);
  const fields = useMemo(() => visibleFields(contentType, root), [contentType, root.variation]);
  const contentGroups = useMemo(() => groupsOf(fields), [fields]);
  // Templates and own sections take path and SEO from the product or category, so no SEO tab.
  const template = contentType.templateFor;
  const tabs = template
    ? [TEMPLATE_TAB, "Page", ...contentGroups]
    : contentType.sectionsFor
      ? [...contentGroups, "Page"]
      : contentType.routable
        ? ["Page", "SEO", ...contentGroups]
        : [...contentGroups, "Page", "SEO"];
  const [tab, setTab] = useState(tabs[0]!);
  const rootIssues = useMemo(() => issuesForNode([...issues, ...saveIssues], root.id), [issues, saveIssues, root.id]);
  const pageProblems = useMemo(() => pageIssues([...issues, ...saveIssues]), [issues, saveIssues]);
  const onLocale = useCallback((next: string) => store.set({ locale: next }), [store]);

  useEffect(() => {
    if (!focusRequest || !selectionPath) return;
    const key = selectionPath.split(".")[0]!;
    if (key === TEMPLATE_FOCUS) setTab(TEMPLATE_TAB);
    else if (key === "@seo") setTab("SEO");
    else if (key.startsWith("@")) setTab("Page");
    else {
      const field = fields.find((f) => f.key === key);
      if (field) setTab(field.group || DEFAULT_GROUP);
    }
  }, [focusRequest]);
  useFocusField(container, selectionPath, focusRequest, true);

  const errorCount = (t: string) => {
    if (t === "Page") return ["title", "path"].filter((k) => pageProblems.has(k)).length;
    if (t === "SEO") return [...pageProblems.keys()].filter((k) => k.startsWith("seo")).length;
    return fields.filter((f) => (f.group || DEFAULT_GROUP) === t && [...rootIssues.fields.keys()].some((k) => k === f.key || k.startsWith(`${f.key}.`))).length;
  };

  return (
    <div ref={container} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        icon={<ComponentIcon name={contentType.icon} />}
        title={docTitle({ title }, locale) || "Untitled"}
        subtitle={template ? `${TEMPLATE_KINDS[template].template} · ${contentType.name}` : `${contentType.name} · page settings`}
      />
      <Tabs value={tabs.includes(tab) ? tab : tabs[0]!} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <SectionTabsList className="shrink-0 gap-4 overflow-x-auto px-4 pt-2">
          {tabs.map((t) => (
            <SectionTabsTrigger key={t} value={t} className="flex items-center gap-1 pb-2 text-[13px]">
              {t}
              {errorCount(t) ? <span className="rounded-full bg-destructive px-1.5 text-[10px] leading-4 font-semibold text-white">{errorCount(t)}</span> : null}
            </SectionTabsTrigger>
          ))}
        </SectionTabsList>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {template ? (
            <TabsContent value={TEMPLATE_TAB} className="p-4">
              <TemplateSettings />
            </TabsContent>
          ) : null}
          <TabsContent value="Page" className="flex flex-col gap-5 p-4">
            <PageBasics problems={pageProblems} onLocale={onLocale} />
          </TabsContent>
          {template ? null : (
            <TabsContent value="SEO" className="flex flex-col gap-5 p-4">
              <SeoEditor problems={pageProblems} onLocale={onLocale} />
            </TabsContent>
          )}
          {contentGroups.map((group) => (
            <TabsContent key={group} value={group} className="flex flex-col gap-5 p-4">
              {fields
                .filter((f) => (f.group || DEFAULT_GROUP) === group)
                .map((field) => (
                  <NodeField
                    key={field.key}
                    nodeId={root.id}
                    field={field}
                    value={root.fields[field.key]}
                    locale={locale}
                    locales={locales}
                    error={rootIssues.fields.get(field.key) ?? null}
                    errors={rootIssues.fields}
                    openItem={selectionPath.startsWith(`${field.key}.`) ? (selectionPath.split(".")[1] ?? null) : null}
                  />
                ))}
              {fields.some((f) => f.type === "blocks") ? <p className="text-xs text-muted-foreground">Arrange components in the structure tree on the left, or click them in the preview.</p> : null}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
};

const PageBasics = ({ problems, onLocale }: { problems: ReadonlyMap<string, string>; onLocale: (locale: string) => void }) => {
  const { actions, contentType, locales, channels, pageId, frontend } = useEditor();
  const title = useEditorState((s) => s.doc.title);
  const path = useEditorState((s) => s.doc.path);
  const locale = useEditorState((s) => s.locale);
  const meta = useEditorState((s) => s.meta);
  const dirty = useEditorState((s) => s.doc !== s.savedDoc);
  const titleId = useId();
  const pathId = useId();
  const text = textIn(title, locale);

  const [pathDraft, setPathDraft] = useState(path ?? "");
  const lastPath = useRef(path);
  useEffect(() => {
    if (path !== lastPath.current) {
      lastPath.current = path;
      setPathDraft(path ?? "");
    }
  }, [path]);
  const draftNormalized = pathDraft ? normalizePath(pathDraft) : "";
  const localProblem = !pathDraft.trim() ? "A path is required" : pathProblem(draftNormalized);
  const setPath = (input: string) => {
    setPathDraft(input);
    const next = normalizePath(input);
    if (input.trim() && !pathProblem(next)) {
      lastPath.current = next;
      actions.setPage((doc) => (doc.path === next ? doc : { ...doc, path: next }), "path");
    }
  };

  const [channelIds, setChannelIds] = useState<string[]>(meta.allChannels ? [] : (meta.channels ?? []).map((c) => c.id));
  const [savingChannels, setSavingChannels] = useState(false);
  // Follow changes made elsewhere (another tab, a reload).
  const storedChannels = meta.allChannels ? "" : (meta.channels ?? []).map((c) => c.id).join(",");
  useEffect(() => {
    if (!savingChannels) setChannelIds(storedChannels ? storedChannels.split(",") : []);
  }, [storedChannels]);
  const saveChannels = async (next: string[]) => {
    const previous = channelIds;
    setChannelIds(next);
    setSavingChannels(true);
    try {
      const result = unwrap((await request(PageSettingsMutation, { id: pageId, channelIds: next })).pageSettingsUpdate);
      actions.setMeta({ allChannels: result.page?.allChannels ?? next.length === 0, channels: result.page?.channels ?? [] });
      toast.success(next.length ? `Served in ${next.length} channel${next.length === 1 ? "" : "s"}` : "Served in every channel", { description: "Channel changes apply right away, without publishing." });
    } catch (error) {
      setChannelIds(previous);
      toast.error(error instanceof Error ? error.message : "Could not update channels");
    } finally {
      setSavingChannels(false);
    }
  };
  const movedFrom = meta.publishedPath && path && meta.publishedPath !== path ? meta.publishedPath : null;
  const liveUrl = storefrontUrl(frontend, path);
  const template = contentType.templateFor ? TEMPLATE_KINDS[contentType.templateFor] : null;
  const sections = contentType.sectionsFor ? TEMPLATE_KINDS[contentType.sectionsFor] : null;

  return (
    <>
      <FieldShell
        path="@title"
        label="Title"
        required
        htmlFor={titleId}
        error={problems.get("title")}
        description={
          template
            ? `Names the template in the admin. The ${template.pages} it renders take their titles from the ${template.one}.`
            : sections
              ? `Names these sections in the admin. The ${sections.one}'s page keeps the ${sections.one}'s own title.`
              : "Shown in the admin, browser tabs and search results unless the SEO title says otherwise."
        }
        aside={<LocaleDots value={title} locale={locale} locales={locales} onLocale={onLocale} />}
      >
        <Input
          id={titleId}
          value={text}
          placeholder={(!text && Object.values(title).find((t) => t?.trim())) || "Page title"}
          onChange={(e) => actions.setPage((doc) => ({ ...doc, title: withText(doc.title, locale, e.target.value) }), "title")}
        />
      </FieldShell>
      {contentType.routable ? (
        <FieldShell
          path="@path"
          label="Path"
          required
          htmlFor={pathId}
          error={pathDraft !== (path ?? "") ? localProblem : (problems.get("path") ?? localProblem)}
          description={movedFrom ? `Live at ${movedFrom}. Publishing moves it here and redirects the old path.` : liveUrl ? <span className="break-all">{liveUrl}</span> : "Where the storefront serves the page."}
        >
          <div className="flex gap-1.5">
            <Input id={pathId} className="font-mono text-[13px]" value={pathDraft} onChange={(e) => setPath(e.target.value)} onBlur={() => !localProblem && setPathDraft(draftNormalized)} placeholder="/summer-sale" />
            <Tooltip content="Generate from the title">
              <Button type="button" variant="outline" size="icon" aria-label="Generate the path from the title" onClick={() => setPath(pathFromTitle(text || Object.values(title).find(Boolean) || ""))} disabled={path === "/"}>
                <WandSparkles />
              </Button>
            </Tooltip>
          </div>
        </FieldShell>
      ) : null}
      <FieldShell
        path="@channels"
        label="Channels"
        description={
          template
            ? `Where the template is used; elsewhere ${template.pages} skip it for the next template that applies. Applies immediately, not on publish.`
            : sections
              ? `Where these sections show; elsewhere the ${sections.one}'s page shows without them. Applies immediately, not on publish.`
              : "Where the page is served. Applies immediately, not on publish."
        }
      >
        <MultiSelect options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "Channel" }))} value={channelIds} onChange={(next) => void saveChannels(next)} placeholder="Every channel" disabled={savingChannels} />
      </FieldShell>
      <section className="rounded-lg border bg-muted/30 p-3 text-xs">
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1.5">
          {sections ? (
            <>
              <dt className="text-muted-foreground">Belongs to</dt>
              <dd className="min-w-0 truncate">
                <OwnerLink className="text-primary hover:underline" />
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Status</dt>
          <dd className="flex items-center gap-1.5">
            <StatusBadge status={meta.status} dirty={dirty} />
          </dd>
          <dt className="text-muted-foreground">Last saved</dt>
          <dd>
            {relativeTime(meta.draftUpdatedAt)}
            {meta.draftUpdatedBy ? ` by ${meta.draftUpdatedBy.name ?? meta.draftUpdatedBy.email}` : ""}
          </dd>
          <dt className="text-muted-foreground">Published</dt>
          <dd>{meta.publishedAt ? `${formatDateTime(meta.publishedAt)}${meta.publishedBy ? ` by ${meta.publishedBy.name ?? meta.publishedBy.email}` : ""}` : "Never"}</dd>
          {meta.scheduledAt ? (
            <>
              <dt className="text-muted-foreground">Scheduled</dt>
              <dd>{formatDateTime(meta.scheduledAt)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Version</dt>
          <dd className="tabular-nums">{meta.version}</dd>
          {meta.releases?.length ? (
            <>
              <dt className="text-muted-foreground">Releases</dt>
              <dd className="flex flex-wrap gap-1">
                {meta.releases.map((r) => (
                  <Link key={r.id} to="/releases/$id" params={{ id: r.id }} className="text-primary hover:underline">
                    {r.name}
                  </Link>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      </section>
    </>
  );
};

const SeoEditor = ({ problems, onLocale }: { problems: ReadonlyMap<string, string>; onLocale: (locale: string) => void }) => {
  const { actions, locales, frontend } = useEditor();
  const seo = useEditorState((s) => s.doc.seo);
  const title = useEditorState((s) => s.doc.title);
  const path = useEditorState((s) => s.doc.path);
  const locale = useEditorState((s) => s.locale);
  const titleId = useId();
  const descriptionId = useId();
  const setSeo = (key: keyof PageSeo, update: (seo: PageSeo) => PageSeo) => actions.setPage((doc) => ({ ...doc, seo: update(doc.seo ?? {}) }), `seo.${key}`, ["seo", key]);
  const setText = (key: "title" | "description", text: string) =>
    setSeo(key, (s) => {
      const next = withText(s[key], locale, text);
      const copy = { ...s, [key]: next };
      if (!Object.keys(next).length) delete copy[key];
      return copy;
    });
  const seoTitle = textIn(seo.title, locale);
  const seoDescription = textIn(seo.description, locale);
  const shownTitle = seoTitle || textIn(seo.title, locale, true) || textIn(title, locale, true) || "Untitled";
  const shownDescription = seoDescription || textIn(seo.description, locale, true);
  const host = frontend?.url ? frontend.url.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "your-store.example";
  const imageField = useMemo<FieldDefinition>(() => ({ key: "image", type: "image", label: "Sharing image" }), []);
  const onImage = useCallback(
    (next: unknown) =>
      setSeo("image", (s) => {
        const value = typeof next === "function" ? (next as (current: unknown) => unknown)(s.image) : next;
        const copy = { ...s, image: value as PageSeo["image"] };
        if (value === undefined) delete copy.image;
        return copy;
      }),
    [locale],
  );
  return (
    <>
      <div className="rounded-lg border bg-background p-3">
        <p className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Search className="size-3" /> Search result preview
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {host}
          {path && path !== "/" ? path.replaceAll("/", " › ").replace(/^ › /, " › ") : ""}
        </p>
        <p className="truncate text-[15px] text-[#1a0dab] dark:text-[#8ab4f8]">{shownTitle}</p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{shownDescription || "Add a description to control what search engines show."}</p>
      </div>
      <FieldShell path="@seo.title" label="SEO title" htmlFor={titleId} error={problems.get("seo.title")} description="Defaults to the page title. About 60 characters." aside={<LocaleDots value={seo.title} locale={locale} locales={locales} onLocale={onLocale} />}>
        <div className="relative">
          <Input id={titleId} value={seoTitle} placeholder={textIn(title, locale, true) || "Page title"} onChange={(e) => setText("title", e.target.value)} className="pr-14" />
          <span className={cn("pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground", seoTitle.length > 60 && "text-warning")}>{seoTitle.length}/60</span>
        </div>
      </FieldShell>
      <FieldShell path="@seo.description" label="Meta description" htmlFor={descriptionId} error={problems.get("seo.description")} description="One or two sentences, about 155 characters." aside={<LocaleDots value={seo.description} locale={locale} locales={locales} onLocale={onLocale} />}>
        <div className="relative">
          <Textarea id={descriptionId} rows={3} value={seoDescription} placeholder={textIn(seo.description, locale, true)} onChange={(e) => setText("description", e.target.value)} className="pb-5" />
          <span className={cn("pointer-events-none absolute right-2 bottom-1.5 text-[10px] tabular-nums text-muted-foreground", seoDescription.length > 160 && "text-warning")}>{seoDescription.length}/160</span>
        </div>
      </FieldShell>
      <FieldShell path="@seo.image" label="Sharing image" error={problems.get("seo.image")} description="Shown when the page is shared on social media. 1200×630 works best.">
        <ImageEditor field={imageField} value={seo.image ?? undefined} onChange={onImage} locale={locale} locales={locales} invalid={!!problems.get("seo.image")} />
      </FieldShell>
      <FieldShell path="@seo.noIndex" label="Hide from search engines" inline description="Adds noindex, so search engines leave the page out of results.">
        <Switch checked={!!seo.noIndex} onCheckedChange={(checked) => setSeo("noIndex", (s) => ({ ...s, noIndex: checked || undefined }))} />
      </FieldShell>
      <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Globe className="mt-px size-3.5 shrink-0" />
        SEO text is per language: switch the language at the top to edit {locales.filter((l) => l !== locale).slice(0, 2).map(languageName).join(" or ") || "others"}.
      </p>
    </>
  );
};

