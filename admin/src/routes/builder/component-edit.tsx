import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Blocks, Copy, Database, Download, GripVertical, Image as ImageIcon, LayoutTemplate, Plus, Rows3, Save, Trash2, Type, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { UploadButton } from "@/components/inputs";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/menu";
import { ConfirmDialog, Tooltip } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { copyText, useListSearch } from "@/lib/hooks";
import { cn, downloadText } from "@/lib/utils";
import { TEMPLATE_KINDS, type ComponentKind, type FieldDefinition, type FieldType, type TemplateFor, type Variation } from "./model";
import {
  CODE_HINT,
  definitionPath,
  describePath,
  emptyDraft,
  fieldsOf,
  issueAt,
  issuesUnder,
  keepUid,
  move,
  newField,
  pathKey,
  toCode,
  toComponentInput,
  toDefinitionJson,
  toDraft,
  uidOf,
  uniqueName,
  validateDefinition,
  type DraftDefinition,
  type Issue,
} from "./library/definition";
import { AddFieldButton, FieldList, FieldPanel, type FieldSelection, type LibraryOption } from "./library/field-editor";
import { CodeManagedAlert } from "./library/import-export";
import { ComponentsQuery, LIBRARY_KEY, globalId, invalidateMatching, type LibraryComponent } from "./library/queries";
import { IconPicker, IconTile, isKnownIcon } from "./library/icons";
import { InlineCode, KindBadge, SectionsForBadge, SourceBadge, TemplateForBadge, useDragReorder } from "./library/ui";

const ComponentFields = graphql(`
  fragment LibraryComponentFields on Component {
    id
    code
    kind
    name
    description
    groupName
    icon
    previewImageUrl
    fields
    variations
    routable
    singleton
    templateFor
    sectionsFor
    source
    revision
    usageCount
    createdAt
    updatedAt
  }
`);

const ComponentQuery = graphql(
  `
    query LibraryComponent($id: ID!) {
      component(id: $id) {
        ...LibraryComponentFields
      }
    }
  `,
  [ComponentFields],
);

