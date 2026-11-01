import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Copy, GripVertical, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form";
import { LocalizedInput } from "@/components/inputs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { Alert } from "@/components/ui/feedback";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger, Sheet, SheetContent, Tooltip } from "@/components/ui/overlay";
import { useReference } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { FIELD_TYPES, TEMPLATE_KINDS, type ComponentKind, type FieldDefinition, type FieldType, type TemplateFor, type Variation } from "../model";
import {
  FIELD_TYPE_INFO,
  INSPECTOR_GROUPS,
  ITEM_FIELD_TYPES,
  hasDefault,
  hasPlaceholder,
  isLocalizable,
  issueAt,
  issuesUnder,
  keepUid,
  move,
  newField,
  rangeOf,
  retypeField,
  toKey,
  toOptionValue,
  uidOf,
  uniqueName,
  type Issue,
} from "./definition";
import { ComponentIcon } from "./icons";
import { useDragReorder } from "./ui";

export type LibraryOption = { code: string; name: string; kind: ComponentKind; icon?: string | null; templateFor?: TemplateFor | null };
type Path = (string | number)[];
type Update = (updater: (field: FieldDefinition) => FieldDefinition) => void;

const TypeIcon = ({ type, className }: { type: FieldType; className?: string }) => {
  const Icon = FIELD_TYPE_INFO[type].icon;
  return <Icon className={className} />;
};

// ---------------------------------------------------------------- add field

export const AddFieldButton = ({ onAdd, nested, disabled, label = "Add field", variant = "outline" }: { onAdd: (type: FieldType) => void; nested?: boolean; disabled?: boolean; label?: string; variant?: "outline" | "default" }) => {
  const [open, setOpen] = useState(false);
  const types = nested ? ITEM_FIELD_TYPES : FIELD_TYPES;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button type="button" variant={variant} size="sm">
          <Plus />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={12} className="max-h-[var(--radix-popover-content-available-height)] w-[34rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-2">
        <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">{nested ? "Item field type" : "Field type"}</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {types.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                setOpen(false);
                onAdd(type);
              }}
              className="flex items-start gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-accent"
            >
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted [&_svg]:size-4">
                <TypeIcon type={type} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{FIELD_TYPE_INFO[type].label}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{FIELD_TYPE_INFO[type].description}</span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

// ---------------------------------------------------------------- field list

const summary = (field: FieldDefinition, library: readonly LibraryOption[]) => {
  if (field.type === "select") return `${field.options?.length ?? 0} option${field.options?.length === 1 ? "" : "s"}`;
  if (field.type === "list") return `${field.fields?.length ?? 0} item field${field.fields?.length === 1 ? "" : "s"}`;
  if (field.type === "blocks") {
    const allowed = field.allowedComponents ?? [];
    if (!allowed.length) return "Any component";
    const names = allowed.map((code) => library.find((c) => c.code === code)?.name ?? code);
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  }
  return null;
};

