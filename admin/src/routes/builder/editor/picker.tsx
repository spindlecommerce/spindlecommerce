import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { allowedIn, pageKindOf, TEMPLATE_KINDS, type ComponentDef } from "../model";
import { ComponentIcon } from "./icons";
import { useEditor, useEditorState } from "./store";
import { indexTree } from "./util";

/** Offers only the components the blocks field allows and the page fits (see allowedIn). */
export const ComponentPicker = () => {
  const target = useEditorState((s) => s.picker);
  const { actions } = useEditor();
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && actions.closePicker()}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0" aria-describedby={undefined}>
        {target ? <PickerBody key={`${target.parentId}.${target.fieldKey}.${target.index ?? "end"}`} /> : null}
      </DialogContent>
    </Dialog>
  );
};

const PickerBody = () => {
  const { actions, components, contentType, defs, store } = useEditor();
  const target = store.get().picker!;
  const doc = store.get().doc;
  const parent = indexTree(doc.root, defs).get(target.parentId)?.node;
  const field = parent ? defs.get(parent.component)?.fields.find((f) => f.key === target.fieldKey) : undefined;
  const pageKind = pageKindOf(contentType);
  const allowed = useMemo(() => (field ? allowedIn(field, components, pageKind) : []), [field, components, pageKind]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, ComponentDef[]>();
    for (const c of allowed) {
      const group = c.groupName || "Other";
      byGroup.set(group, [...(byGroup.get(group) ?? []), c]);
    }
    return [...byGroup.entries()];
  }, [allowed]);
  const [query, setQuery] = useState("");
  // Names first, then words in names, then groups and descriptions.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const score = (c: ComponentDef) => {
      const name = c.name.toLowerCase();
      if (name === q || c.code === q) return 100;
      if (name.startsWith(q) || c.code.startsWith(q)) return 80;
      if (name.split(/[\s_-]+/).some((w) => w.startsWith(q))) return 60;
      if (name.includes(q) || c.code.includes(q)) return 40;
      if ((c.groupName ?? "").toLowerCase().startsWith(q)) return 25;
      const words = (c.description ?? "").toLowerCase().split(/[^a-z0-9]+/);
      if (words.some((w) => w.startsWith(q))) return 20;
      return (c.description ?? "").toLowerCase().includes(q) ? 10 : 0;
    };
    return allowed
      .map((c) => ({ c, s: score(c) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
      .map((r) => r.c);
  }, [allowed, query]);
  const shown = results ?? allowed;
  const [active, setActive] = useState(allowed[0]?.code ?? "");
  const current = shown.find((c) => c.code === active) ?? shown[0];
  const count = parent && field && Array.isArray(parent.fields[field.key]) ? (parent.fields[field.key] as unknown[]).length : 0;
  const full = field?.max != null && count >= field.max;
  const parentName = parent ? defs.get(parent.component)?.name : "";
  const pick = (def: ComponentDef) => {
    if (actions.insert(target, def)) actions.closePicker();
  };

  return (
    <>
      <div className="border-b px-5 pt-4 pb-3">
        <DialogTitle>Add to {field?.label.toLowerCase() ?? "the page"}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[13px]">
          {parentName ? `${parentName} › ${field?.label}` : null}
          {target.index != null ? ` · position ${target.index + 1}` : ""}
          {field?.max != null ? ` · ${count} of at most ${field.max}` : ""}
        </DialogDescription>
      </div>
      {full ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {field!.label} already has {field!.max}, the most it allows. Remove one first.
        </p>
      ) : allowed.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">No components are allowed here. Check the field&apos;s allowed components in the library.</p>
      ) : (
        <CommandPrimitive value={current?.code ?? ""} onValueChange={setActive} shouldFilter={false} loop className="grid h-[min(30rem,70vh)] grid-cols-1 sm:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex items-center gap-2 border-b px-4">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input autoFocus value={query} onValueChange={setQuery} placeholder="Search components…" className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            </div>
            <CommandPrimitive.List className="min-h-0 flex-1 overflow-y-auto p-2">
              {results && !results.length ? <p className="py-10 text-center text-sm text-muted-foreground">No components match “{query.trim()}”.</p> : null}
              {(results ? ([["Best matches", results]] as [string, ComponentDef[]][]) : groups).map(([group, items]) => (
                <CommandPrimitive.Group key={group} heading={group} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase">
                  {items.map((c) => (
                    <CommandPrimitive.Item key={c.code} value={c.code} onSelect={() => pick(c)} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 outline-none data-[selected=true]:bg-accent">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-xs">
                        <ComponentIcon name={c.icon} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        {c.description ? <span className="block truncate text-xs text-muted-foreground">{c.description}</span> : null}
                      </span>
                      {results ? <span className="shrink-0 text-[11px] text-muted-foreground">{c.groupName ?? "Other"}</span> : null}
                    </CommandPrimitive.Item>
                  ))}
                </CommandPrimitive.Group>
              ))}
            </CommandPrimitive.List>
          </div>
          {current ? <Preview def={current} onPick={() => pick(current)} /> : null}
        </CommandPrimitive>
      )}
    </>
  );
};

const Preview = ({ def, onPick }: { def: ComponentDef; onPick: () => void }) => (
  <div className="hidden min-h-0 flex-col overflow-y-auto bg-muted/30 p-4 sm:flex">
    <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-background">
      {def.previewImageUrl ? <img src={def.previewImageUrl} alt="" className="size-full object-cover" /> : <ComponentIcon name={def.icon} className="size-10 text-muted-foreground/50" strokeWidth={1.25} />}
    </div>
    <p className="mt-3 text-sm font-semibold">{def.name}</p>
    {def.templateFor ? <p className="mt-0.5 text-[11px] font-medium text-info">Shows the {TEMPLATE_KINDS[def.templateFor].one} being viewed</p> : null}
    {def.description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{def.description}</p> : null}
    {def.variations.length > 1 ? (
      <div className="mt-3">
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Variations</p>
        <ul className="mt-1 flex flex-col gap-1">
          {def.variations.map((v) => (
            <li key={v.code} className="text-xs">
              <span className="font-medium">{v.name}</span>
              {v.description ? <span className="text-muted-foreground"> — {v.description}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    {def.fields.length ? (
      <div className="mt-3">
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Fields</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{def.fields.map((f) => f.label).join(", ")}</p>
      </div>
    ) : null}
    <button
      type="button"
      onClick={onPick}
      className={cn("mt-auto flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary pt-px text-[13px] font-medium text-primary-foreground shadow-xs hover:bg-primary/90")}
    >
      Add {def.name}
      <kbd className="rounded bg-primary-foreground/15 px-1 font-mono text-[10px]">↵</kbd>
    </button>
  </div>
);