const ComponentCreate = graphql(
  `
    mutation LibraryComponentCreate($input: ComponentInput!) {
      componentCreate(input: $input) {
        __typename
        ... on ComponentPayload {
          component {
            ...LibraryComponentFields
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ComponentFields, ErrorFields],
);

const ComponentUpdate = graphql(
  `
    mutation LibraryComponentUpdate($id: ID!, $input: ComponentInput!) {
      componentUpdate(id: $id, input: $input) {
        __typename
        ... on ComponentPayload {
          component {
            ...LibraryComponentFields
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ComponentFields, ErrorFields],
);

const ComponentDelete = graphql(
  `
    mutation LibraryComponentDelete($id: ID!) {
      componentDelete(id: $id) {
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

type Component = NonNullable<ResultOf<typeof ComponentQuery>["component"]>;

const KIND_LABEL: Record<ComponentKind, string> = { COMPONENT: "component", CONTENT_TYPE: "content type" };

/** /components/new?kind=… and /components/$id: a component's fields, variations and settings. */
export const ComponentEditPage = () => {
  const { id } = useParams({ strict: false }) as { id?: string };
  const [search] = useListSearch();
  const componentId = id ? globalId("Component", id) : null;
  const query = useQuery({ queryKey: ["builder-component", componentId], queryFn: ({ signal }) => request(ComponentQuery, { id: componentId! }, { signal }), enabled: !!componentId });
  const library = useQuery({ queryKey: [...LIBRARY_KEY], queryFn: ({ signal }) => request(ComponentsQuery, undefined, { signal }) });

  if (componentId && query.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-72" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Skeleton className="h-[36rem]" />
          <Skeleton className="h-96" />
        </div>
      </Page>
    );
  }
  const component = query.data?.component ?? null;
  if (componentId && !component) {
    return (
      <Page>
        <EmptyState
          title="Component not found"
          description={query.error instanceof Error ? query.error.message : "It may have been deleted, or removed by a deploy from code."}
          action={
            <Button asChild variant="outline">
              <Link to="/components">Back to components</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  const kind: ComponentKind = component?.kind ?? (search.kind === "CONTENT_TYPE" ? "CONTENT_TYPE" : "COMPONENT");
  return <ComponentEditor key={component?.id ?? `new-${kind}`} component={component} initialKind={kind} library={library.data?.components ?? []} />;
};

/** Loaded fields and item fields by uid, to warn before changing keys or types pages rely on. */
const originalsOf = (fields: readonly FieldDefinition[]) => {
  const map = new Map<string, FieldDefinition>();
  for (const field of fields) {
    map.set(uidOf(field), field);
    for (const item of field.fields ?? []) map.set(uidOf(item), item);
  }
  return map;
};

const ComponentEditor = ({ component, initialKind, library }: { component: Component | null; initialKind: ComponentKind; library: readonly LibraryComponent[] }) => {
  const { can } = useAuth();
  const write = can("content:write");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const creating = !component;

  const [initial] = useState(() => (component ? toDraft(component) : emptyDraft(initialKind)));
  const [draft, setDraft] = useState<DraftDefinition>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(toDefinitionJson(initial)));
  const [original, setOriginal] = useState(() => originalsOf(component ? initial.fields : []));
  const [selection, setSelection] = useState<FieldSelection | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [codeTouched, setCodeTouched] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; snapshot: string; issues: Issue[]; problems: { where: string; message: string }[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const autoKeys = useRef(new Set<string>()).current;

  const json = useMemo(() => toDefinitionJson(draft), [draft]);
  const snapshot = JSON.stringify(json);
  const dirty = snapshot !== baseline;
  const libraryRefs = useMemo(() => library.map((c) => ({ code: c.code ?? "", kind: c.kind ?? "COMPONENT" })), [library]);
  const issues = useMemo(() => validateDefinition(draft, { library: libraryRefs, creating }), [draft, libraryRefs, creating]);
  // Problems the API reported apply to the definition as sent; they go once it changes.
  const serverIssues = saveError && saveError.snapshot === snapshot ? saveError.issues : [];
  const shown = useMemo(
    () => [...issues.filter((i) => attempted || !i.missing), ...serverIssues.filter((s) => !issues.some((i) => pathKey(i.path) === pathKey(s.path)))],
    [issues, serverIssues, attempted],
  );
  const error = (...path: (string | number)[]) => issueAt(shown, path);
  const options: LibraryOption[] = useMemo(() => library.map((c) => ({ code: c.code ?? "", name: c.name ?? c.code ?? "", kind: c.kind ?? "COMPONENT", icon: c.icon, templateFor: c.templateFor })), [library]);
  const groups = useMemo(() => [...new Set(library.map((c) => c.groupName?.trim()).filter((g): g is string => !!g))].sort(), [library]);

  const set = <K extends keyof DraftDefinition>(key: K, value: DraftDefinition[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // Templates and sections have no path and are no singletons, whatever the switches say.
  const pathless = draft.kind === "CONTENT_TYPE" && !!(draft.templateFor || draft.sectionsFor);
  const setFields = (update: (fields: FieldDefinition[]) => FieldDefinition[]) => setDraft((d) => ({ ...d, fields: update(d.fields) }));

  const { dialog: leaveDialog, release } = useUnsavedChanges(dirty, { description: "Your changes to this component will be lost." });

  const title = draft.name.trim() || component?.name || `New ${KIND_LABEL[draft.kind]}`;
  useEffect(() => {
    document.title = `${title} · SpindleCommerce`;
  }, [title]);

  const save = useMutation({
    mutationFn: async (sent: { draft: DraftDefinition; snapshot: string }) => {
      const input = toComponentInput(sent.draft, creating);
      if (component) return unwrap((await request(ComponentUpdate, { id: component.id, input })).componentUpdate).component;
      return unwrap((await request(ComponentCreate, { input })).componentCreate).component;
    },
    onSuccess: async (saved, sent) => {
      setSaveError(null);
      setAttempted(false);
      toast.success(creating ? `Created ${saved?.name ?? "the component"}` : "Component saved", { description: component?.source === "CODE" ? "It is now marked as edited in the admin." : undefined });
      await invalidateMatching(queryClient, /component|library/i);
      if (!saved) return;
      queryClient.setQueryData(["builder-component", saved.id], { component: saved });
      if (creating) {
        release();
        void navigate({ to: "/components/$id", params: { id: saved.id }, replace: true });
      } else {
        setBaseline(sent.snapshot);
        setOriginal(originalsOf(sent.draft.fields));
      }
    },
    onError: (failure, sent) => {
      if (failure instanceof MutationError && failure.fieldErrors.length) {
        const mapped = failure.fieldErrors.map((f) => ({ path: definitionPath(f.path), message: f.message }));
        setSaveError({ message: failure.message, snapshot: sent.snapshot, issues: mapped, problems: mapped.map((i) => ({ where: describePath(sent.draft, i.path) || "Definition", message: i.message })) });
        toast.error(failure.message, { description: mapped.length === 1 ? mapped[0]!.message : `${mapped.length} problems; see the top of the page.` });
        return;
      }
      reportError(failure);
    },
  });

  const submit = () => {
    if (!write || save.isPending) return;
    setAttempted(true);
    if (issues.length) {
      toast.error(`Fix ${issues.length} problem${issues.length === 1 ? "" : "s"} before saving`, {
        description: (
          <ul className="mt-0.5 space-y-0.5">
            {issues.slice(0, 4).map((i) => (
              <li key={pathKey(i.path)}>
                {describePath(draft, i.path)}: {i.message}
              </li>
            ))}
            {issues.length > 4 ? <li>and {issues.length - 4} more</li> : null}
          </ul>
        ),
      });
      // Go to the first problem: open its field, or focus the input it is about.
      const [head, index, sub, item] = issues[0]!.path;
      if (head === "fields" && index !== undefined && /^\d+$/.test(index)) setSelection({ index: Number(index), ...(sub === "fields" && item !== undefined && /^\d+$/.test(item) ? { item: Number(item) } : {}) });
      else if (head === "variations") document.getElementById("definition-variations")?.scrollIntoView({ behavior: "smooth", block: "start" });
      else {
        const input = document.getElementById(`definition-${head}`);
        input?.scrollIntoView({ behavior: "smooth", block: "center" });
        input?.focus({ preventScroll: true });
      }
      return;
    }
    save.mutate({ draft, snapshot });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const remove = useMutation({
    mutationFn: async () => unwrap((await request(ComponentDelete, { id: component!.id })).componentDelete),
    onSuccess: async () => {
      toast.success(`Deleted ${component?.name ?? "the component"}`);
      setConfirmDelete(false);
      release();
      // Leave first, so this screen never renders "not found" for what it deleted.
      await navigate({ to: "/components" });
      queryClient.removeQueries({ queryKey: ["builder-component", component?.id] });
      await invalidateMatching(queryClient, /component|library/i);
    },
    onError: (failure) => setDeleteError(failure instanceof Error ? failure.message : "Could not delete the component"),
  });
  const allowedIn = component ? library.filter((c) => c.id !== component.id && fieldsOf(c.fields).some((f) => f.allowedComponents?.includes(component.code ?? ""))) : [];

  const addField = (type: FieldType, preset?: Partial<FieldDefinition>) => {
    const field = { ...newField(type), ...preset };
    if (!preset?.key) autoKeys.add(uidOf(field));
    const index = draft.fields.length;
    setFields((fields) => [...fields, preset?.key ? { ...field, key: uniqueName(preset.key, fields.map((f) => f.key)) } : field]);
    if (!preset) setSelection({ index });
  };

  const fieldIssueCount = issuesUnder(shown, ["fields"]).length;

  return (
    <Page>
      <PageHeader
        back={{ to: "/components", label: "Components" }}
        title={
          <span className="flex items-center gap-3">
            <IconTile name={draft.icon} kind={draft.kind} />
            <span className="truncate">{title}</span>
          </span>
        }
        badges={
          <>
            <KindBadge kind={draft.kind} />
            <TemplateForBadge templateFor={draft.templateFor} kind={draft.kind} />
            <SectionsForBadge sectionsFor={draft.kind === "CONTENT_TYPE" ? draft.sectionsFor : null} />
            {component ? <SourceBadge source={component.source} /> : null}
            {dirty && !creating ? (
              <Badge variant="warning" dot>
                Unsaved changes
              </Badge>
            ) : null}
          </>
        }
        description={
          component ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <InlineCode>{component.code}</InlineCode>
              <span>
                Revision {component.revision} · updated {relativeTime(component.updatedAt)}
              </span>
            </span>
          ) : draft.kind === "CONTENT_TYPE" ? (
            "The root of a page: its fields hold page-level content, and a blocks field holds the sections editors add."
          ) : (
            "A reusable section or element editors place inside blocks fields. Storefronts render it by its code."
          )
        }
        actions={
          write ? (
            <>
              {component ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 />
                  Delete
                </Button>
              ) : null}
              <Tooltip content={<span>Save · ⌘S</span>}>
                <Button type="button" onClick={submit} loading={save.isPending} disabled={!creating && !dirty}>
                  {save.isPending ? null : <Save />}
                  {creating ? `Create ${KIND_LABEL[draft.kind]}` : "Save"}
                </Button>
              </Tooltip>
            </>
          ) : null
        }
      />

      <div className="mb-6 flex flex-col gap-3 empty:hidden">
        {component?.source === "CODE" ? <CodeManagedAlert /> : null}
        {!write ? <Alert variant="info" title="Read only">You can view this definition; changing it needs the content:write permission.</Alert> : null}
        {saveError ? (
          <Alert
            variant="destructive"
            title={`Not saved: ${saveError.message}`}
            action={
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSaveError(null)} aria-label="Dismiss">
                <X />
              </Button>
            }
          >
            <ul className="mt-1 space-y-0.5">
              {saveError.problems.map((p, i) => (
                <li key={i}>
                  <span className="font-medium">{p.where}</span>: {p.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>

      <TwoColumn
        main={
          <>
            <fieldset disabled={!write} className="contents">
              <Card id="definition-general" className="scroll-mt-20">
                <CardHeader>
                  <div>
                    <CardTitle>General</CardTitle>
                    <CardDescription>How editors find it in the component picker.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {creating ? <KindPicker value={draft.kind} onChange={(kind) => setDraft((d) => ({ ...d, kind, routable: kind === "CONTENT_TYPE", singleton: false, templateFor: null, sectionsFor: null }))} /> : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Name" required error={error("name")} htmlFor="definition-name">
                      <Input
                        id="definition-name"
                        autoFocus={creating}
                        value={draft.name}
                        maxLength={120}
                        placeholder={draft.kind === "CONTENT_TYPE" ? "e.g. Landing page" : "e.g. Hero"}
                        onChange={(e) => {
                          const name = e.target.value;
                          setDraft((d) => ({ ...d, name, ...(creating && !codeTouched ? { code: toCode(name) } : {}) }));
                        }}
                      />
                    </Field>
                    {creating ? (
                      <Field label="Code" required error={error("code")} htmlFor="definition-code" hint={`Pages and frontends refer to it by code; fixed once created. ${CODE_HINT}.`}>
                        <Input
                          id="definition-code"
                          className="font-mono"
                          value={draft.code}
                          maxLength={48}
                          placeholder={draft.kind === "CONTENT_TYPE" ? "landing_page" : "hero"}
                          onChange={(e) => {
                            setCodeTouched(true);
                            set("code", e.target.value.toLowerCase().replace(/\s+/g, "_"));
                          }}
                        />
                      </Field>
                    ) : (
                      <Field label="Code" hint="Fixed: pages and frontends refer to the component by its code.">
                        <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3">
                          <span className="flex-1 truncate font-mono text-sm">{component?.code}</span>
                          <Button type="button" variant="ghost" size="icon-sm" className="-mr-2 size-7" onClick={() => void copyText(component?.code ?? "", "Code copied")} aria-label="Copy code">
                            <Copy />
                          </Button>
                        </div>
                      </Field>
                    )}
                  </div>
                  <Field label="Description" error={error("description")} hint="Shown in the picker; say when to use it.">
                    <Textarea rows={2} maxLength={1000} value={draft.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. A large headline with an image and buttons." />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Group" error={error("groupName")} hint="Picker section, e.g. Sections, Commerce, Marketing.">
                      <Input list="component-groups" maxLength={60} value={draft.groupName} onChange={(e) => set("groupName", e.target.value)} placeholder="Ungrouped" />
                    </Field>
                    <datalist id="component-groups">
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                    <Field label="Icon" error={error("icon")} hint={draft.icon && !isKnownIcon(draft.icon) ? `“${draft.icon}” is not in the admin's icon set; a generic icon is shown here.` : "A Lucide icon for the picker and outline."}>
                      <IconPicker value={draft.icon} onChange={(icon) => set("icon", icon)} invalid={!!error("icon")} />
                    </Field>
                  </div>
                </CardContent>
              </Card>
            </fieldset>

            <Card id="definition-fields" className="scroll-mt-20">
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    Fields
                    <Badge variant="secondary">{draft.fields.length}</Badge>
                    {fieldIssueCount ? <Badge variant="destructive">{fieldIssueCount} to fix</Badge> : null}
                  </CardTitle>
                  <CardDescription>What editors fill in, in inspector order. Drag to reorder; click a field to edit it.</CardDescription>
                </div>
                {write && draft.fields.length ? <AddFieldButton onAdd={(type) => addField(type)} /> : null}
              </CardHeader>
              <CardContent>
                {error("fields") ? <p className="mb-2 text-xs text-destructive">{error("fields")}</p> : null}
                {draft.fields.length ? (
                  <FieldList fields={draft.fields} onChange={setFields} onEdit={(index) => setSelection({ index })} issues={shown} prefix={["fields"]} library={options} disabled={!write} />
                ) : (
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
                    <p className="font-medium">No fields yet</p>
                    <p className="max-w-md text-[13px] text-muted-foreground">
                      {draft.kind === "CONTENT_TYPE"
                        ? "Most content types have a blocks field that holds the page's sections, plus any page-level settings."
                        : "Add the text, images and links editors fill in, or a blocks field to nest other components."}
                    </p>
                    {write ? (
                      <div className="flex flex-wrap justify-center gap-2">
                        {draft.kind === "CONTENT_TYPE" ? (
                          <Button type="button" variant="outline" size="sm" onClick={() => addField("blocks", { key: "sections", label: "Sections" })}>
                            <Blocks />
                            Sections slot
                          </Button>
                        ) : (
                          <>
                            <Button type="button" variant="outline" size="sm" onClick={() => addField("text", { key: "title", label: "Title", required: true })}>
                              <Type />
                              Title
                            </Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => addField("image", { key: "image", label: "Image" })}>
                              <ImageIcon />
                              Image
                            </Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => addField("list", { key: "items", label: "Items", fields: [{ key: "title", type: "text", label: "Title", localized: true }] })}>
                              <Rows3 />
                              List of items
                            </Button>
                          </>
                        )}
                        <AddFieldButton onAdd={(type) => addField(type)} variant="default" label="Add field" />
                      </div>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>

            <fieldset disabled={!write} className="contents">
              <VariationsCard draft={draft} setDraft={setDraft} issues={shown} write={write} />
            </fieldset>
          </>
        }
        side={
          <>
            <fieldset disabled={!write} className="contents">
              {draft.kind === "CONTENT_TYPE" ? (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <LayoutTemplate className="size-4 text-muted-foreground" />
                        Content type
                      </CardTitle>
                      <CardDescription>How pages of this type behave.</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col divide-y">
                    <PagesAreField
                      value={draft}
                      onChange={(role) => setDraft((d) => ({ ...d, ...role }))}
                      usage={component?.usageCount ?? 0}
                      error={error("templateFor") ?? error("sectionsFor")}
                    />
                    <SettingSwitch
                      label="Has a path"
                      hint={
                        draft.templateFor
                          ? "Off for templates: they have no path, product or category pages render with them."
                          : draft.sectionsFor
                            ? `Off for sections: they show on the ${TEMPLATE_KINDS[draft.sectionsFor].one}'s own page.`
                            : "Pages are served at a path such as /summer-sale. Turn off for content without its own URL, like a header."
                      }
                      checked={draft.routable && !pathless}
                      disabled={pathless}
                      onChange={(v) => set("routable", v)}
                    />
                    <SettingSwitch
                      label="Singleton"
                      hint={
                        draft.templateFor
                          ? "Off for templates: there can be several, each assigned to products or categories, and one default."
                          : draft.sectionsFor
                            ? `Off for sections: each ${TEMPLATE_KINDS[draft.sectionsFor].one} can have its own.`
                            : "Only one page of this type can exist, e.g. the site header or footer."
                      }
                      checked={draft.singleton && !pathless}
                      disabled={pathless}
                      onChange={(v) => set("singleton", v)}
                    />
                    {component && (component.usageCount ?? 0) > 0 && !pathless && (draft.routable !== initial.routable || draft.singleton !== initial.singleton) ? (
                      <p className="pt-3 text-xs text-warning">
                        {component.usageCount} page{component.usageCount === 1 ? "" : "s"} of this type exist; {draft.routable !== initial.routable ? (draft.routable ? "they will need a path to publish." : "their paths will be refused when they are saved.") : "check they still fit."}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Database className="size-4 text-muted-foreground" />
                        Data
                      </CardTitle>
                      <CardDescription>Whether it shows a product&apos;s or category&apos;s own data.</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <TemplateForField value={draft.templateFor} onChange={(templateFor) => set("templateFor", templateFor)} usage={component?.usageCount ?? 0} error={error("templateFor")} />
                  </CardContent>
                </Card>
              )}

              <PreviewImageCard url={draft.previewImageUrl} onChange={(url) => set("previewImageUrl", url)} error={error("previewImageUrl")} write={write} />
            </fieldset>

            {component ? (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Usage</CardTitle>
                    <CardDescription>Pages whose draft or published version uses it.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold tabular">
                    {component.usageCount ?? 0}
                    <span className="ml-1.5 text-sm font-normal text-muted-foreground">page{component.usageCount === 1 ? "" : "s"}</span>
                  </p>
                  {allowedIn.length ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Allowed in{" "}
                      {allowedIn.map((c, i) => (
                        <span key={c.id}>
                          {i ? ", " : ""}
                          <Link to="/components/$id" params={{ id: c.id }} className="text-foreground hover:underline">
                            {c.name}
                          </Link>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  <dl className="mt-3 border-t pt-2">
                    <Detail label="Source">
                      <SourceBadge source={component.source} />
                    </Detail>
                    <Detail label="Revision">{component.revision}</Detail>
                    <Detail label="Created">{formatDateTime(component.createdAt)}</Detail>
                    <Detail label="Updated">{formatDateTime(component.updatedAt)}</Detail>
                  </dl>
                </CardContent>
              </Card>
            ) : null}

            <DefinitionCard json={json} />
          </>
        }
      />

      <FieldPanel
        fields={draft.fields}
        setFields={setFields}
        selection={selection}
        onSelect={setSelection}
        issues={shown}
        variations={draft.variations}
        library={options}
        original={original}
        autoKeys={autoKeys}
        disabled={!write}
        ownCode={draft.kind === "COMPONENT" && draft.code ? { code: draft.code, name: draft.name } : null}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          setConfirmDelete(open);
          if (!open) setDeleteError(null);
        }}
        title={`Delete ${component?.name ?? "this component"}?`}
        description="Pages and frontends refer to it by code. It can only be deleted when no page uses it and no other component allows it."
        destructive
        confirmLabel="Delete component"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        {deleteError ? (
          <Alert variant="destructive" title="Not deleted">
            {deleteError}
          </Alert>
        ) : (component?.usageCount ?? 0) > 0 || allowedIn.length ? (
          <Alert variant="warning" title="This will probably be refused">
            {(component?.usageCount ?? 0) > 0 ? `It is used on ${component?.usageCount} page${component?.usageCount === 1 ? "" : "s"}. ` : ""}
            {allowedIn.length ? `It is allowed in ${allowedIn.map((c) => c.name).join(", ")}.` : ""}
          </Alert>
        ) : component?.source === "CODE" ? (
          <Alert variant="info">It is managed in code: the next push from code creates it again unless it is removed there too.</Alert>
        ) : null}
      </ConfirmDialog>
      {leaveDialog}
    </Page>
  );
};

// ---------------------------------------------------------------- pieces

const KindPicker = ({ value, onChange }: { value: ComponentKind; onChange: (kind: ComponentKind) => void }) => (
  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Kind">
    {(
      [
        { kind: "COMPONENT", title: "Component", text: "A section or element placed inside blocks fields: hero, product grid, button.", icon: Blocks },
        { kind: "CONTENT_TYPE", title: "Content type", text: "The root of a page: landing page, article, site header.", icon: LayoutTemplate },
      ] as const
    ).map((option) => (
      <button
        key={option.kind}
        type="button"
        role="radio"
        aria-checked={value === option.kind}
        onClick={() => onChange(option.kind)}
        className={cn("flex items-start gap-3 rounded-lg border p-3 text-left transition-colors", value === option.kind ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-accent/50")}
      >
        <option.icon className={cn("mt-0.5 size-4 shrink-0", value === option.kind ? "text-primary" : "text-muted-foreground")} />
        <span>
          <span className="block text-sm font-medium">{option.title}</span>
          <span className="text-xs text-muted-foreground">{option.text}</span>
        </span>
      </button>
    ))}
  </div>
);

const SettingSwitch = ({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) => (
  <Label className={cn("items-start justify-between gap-4 py-3 font-normal first:pt-0 last:pb-0", disabled && "cursor-not-allowed")}>
    <span>
      <span className={cn("block text-sm", disabled && "text-muted-foreground")}>{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </span>
    <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
  </Label>
);

const DATA_OPTIONS: { value: TemplateFor | "NONE"; label: string; description: string }[] = [
  { value: "NONE", label: "None", description: "Fits every page" },
  { value: "PRODUCT", label: "Product", description: "The product being viewed; only in product templates and sections" },
  { value: "CATEGORY", label: "Category", description: "The category being viewed; only in category templates and sections" },
];

/** The API refuses changes while any page uses the component, as pages are checked against it. */
const TemplateForField = ({ value, onChange, usage, error }: { value: TemplateFor | null; onChange: (value: TemplateFor | null) => void; usage: number; error?: string }) => {
  const label = "Shows data from";
  const names = value ? TEMPLATE_KINDS[value] : null;
  const hint =
    usage > 0
      ? `Fixed while ${usage === 1 ? "a page uses" : `${usage} pages use`} it: pages are checked against it. Remove it from them to change this.`
      : names
        ? `It shows the ${names.one} being viewed, so editors can only add it to ${names.template.toLowerCase()}s and ${names.sections.toLowerCase()}.`
        : "Components that show a product's or category's data only fit templates and sections of that kind.";
  return (
    <Field label={label} error={error} hint={hint} htmlFor="definition-templateFor">
      <Select id="definition-templateFor" aria-label={label} value={value ?? "NONE"} onValueChange={(next) => onChange(next === "PRODUCT" || next === "CATEGORY" ? next : null)} options={DATA_OPTIONS} disabled={usage > 0} />
    </Field>
  );
};

type Role = Pick<DraftDefinition, "templateFor" | "sectionsFor">;
const ROLES: { value: string; role: Role; label: string; description: string }[] = [
  { value: "PAGES", role: { templateFor: null, sectionsFor: null }, label: "Pages of their own", description: "Landing pages, campaigns, the header and footer" },
  { value: "PRODUCT_TEMPLATE", role: { templateFor: "PRODUCT", sectionsFor: null }, label: "Product templates", description: "Product pages render with them" },
  { value: "CATEGORY_TEMPLATE", role: { templateFor: "CATEGORY", sectionsFor: null }, label: "Category templates", description: "Category pages render with them" },
  { value: "PRODUCT_SECTIONS", role: { templateFor: null, sectionsFor: "PRODUCT" }, label: "A product's own sections", description: "Components for one product's page, where its template places them" },
  { value: "CATEGORY_SECTIONS", role: { templateFor: null, sectionsFor: "CATEGORY" }, label: "A category's own sections", description: "Components for one category's page, where its template places them" },
];
const roleValue = (role: Role) => ROLES.find((r) => r.role.templateFor === role.templateFor && r.role.sectionsFor === role.sectionsFor)?.value ?? "PAGES";

/** The API refuses changes while any page of the type exists, as pages are checked against it. */
const PagesAreField = ({ value, onChange, usage, error }: { value: Role; onChange: (role: Role) => void; usage: number; error?: string }) => {
  const label = "Its pages are";
  const template = value.templateFor ? TEMPLATE_KINDS[value.templateFor] : null;
  const sections = value.sectionsFor ? TEMPLATE_KINDS[value.sectionsFor] : null;
  const hint =
    usage > 0
      ? `Fixed while ${usage === 1 ? "a page" : `${usage} pages`} of this type ${usage === 1 ? "exists" : "exist"}: pages are checked against it.`
      : template
        ? `A template has no path: ${template.pages} render with it. Create one in Pages, then assign it to ${template.many} or make it the default.`
        : sections
          ? `Each page holds one ${sections.one}'s own components, added from the ${sections.one}'s screen. They show where its template places a component that shows ${sections.one} sections.`
          : "Pages served at a path, or shown on every page like a header. Make them templates, or a product's or category's own sections, instead.";
  return (
    <Field label={label} error={error} hint={hint} htmlFor="definition-role" className="pb-3">
      <Select
        id="definition-role"
        aria-label={label}
        value={roleValue(value)}
        onValueChange={(next) => onChange(ROLES.find((r) => r.value === next)?.role ?? ROLES[0]!.role)}
        options={ROLES.map(({ value, label, description }) => ({ value, label, description }))}
        disabled={usage > 0}
      />
    </Field>
  );
};

const PreviewImageCard = ({ url, onChange, error, write }: { url: string; onChange: (url: string) => void; error?: string; write: boolean }) => {
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Preview image</CardTitle>
          <CardDescription>A thumbnail for the component picker.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {url && broken !== url ? (
          <div className="group relative overflow-hidden rounded-lg border bg-muted">
            <img src={url} alt="" className="aspect-video w-full object-cover" onError={() => setBroken(url)} />
            {write ? (
              <Button type="button" variant="secondary" size="icon-sm" className="absolute top-2 right-2 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onChange("")} aria-label="Remove preview image">
                <X />
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-muted-foreground">
            <ImageIcon className="size-5" />
            <span className="text-xs">{url ? "The image could not be loaded" : "No preview image"}</span>
          </div>
        )}
        {write ? (
          <div className="flex items-center gap-2">
            <UploadButton kind="IMAGE" label={url ? "Replace" : "Upload image"} onUploaded={(uploaded) => onChange(uploaded)} />
            {url ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
        <Field label="Image URL" error={error}>
          <Input value={url} maxLength={2000} onChange={(e) => onChange(e.target.value)} placeholder="https://… or /media/…" className="font-mono text-xs" />
        </Field>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------- variations

const VariationsCard = ({ draft, setDraft, issues, write }: { draft: DraftDefinition; setDraft: (update: (d: DraftDefinition) => DraftDefinition) => void; issues: readonly Issue[]; write: boolean }) => {
  const variations = draft.variations;
  const [autoCodes] = useState(() => new Set<string>());
  const focusedCode = useRef<string | null>(null);
  const drag = useDragReorder((from, to) => setDraft((d) => ({ ...d, variations: move(d.variations, from, to) })));
  const error = (index: number, key: string) => issueAt(issues, ["variations", index, key]);
  const referenced = (code: string, fields: readonly FieldDefinition[]): boolean => fields.some((f) => f.variations?.includes(code) || referenced(code, f.fields ?? []));

  /** Point fields at a renamed variation (or drop a removed one: `to` null). */
  const repoint = (fields: FieldDefinition[], from: string, to: string | null): FieldDefinition[] =>
    fields.map((f) => {
      const items = f.fields ? repoint(f.fields, from, to) : undefined;
      if (!f.variations?.includes(from) && items === undefined) return f;
      const next: FieldDefinition = { ...f, ...(items ? { fields: items } : {}) };
      if (f.variations?.includes(from)) {
        const list = to ? f.variations.map((v) => (v === from ? to : v)) : f.variations.filter((v) => v !== from);
        if (list.length) next.variations = [...new Set(list)];
        else delete next.variations;
      }
      return keepUid(f, next);
    });

  const update = (index: number, patch: Partial<Variation>) =>
    setDraft((d) => ({ ...d, variations: d.variations.map((v, i) => (i === index ? keepUid(v, { ...v, ...patch }) : v)) }));

  const add = () => {
    const variation: Variation = { code: "", name: "" };
    autoCodes.add(uidOf(variation));
    setDraft((d) => ({ ...d, variations: [...d.variations, variation] }));
  };

  const remove = (index: number) =>
    setDraft((d) => {
      const removed = d.variations[index];
      if (!removed) return d;
      const others = d.variations.filter((_, i) => i !== index);
      return { ...d, variations: others, fields: removed.code && !others.some((v) => v.code === removed.code) ? repoint(d.fields, removed.code, null) : d.fields };
    });

  return (
    <Card id="definition-variations" className="scroll-mt-20">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            Variations
            <Badge variant="secondary">{variations.length}</Badge>
          </CardTitle>
          <CardDescription>Alternative layouts of the same content, e.g. Split and Centered. Editors pick one per instance; fields can be limited to some variations.</CardDescription>
        </div>
        {write && variations.length ? (
          <Button type="button" variant="outline" size="sm" onClick={add}>
            <Plus />
            Add variation
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {variations.length ? (
          <ul className="flex flex-col gap-2">
            {variations.map((variation, index) => {
              const uid = uidOf(variation);
              const line = drag.dropLine(index);
              const hasErrors = !!(error(index, "code") || error(index, "name") || error(index, "description"));
              return (
                <li
                  key={uid}
                  {...(write ? drag.rowProps(index) : {})}
                  className={cn("relative grid gap-2 rounded-lg border p-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,1fr)_auto]", hasErrors && "border-destructive/50", drag.dragging === index && "opacity-40")}
                >
                  {line ? <span className={cn("pointer-events-none absolute inset-x-3 h-0.5 rounded-full bg-primary", line === "before" ? "-top-1.5" : "-bottom-1.5")} /> : null}
                  <span {...(write ? drag.handleProps(index) : {})} className={cn("hidden h-9 items-center justify-center text-muted-foreground/60 sm:flex", write && "cursor-grab hover:text-foreground active:cursor-grabbing")} aria-hidden>
                    <GripVertical className="size-4" />
                  </span>
                  <Field label={index === 0 ? <span className="flex items-center gap-1.5">Name <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Default</Badge></span> : "Name"} error={error(index, "name")}>
                    <Input
                      autoFocus={!variation.name && !variation.code}
                      value={variation.name}
                      maxLength={120}
                      placeholder="e.g. Split"
                      onChange={(e) => {
                        const name = e.target.value;
                        setDraft((d) => {
                          const current = d.variations[index];
                          if (!current) return d;
                          const follow = autoCodes.has(uid) && !(current.code && referenced(current.code, d.fields));
                          if (!follow) autoCodes.delete(uid);
                          const code = follow ? uniqueName(toCode(name), d.variations.filter((_, i) => i !== index).map((v) => v.code)) : current.code;
                          return { ...d, variations: d.variations.map((v, i) => (i === index ? keepUid(v, { ...v, name, code }) : v)) };
                        });
                      }}
                    />
                  </Field>
                  <Field label="Code" error={error(index, "code")}>
                    <Input
                      className="font-mono"
                      value={variation.code}
                      maxLength={48}
                      placeholder="split"
                      onFocus={() => (focusedCode.current = variation.code)}
                      onBlur={() => {
                        const from = focusedCode.current;
                        focusedCode.current = null;
                        const to = variation.code.trim();
                        if (from && to && from !== to && !variations.some((v, i) => i !== index && (v.code === from || v.code === to))) setDraft((d) => ({ ...d, fields: repoint(d.fields, from, to) }));
                      }}
                      onChange={(e) => {
                        autoCodes.delete(uid);
                        update(index, { code: e.target.value.toLowerCase().replace(/\s+/g, "_") });
                      }}
                    />
                  </Field>
                  <div className="flex items-end gap-0.5 pb-0.5">
                    <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => setDraft((d) => ({ ...d, variations: move(d.variations, index, index - 1) }))} aria-label="Move variation up">
                      <ArrowUp />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" disabled={index === variations.length - 1} onClick={() => setDraft((d) => ({ ...d, variations: move(d.variations, index, index + 1) }))} aria-label="Move variation down">
                      <ArrowDown />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => remove(index)} aria-label="Remove variation">
                      <Trash2 />
                    </Button>
                  </div>
                  <Field label="Description" error={error(index, "description")} className="sm:col-start-2 sm:col-end-4">
                    <Input value={variation.description ?? ""} maxLength={500} placeholder="Optional, e.g. Text beside the image" onChange={(e) => update(index, { description: e.target.value })} />
                  </Field>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center">
            <p className="max-w-md text-[13px] text-muted-foreground">No variations: every instance uses the same layout. The first variation you add becomes the default for new instances.</p>
            {write ? (
              <Button type="button" variant="outline" size="sm" onClick={add}>
                <Plus />
                Add variation
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------- JSON preview

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const highlight = (text: string) => {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (match[1]) {
      out.push(
        <span key={key++} className={match[2] ? "text-primary" : "text-success"}>
          {match[1]}
        </span>,
      );
      if (match[2]) out.push(match[2]);
    } else if (match[3])
      out.push(
        <span key={key++} className="text-info">
          {match[3]}
        </span>,
      );
    else
      out.push(
        <span key={key++} className="text-chart-4">
          {match[4]}
        </span>,
      );
    last = at + match[0].length;
  }
  out.push(text.slice(last));
  return out;
};

const DefinitionCard = ({ json }: { json: ReturnType<typeof toDefinitionJson> }) => {
  const text = useMemo(() => JSON.stringify(json, null, 2), [json]);
  const colored = useMemo(() => highlight(text), [text]);
  return (
    <Card className="lg:sticky lg:top-20">
      <CardHeader>
        <div>
          <CardTitle>Definition</CardTitle>
          <CardDescription>Live, as componentsSync and the components CLI take it.</CardDescription>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Tooltip content="Copy JSON">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copyText(text, "Definition copied")} aria-label="Copy definition JSON">
              <Copy />
            </Button>
          </Tooltip>
          <Tooltip content="Download JSON">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => downloadText(`${json.code || "component"}.json`, `${text}\n`, "application/json")} aria-label="Download definition JSON">
              <Download />
            </Button>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent>
        <pre className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">{colored}</pre>
      </CardContent>
    </Card>
  );
};