/** A definition's or list item's fields. Issues match by `prefix` + index, e.g. ["fields", 2]. */
export const FieldList = ({
  fields,
  onChange,
  onEdit,
  issues,
  prefix,
  library,
  disabled,
  nested,
  onRemoved,
}: {
  fields: FieldDefinition[];
  onChange: (update: (fields: FieldDefinition[]) => FieldDefinition[]) => void;
  onEdit: (index: number) => void;
  issues: readonly Issue[];
  prefix: Path;
  library: readonly LibraryOption[];
  disabled?: boolean;
  nested?: boolean;
  onRemoved?: (index: number) => void;
}) => {
  const drag = useDragReorder((from, to) => onChange((list) => move(list, from, to)));

  const remove = (index: number) => {
    const removed = fields[index];
    if (!removed) return;
    onChange((list) => list.filter((_, i) => i !== index));
    onRemoved?.(index);
    toast(`Removed ${removed.label || removed.key || "the field"}`, {
      description: removed.key ? `Pages keep values stored under “${removed.key}”; adding the key back restores them.` : undefined,
      action: { label: "Undo", onClick: () => onChange((list) => [...list.slice(0, index), removed, ...list.slice(index)]) },
    });
  };

  const duplicate = (index: number) => {
    const source = fields[index];
    if (!source) return;
    const copy: FieldDefinition = { ...structuredClone(source), key: uniqueName(source.key || "field", fields.map((f) => f.key)), label: source.label ? `${source.label} (copy)` : "" };
    onChange((list) => [...list.slice(0, index + 1), copy, ...list.slice(index + 1)]);
    onEdit(index + 1);
  };

  return (
    <ul className="flex flex-col gap-1.5">
      {fields.map((field, index) => {
        const problems = issuesUnder(issues, [...prefix, index]);
        const line = drag.dropLine(index);
        const extra = summary(field, library);
        return (
          <li
            key={uidOf(field)}
            {...(disabled ? {} : drag.rowProps(index))}
            className={cn(
              "group relative flex items-center gap-2 rounded-lg border bg-card py-2 pr-1.5 pl-1 transition-colors",
              !disabled && "hover:border-primary/40 hover:bg-accent/30",
              problems.length && "border-destructive/50",
              drag.dragging === index && "opacity-40",
            )}
          >
            {line ? <span className={cn("pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary", line === "before" ? "-top-1" : "-bottom-1")} /> : null}
            <span
              {...(disabled ? {} : drag.handleProps(index))}
              className={cn("flex h-8 w-5 shrink-0 items-center justify-center text-muted-foreground/60", !disabled && "cursor-grab hover:text-foreground active:cursor-grabbing")}
              aria-hidden
            >
              <GripVertical className="size-4" />
            </span>
            {/* Not a <button>: rows stay clickable inside a disabled fieldset, for read-only viewers. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => onEdit(index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onEdit(index);
              }}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                <TypeIcon type={field.type} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cn("truncate font-medium", !field.label && "text-muted-foreground italic")}>{field.label || "Untitled field"}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{field.key || "no key"}</span>
                </span>
                {problems.length ? (
                  <span className="block truncate text-xs text-destructive">{problems.length === 1 ? problems[0]!.message : `${problems.length} problems: ${problems[0]!.message}`}</span>
                ) : field.description || extra ? (
                  <span className="block truncate text-xs text-muted-foreground">{[extra, field.description].filter(Boolean).join(" · ")}</span>
                ) : null}
              </span>
              <span className="hidden shrink-0 flex-wrap items-center justify-end gap-1 sm:flex">
                <Badge variant="secondary" className="rounded-md">
                  {FIELD_TYPE_INFO[field.type].label}
                </Badge>
                {field.required ? <Badge variant="warning">Required</Badge> : null}
                {field.localized ? <Badge variant="outline">Per language</Badge> : null}
                {field.group && field.group !== "Content" ? <Badge variant="outline">{field.group}</Badge> : null}
                {field.variations?.length ? (
                  <Tooltip content={`Only for ${field.variations.join(", ")}`}>
                    <Badge variant="info">
                      {field.variations.length} variation{field.variations.length === 1 ? "" : "s"}
                    </Badge>
                  </Tooltip>
                ) : null}
              </span>
            </div>
            {disabled ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${field.label || field.key || "field"}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => onEdit(index)}>
                    <Pencil />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => duplicate(index)}>
                    <Copy />
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={index === 0} onSelect={() => onChange((list) => move(list, index, index - 1))}>
                    <ArrowUp />
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={index === fields.length - 1} onSelect={() => onChange((list) => move(list, index, index + 1))}>
                    <ArrowDown />
                    Move down
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => remove(index)}>
                    <Trash2 />
                    Remove {nested ? "item field" : "field"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        );
      })}
    </ul>
  );
};

// ---------------------------------------------------------------- the panel

export type FieldSelection = { index: number; item?: number };

/** Edits one field (or a list item's field) in the draft; the page's Save stores it. */
export const FieldPanel = ({
  fields,
  setFields,
  selection,
  onSelect,
  issues,
  variations,
  library,
  original,
  autoKeys,
  disabled,
  ownCode,
}: {
  fields: FieldDefinition[];
  setFields: (update: (fields: FieldDefinition[]) => FieldDefinition[]) => void;
  selection: FieldSelection | null;
  onSelect: (selection: FieldSelection | null) => void;
  /** Issues to show, already filtered (missing values only after a save attempt). */
  issues: readonly Issue[];
  variations: Variation[];
  library: readonly LibraryOption[];
  /** Fields as loaded, by uid: to warn before renaming keys or changing types pages rely on. */
  original: ReadonlyMap<string, FieldDefinition>;
  /** Uids of new fields whose key still follows their label. */
  autoKeys: Set<string>;
  disabled?: boolean;
  /** The component being edited, so a blocks field can allow it (nesting itself). */
  ownCode?: { code: string; name: string } | null;
}) => {
  const parent = selection ? fields[selection.index] : undefined;
  const nested = selection?.item !== undefined;
  const target = nested ? parent?.fields?.[selection!.item!] : parent;
  const open = !!selection && !!target;

  const updateTarget: Update = (updater) => {
    if (!selection) return;
    setFields((list) =>
      list.map((field, i) => {
        if (i !== selection.index) return field;
        if (selection.item === undefined) return keepUid(field, updater(field));
        const items = (field.fields ?? []).map((sub, j) => (j === selection.item ? keepUid(sub, updater(sub)) : sub));
        return keepUid(field, { ...field, fields: items });
      }),
    );
  };

  const setItems = (update: (items: FieldDefinition[]) => FieldDefinition[]) => {
    if (!selection) return;
    setFields((list) => list.map((field, i) => (i === selection.index ? keepUid(field, { ...field, fields: update(field.fields ?? []) }) : field)));
  };

  if (!open || !selection || !target || !parent) return <Sheet open={false} />;

  const prefix: Path = nested ? ["fields", selection.index, "fields", selection.item!] : ["fields", selection.index];
  const siblings = nested ? (parent.fields ?? []) : fields;
  const removeTarget = () => {
    const removed = target;
    const index = nested ? selection.item! : selection.index;
    if (nested) setItems((items) => items.filter((_, j) => j !== index));
    else setFields((list) => list.filter((_, i) => i !== index));
    onSelect(nested ? { index: selection.index } : null);
    toast(`Removed ${removed.label || removed.key || "the field"}`, {
      action: {
        label: "Undo",
        onClick: () => (nested ? setItems((items) => [...items.slice(0, index), removed, ...items.slice(index)]) : setFields((list) => [...list.slice(0, index), removed, ...list.slice(index)])),
      },
    });
  };
  const duplicateTarget = () => {
    const copy: FieldDefinition = { ...structuredClone(target), key: uniqueName(target.key || "field", siblings.map((f) => f.key)), label: target.label ? `${target.label} (copy)` : "" };
    if (nested) {
      setItems((items) => [...items.slice(0, selection.item! + 1), copy, ...items.slice(selection.item! + 1)]);
      onSelect({ index: selection.index, item: selection.item! + 1 });
    } else {
      setFields((list) => [...list.slice(0, selection.index + 1), copy, ...list.slice(selection.index + 1)]);
      onSelect({ index: selection.index + 1 });
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onSelect(null)}>
      <SheetContent className="gap-0 p-0 sm:w-[42rem] sm:max-w-[42rem]" aria-describedby={undefined}>
        <div className="border-b px-6 pt-5 pb-4">
          <nav className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
            <span>Fields</span>
            {nested ? (
              <>
                <ChevronRight className="size-3" />
                <button type="button" className="hover:text-foreground hover:underline" onClick={() => onSelect({ index: selection.index })}>
                  {parent.label || parent.key || "List"}
                </button>
              </>
            ) : null}
            <ChevronRight className="size-3" />
            <span className="text-foreground">{target.label || "New field"}</span>
          </nav>
          <div className="flex items-center gap-3 pr-6">
            {nested ? (
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => onSelect({ index: selection.index })} aria-label="Back to the list field">
                <ArrowLeft />
              </Button>
            ) : null}
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-[18px]">
              <TypeIcon type={target.type} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{target.label || (nested ? "New item field" : "New field")}</h2>
              <p className="text-xs text-muted-foreground">
                {FIELD_TYPE_INFO[target.type].label}
                {nested ? ` · item field of ${parent.label || parent.key}` : ""}
              </p>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <fieldset disabled={disabled} className="contents">
            <FieldForm
              key={uidOf(target)}
              field={target}
              update={updateTarget}
              nested={nested}
              prefix={prefix}
              issues={issues}
              siblingKeys={siblings.filter((f) => f !== target).map((f) => f.key)}
              autoKeys={autoKeys}
              original={original.get(uidOf(target))}
              variations={variations}
              library={library}
              ownCode={ownCode}
              items={
                target.type === "list" && !nested ? (
                  <div className="flex flex-col gap-2">
                    {(target.fields ?? []).length ? (
                      <FieldList
                        nested
                        fields={target.fields ?? []}
                        onChange={setItems}
                        onEdit={(item) => onSelect({ index: selection.index, item })}
                        issues={issues}
                        prefix={[...prefix, "fields"]}
                        library={library}
                        disabled={disabled}
                      />
                    ) : (
                      <p className="rounded-lg border border-dashed px-4 py-5 text-center text-[13px] text-muted-foreground">Each item of the list gets these fields, e.g. a question and an answer.</p>
                    )}
                    {disabled ? null : (
                      <div>
                        <AddFieldButton
                          nested
                          label="Add item field"
                          onAdd={(type) => {
                            const field = newField(type);
                            autoKeys.add(uidOf(field));
                            const index = (target.fields ?? []).length;
                            setItems((items) => [...items, field]);
                            onSelect({ index: selection.index, item: index });
                          }}
                        />
                      </div>
                    )}
                  </div>
                ) : null
              }
            />
          </fieldset>
        </div>
        <div className="flex items-center gap-2 border-t bg-popover px-6 py-3">
          {disabled ? null : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={duplicateTarget}>
                <Copy />
                Duplicate
              </Button>
              <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={removeTarget}>
                <Trash2 />
                Remove
              </Button>
            </>
          )}
          <Button type="button" className="ml-auto" onClick={() => (nested ? onSelect({ index: selection.index }) : onSelect(null))}>
            {nested ? "Back to list" : "Done"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};

// ---------------------------------------------------------------- the form for one field

const chip = (active: boolean) =>
  cn("rounded-md border px-2.5 py-1 text-[13px] transition-colors disabled:opacity-50", active ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground");

const SwitchRow = ({ label, hint, checked, onChange, disabled }: { label: string; hint: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) => (
  <Label className={cn("justify-between gap-4 py-2.5 font-normal", disabled && "opacity-60")}>
    <span>
      <span className="block text-sm">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </span>
    <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
  </Label>
);

const FieldForm = ({
  field,
  update,
  nested,
  prefix,
  issues,
  siblingKeys,
  autoKeys,
  original,
  variations,
  library,
  ownCode,
  items,
}: {
  field: FieldDefinition;
  update: Update;
  nested: boolean;
  prefix: Path;
  issues: readonly Issue[];
  siblingKeys: string[];
  autoKeys: Set<string>;
  original: FieldDefinition | undefined;
  variations: Variation[];
  library: readonly LibraryOption[];
  ownCode?: { code: string; name: string } | null;
  items: ReactNode;
}) => {
  const { locales, defaultLocale } = useReference();
  const uid = uidOf(field);
  const error = (...sub: Path) => issueAt(issues, [...prefix, ...sub]);
  const range = rangeOf(field.type);
  const types = nested ? ITEM_FIELD_TYPES : FIELD_TYPES;
  const set = <K extends Exclude<keyof FieldDefinition, "key" | "type" | "label">>(key: K, value: FieldDefinition[K] | undefined) =>
    update((f) => {
      const next = { ...f };
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key];
      else next[key] = value as FieldDefinition[K];
      return next;
    });

  const renamed = original && original.key !== field.key ? original.key : null;
  const retyped = original && original.type !== field.type ? original.type : null;
  const componentOptions = [
    ...(ownCode?.code && !library.some((c) => c.code === ownCode.code) ? [{ value: ownCode.code, label: `${ownCode.name || ownCode.code} (this component)`, hint: ownCode.code }] : []),
    ...library
      .filter((c) => c.kind === "COMPONENT")
      .map((c) => ({ value: c.code, label: c.name, hint: c.templateFor ? `${c.code} · ${TEMPLATE_KINDS[c.templateFor].data.toLowerCase()}` : c.code, icon: <ComponentIcon name={c.icon} kind={c.kind} className="size-4" /> })),
  ];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Type</h3>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {types.map((type) => (
            <button
              key={type}
              type="button"
              title={FIELD_TYPE_INFO[type].description}
              aria-pressed={field.type === type}
              onClick={() =>
                update((f) => {
                  const next = retypeField(f, type);
                  // A field that is not saved yet gets the new type's usual settings.
                  if (!original && f.type !== type) return { ...newField(type), ...next, ...(isLocalizable(type) && !isLocalizable(f.type) ? { localized: true } : {}) };
                  return next;
                })
              }
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-[13px] transition-colors",
                field.type === type ? "border-primary bg-primary/8 font-medium text-primary ring-1 ring-primary/30" : "hover:bg-accent",
              )}
            >
              <TypeIcon type={type} className="size-4 shrink-0" />
              <span className="truncate">{FIELD_TYPE_INFO[type].label}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{FIELD_TYPE_INFO[field.type].description}</p>
        {error("type") ? <p className="text-xs text-destructive">{error("type")}</p> : null}
        {retyped ? (
          <Alert variant="warning" title={`Changed from ${FIELD_TYPE_INFO[retyped].label}`}>
            Values pages already store for “{field.key}” were saved as {FIELD_TYPE_INFO[retyped].label.toLowerCase()}. Drafts holding such a value will not save until it is cleared or re-entered.
          </Alert>
        ) : null}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Label" required error={error("label")} hint="Shown to editors in the page inspector.">
          <Input
            autoFocus={!field.label}
            value={field.label}
            maxLength={120}
            placeholder={nested ? "e.g. Question" : "e.g. Title"}
            onChange={(e) => {
              const label = e.target.value;
              update((f) => ({ ...f, label, ...(autoKeys.has(uid) ? { key: uniqueName(toKey(label), siblingKeys) } : {}) }));
            }}
          />
        </Field>
        <Field label="Key" required error={error("key")} hint={renamed ? undefined : "Pages store the value under this key; frontends read it."}>
          <Input
            className="font-mono"
            value={field.key}
            maxLength={48}
            placeholder={nested ? "question" : "title"}
            onChange={(e) => {
              const key = e.target.value.replace(/\s+/g, "");
              autoKeys.delete(uid);
              update((f) => ({ ...f, key }));
            }}
          />
        </Field>
        {renamed ? (
          <Alert variant="warning" className="sm:col-span-2" title={`Renamed from “${renamed}”`}>
            Content pages saved under “{renamed}” stays stored but is no longer shown or delivered. Rename it back to restore it, and update frontends that read the old key.
          </Alert>
        ) : null}
        <Field label="Help text" className="sm:col-span-2" error={error("description")} hint="Optional; shown under the field in the page editor.">
          <Textarea rows={2} maxLength={500} value={field.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Keep it under 60 characters" />
        </Field>
        {hasPlaceholder(field.type) ? (
          <Field label="Placeholder" className="sm:col-span-2" error={error("placeholder")}>
            <Input maxLength={200} value={field.placeholder ?? ""} onChange={(e) => set("placeholder", e.target.value)} placeholder="Shown in the empty input" />
          </Field>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Inspector tab</h3>
        <GroupPicker value={field.group} onChange={(group) => set("group", group)} />
        {error("group") ? <p className="text-xs text-destructive">{error("group")}</p> : <p className="text-xs text-muted-foreground">Where the field appears in the page editor's inspector.</p>}
      </section>

      <section className="flex flex-col divide-y rounded-lg border px-3">
        <SwitchRow
          label="Required"
          hint={field.type === "boolean" ? "Toggles are always on or off." : field.type === "blocks" || field.type === "list" || field.type === "products" ? "Needs at least one entry before a page can be published." : "Must be filled in before a page can be published."}
          checked={!!field.required}
          onChange={(v) => set("required", v || undefined)}
          disabled={field.type === "boolean"}
        />
        <SwitchRow
          label="Per language"
          hint={isLocalizable(field.type) ? "One value per locale; empty locales fall back to the default one." : "Only text and rich text can have a value per language."}
          checked={!!field.localized && isLocalizable(field.type)}
          disabled={!isLocalizable(field.type)}
          onChange={(v) =>
            update((f) => {
              const next = { ...f };
              if (v) next.localized = true;
              else delete next.localized;
              // Keep a default value usable: text ↔ text per locale.
              if (typeof f.defaultValue === "string" && v) next.defaultValue = { [defaultLocale]: f.defaultValue };
              else if (f.defaultValue && typeof f.defaultValue === "object" && !v) {
                const values = f.defaultValue as Record<string, string>;
                const text = values[defaultLocale] ?? Object.values(values)[0];
                if (text) next.defaultValue = text;
                else delete next.defaultValue;
              }
              return next;
            })
          }
        />
        {field.type === "text" ? <SwitchRow label="Multiline" hint="Edit in a text area instead of a single line." checked={!!field.multiline} onChange={(v) => set("multiline", v || undefined)} /> : null}
        {error("localized") ? <p className="py-2 text-xs text-destructive">{error("localized")}</p> : null}
      </section>

      {field.type === "select" ? <OptionsEditor field={field} update={update} prefix={prefix} issues={issues} /> : null}

      {range ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{range.kind === "value" ? "Range" : range.kind === "length" ? "Length" : "Number of items"}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={range.min} error={error("min")}>
              <Input
                type="number"
                step={range.kind === "value" ? "any" : 1}
                min={range.kind === "value" ? undefined : 0}
                value={field.min ?? ""}
                onChange={(e) => set("min", e.target.value === "" ? undefined : Number(e.target.value))}
                placeholder="No minimum"
              />
            </Field>
            <Field label={range.max} error={error("max")}>
              <Input
                type="number"
                step={range.kind === "value" ? "any" : 1}
                min={range.kind === "value" ? undefined : 0}
                value={field.max ?? ""}
                onChange={(e) => set("max", e.target.value === "" ? undefined : Number(e.target.value))}
                placeholder="No maximum"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{range.hint}</p>
        </section>
      ) : null}

      {field.type === "blocks" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Allowed components</h3>
          <MultiSelect options={componentOptions} value={field.allowedComponents ?? []} onChange={(v) => set("allowedComponents", v)} placeholder="Any component" searchPlaceholder="Search components…" />
          {error("allowedComponents") ? (
            <p className="text-xs text-destructive">{error("allowedComponents")}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Leave empty to allow every component. Content types never nest, and components with product or category data only fit templates of that kind.</p>
          )}
        </section>
      ) : null}

      {field.type === "list" && !nested ? (
        <section className="flex flex-col gap-2">
          <div>
            <h3 className="text-sm font-semibold">Item fields</h3>
            <p className="text-xs text-muted-foreground">The fields of each item. Items cannot hold blocks or lists.</p>
          </div>
          {error("fields") ? <p className="text-xs text-destructive">{error("fields")}</p> : null}
          {items}
        </section>
      ) : null}

      {variations.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Variations</h3>
          <MultiSelect
            options={variations.map((v) => ({ value: v.code, label: v.name || v.code, hint: v.code }))}
            value={field.variations ?? []}
            onChange={(v) => set("variations", v)}
            placeholder="Every variation"
            searchPlaceholder="Search variations…"
          />
          {error("variations") ? <p className="text-xs text-destructive">{error("variations")}</p> : <p className="text-xs text-muted-foreground">Show the field only for these variations; empty shows it for all.</p>}
        </section>
      ) : null}

      {hasDefault(field.type) ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Default value</h3>
          <DefaultValueInput field={field} onChange={(value) => set("defaultValue", value)} locales={locales} defaultLocale={defaultLocale} invalid={!!error("defaultValue")} />
          {error("defaultValue") ? <p className="text-xs text-destructive">{error("defaultValue")}</p> : <p className="text-xs text-muted-foreground">Filled in when an editor adds the {nested ? "item" : "component"}.</p>}
        </section>
      ) : null}
    </div>
  );
};

/** Content, Style, Settings, or a custom tab name. Absent means Content. */
const GroupPicker = ({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) => {
  const current = value ?? "";
  const preset = current === "" || (INSPECTOR_GROUPS as readonly string[]).includes(current);
  const [custom, setCustom] = useState(!preset);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {INSPECTOR_GROUPS.map((group) => {
        const active = !custom && (group === "Content" ? current === "" || current === "Content" : current === group);
        return (
          <button
            key={group}
            type="button"
            className={chip(active)}
            onClick={() => {
              setCustom(false);
              onChange(group === "Content" ? (current === "Content" ? "Content" : undefined) : group);
            }}
          >
            {group}
            {group === "Content" ? <span className="font-normal opacity-70"> · default</span> : null}
          </button>
        );
      })}
      <button
        type="button"
        className={chip(custom)}
        onClick={() => {
          setCustom(true);
          if (preset) onChange(undefined);
        }}
      >
        Custom…
      </button>
      {custom ? <Input autoFocus className="h-8 w-44" maxLength={40} value={current} placeholder="e.g. Layout" onChange={(e) => onChange(e.target.value || undefined)} aria-label="Custom tab name" /> : null}
    </div>
  );
};

/** Value and label rows for a select field; values follow labels until edited. */
const OptionsEditor = ({ field, update, prefix, issues }: { field: FieldDefinition; update: Update; prefix: Path; issues: readonly Issue[] }) => {
  const options = field.options ?? [];
  const [linked, setLinked] = useState(() => new Set(options.filter((o) => !o.value && !o.label).map(uidOf)));
  const setOptions = (next: (list: NonNullable<FieldDefinition["options"]>) => NonNullable<FieldDefinition["options"]>) => update((f) => ({ ...f, options: next(f.options ?? []) }));
  const drag = useDragReorder((from, to) => setOptions((list) => move(list, from, to)));
  const error = (...sub: Path) => issueAt(issues, [...prefix, "options", ...sub]);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Options</h3>
          <p className="text-xs text-muted-foreground">Editors see the label; pages store the value.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const option = { value: "", label: "" };
            setLinked((s) => new Set(s).add(uidOf(option)));
            setOptions((list) => [...list, option]);
          }}
        >
          <Plus />
          Add option
        </Button>
      </div>
      {error() ? <p className="text-xs text-destructive">{error()}</p> : null}
      {options.length ? (
        <ul className="flex flex-col gap-1.5">
          <li className="grid grid-cols-[1.25rem_1fr_1fr_4.5rem] gap-2 px-1 text-xs font-medium text-muted-foreground">
            <span />
            <span>Label</span>
            <span>Value</span>
            <span />
          </li>
          {options.map((option, index) => {
            const line = drag.dropLine(index);
            const uid = uidOf(option);
            return (
              <li key={uid} {...drag.rowProps(index)} className={cn("relative grid grid-cols-[1.25rem_1fr_1fr_4.5rem] items-start gap-2 rounded-md px-1 py-0.5", drag.dragging === index && "opacity-40")}>
                {line ? <span className={cn("pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary", line === "before" ? "-top-0.5" : "-bottom-0.5")} /> : null}
                <span {...drag.handleProps(index)} className="flex h-9 cursor-grab items-center justify-center text-muted-foreground/60 hover:text-foreground active:cursor-grabbing" aria-hidden>
                  <GripVertical className="size-4" />
                </span>
                <div>
                  <Input
                    autoFocus={!option.label && !option.value}
                    value={option.label}
                    maxLength={120}
                    aria-label={`Option ${index + 1} label`}
                    aria-invalid={!!error(index, "label")}
                    placeholder="Label"
                    onChange={(e) => {
                      const label = e.target.value;
                      setOptions((list) => list.map((o, i) => (i === index ? keepUid(o, { label, value: linked.has(uid) ? toOptionValue(label) : o.value }) : o)));
                    }}
                  />
                  {error(index, "label") ? <p className="mt-1 text-xs text-destructive">{error(index, "label")}</p> : null}
                </div>
                <div>
                  <Input
                    className="font-mono"
                    value={option.value}
                    maxLength={100}
                    aria-label={`Option ${index + 1} value`}
                    aria-invalid={!!error(index, "value")}
                    placeholder="value"
                    onChange={(e) => {
                      const value = e.target.value;
                      setLinked((s) => {
                        const next = new Set(s);
                        next.delete(uid);
                        return next;
                      });
                      setOptions((list) => list.map((o, i) => (i === index ? keepUid(o, { ...o, value }) : o)));
                    }}
                  />
                  {error(index, "value") ? <p className="mt-1 text-xs text-destructive">{error(index, "value")}</p> : null}
                </div>
                <div className="flex items-center">
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => setOptions((list) => move(list, index, index - 1))} aria-label="Move option up">
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOptions((list) => list.filter((_, i) => i !== index))} aria-label="Remove option">
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-4 text-center text-[13px] text-muted-foreground">Add the choices editors pick from, e.g. Light and Dark.</p>
      )}
    </section>
  );
};

const DefaultValueInput = ({ field, onChange, locales, defaultLocale, invalid }: { field: FieldDefinition; onChange: (value: unknown) => void; locales: readonly string[]; defaultLocale: string; invalid: boolean }) => {
  const value = field.defaultValue;
  switch (field.type) {
    case "text":
    case "richText": {
      const multiline = field.type === "richText" || !!field.multiline;
      if (field.localized) {
        const record = typeof value === "string" ? { [defaultLocale]: value } : value && typeof value === "object" ? (value as Record<string, string>) : {};
        return (
          <LocalizedInput
            value={record}
            locales={locales}
            multiline={multiline}
            rows={3}
            invalid={invalid}
            placeholder="No default"
            onChange={(next) => {
              const filled = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== ""));
              onChange(Object.keys(filled).length ? filled : undefined);
            }}
          />
        );
      }
      const text = typeof value === "string" ? value : "";
      return multiline ? (
        <Textarea rows={3} value={text} aria-invalid={invalid} placeholder="No default" onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
      ) : (
        <Input value={text} aria-invalid={invalid} placeholder="No default" onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
      );
    }
    case "number":
      return <Input type="number" step="any" className="w-48" value={typeof value === "number" ? value : ""} aria-invalid={invalid} placeholder="No default" onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
    case "boolean":
      return (
        <NativeSelect className="w-48" value={value === true ? "on" : value === false ? "off" : ""} onChange={(e) => onChange(e.target.value === "on" ? true : e.target.value === "off" ? false : undefined)}>
          <option value="">No default (off)</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </NativeSelect>
      );
    case "select":
      return (
        <NativeSelect className="w-64" value={typeof value === "string" ? value : ""} aria-invalid={invalid} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
          <option value="">No default</option>
          {(field.options ?? [])
            .filter((o) => o.value)
            .map((o, i) => (
              <option key={`${o.value}-${i}`} value={o.value}>
                {o.label || o.value}
              </option>
            ))}
          {typeof value === "string" && value && !(field.options ?? []).some((o) => o.value === value) ? <option value={value}>{value} (not an option)</option> : null}
        </NativeSelect>
      );
    case "color": {
      const text = typeof value === "string" ? value : "";
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick a color"
            className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
            value={/^#[0-9a-fA-F]{6}$/.test(text) ? text : "#000000"}
            onChange={(e) => onChange(e.target.value)}
          />
          <Input className="w-40 font-mono" value={text} aria-invalid={invalid} placeholder="#1f2937" onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
          {text ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
              Clear
            </Button>
          ) : null}
        </div>
      );
    }
    case "date":
      return <Input type="date" className="w-48" value={typeof value === "string" ? value.slice(0, 10) : ""} aria-invalid={invalid} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />;
    default:
      return null;
  }
};
