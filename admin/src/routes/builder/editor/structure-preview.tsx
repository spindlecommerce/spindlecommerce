import { ArrowDown, ArrowUp, Copy, CornerLeftUp, Eye, EyeOff, ImageIcon, Link2, Plus, Trash2 } from "lucide-react";
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@/lib/markdown";
import { textIn, visibleFields, walk, type Definitions, type FieldDefinition, type ImageValue, type PageNode } from "../model";
import { useReferenceNames, type ReferenceSummary } from "./api";
import { ComponentIcon } from "./icons";
import { DEVICES, useEditor, useEditorState } from "./store";
import { isLink, isObject, listItemLabel, plainText, truncate } from "./util";

/** The document as wireframe cards, so editing works without a storefront or while it's down. */

const NamesContext = createContext<ReadonlyMap<string, ReferenceSummary>>(new Map());

/** Ids of the pages, products and categories a document points at, for their names. */
const referencedIds = (root: PageNode, defs: Definitions) => {
  const ids = new Set<string>();
  const add = (field: FieldDefinition, value: unknown) => {
    if ((field.type === "product" || field.type === "category") && typeof value === "string") ids.add(value);
    if (field.type === "products" && Array.isArray(value)) for (const v of value) if (typeof v === "string") ids.add(v);
    if (field.type === "link" && isLink(value) && value.kind !== "url") ids.add(value.id);
    if (field.type === "list" && Array.isArray(value)) for (const item of value) if (isObject(item) && isObject(item.fields)) for (const sub of field.fields ?? []) add(sub, item.fields[sub.key]);
  };
  walk(root, defs, (node) => {
    for (const field of defs.get(node.component)?.fields ?? []) add(field, node.fields[field.key]);
  });
  return [...ids];
};

export const StructurePreview = () => {
  const { defs, contentType } = useEditor();
  const root = useEditorState((s) => s.doc.root);
  const device = useEditorState((s) => s.device);
  const title = useEditorState((s) => textIn(s.doc.title, s.locale, true));
  const path = useEditorState((s) => s.doc.path);
  const ids = useMemo(() => referencedIds(root, defs), [root, defs]);
  const { names } = useReferenceNames(ids);
  const width = DEVICES[device].width;
  const { actions } = useEditor();

  return (
    <NamesContext.Provider value={names}>
      <div className="h-full overflow-y-auto" onClick={() => actions.select(null)}>
        <div className="mx-auto my-4 flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm" style={{ maxWidth: width ?? undefined, width: width ? "100%" : "calc(100% - 2rem)" }}>
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <span className="flex gap-1">
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
              <span className="size-2.5 rounded-full bg-border" />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-background px-2.5 py-1 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">{title || "Untitled"}</span>
              <span className="truncate font-mono">{path ?? contentType.name}</span>
            </span>
            <span className="text-[11px] whitespace-nowrap text-muted-foreground">Structure preview</span>
          </div>
          <div className="flex flex-col gap-3 p-3 sm:p-4">
            <RootFields node={root} />
            {contentType.fields
              .filter((f) => f.type === "blocks")
              .map((field) => (
                <WireSlot key={field.key} parent={root} field={field} depth={0} />
              ))}
          </div>
        </div>
      </div>
    </NamesContext.Provider>
  );
};

/** The content type's own fields, e.g. a header's announcement and navigation. */
const RootFields = ({ node }: { node: PageNode }) => {
  const { contentType, actions } = useEditor();
  const locale = useEditorState((s) => s.locale);
  const fields = visibleFields(contentType, node).filter((f) => f.type !== "blocks");
  const selectedField = useEditorState((s) => (s.selection?.nodeId === node.id ? (s.selection.path[0] ?? null) : null));
  if (!fields.length) return null;
  return (
    <div className="rounded-lg border border-dashed p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <ComponentIcon name={contentType.icon} className="size-3.5" /> {contentType.name}
      </p>
      <FieldPreviews node={node} fields={fields} locale={locale} selectedField={selectedField} onPick={(path) => actions.select({ nodeId: node.id, path }, { focus: true })} />
    </div>
  );
};

const WireSlot = memo(({ parent, field, depth }: { parent: PageNode; field: FieldDefinition; depth: number }) => {
  const { actions } = useEditor();
  const children = Array.isArray(parent.fields[field.key]) ? (parent.fields[field.key] as PageNode[]) : [];
  const full = field.max != null && children.length >= field.max;
  const insert = (index?: number) => actions.openPicker({ parentId: parent.id, fieldKey: field.key, index });
  if (!children.length) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          insert();
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
      >
        <Plus className="size-3.5" /> {depth === 0 ? `Add the first ${field.label.replace(/s$/, "").toLowerCase()}` : `Add to ${field.label.toLowerCase()}`}
      </button>
    );
  }
  return (
    <div className={cn("flex flex-col", depth === 0 ? "gap-0" : "gap-0")}>
      {depth > 0 ? <p className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{field.label}</p> : null}
      {children.map((child, i) => (
        <div key={child.id}>
          {i === 0 && !full ? <InsertLine onClick={() => insert(0)} /> : null}
          <WireNode node={child} depth={depth} index={i} count={children.length} full={full} atMin={children.length - 1 < Math.max(field.required ? 1 : 0, field.min ?? 0)} />
          {!full ? <InsertLine onClick={() => insert(i + 1)} /> : <div className="h-2" />}
        </div>
      ))}
    </div>
  );
});

const InsertLine = ({ onClick }: { onClick: () => void }) => (
  <div className="group/insert relative flex h-3 items-center justify-center">
    <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary opacity-0 transition-opacity group-hover/insert:opacity-60" />
    <button
      type="button"
      aria-label="Insert a component here"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="relative z-10 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover/insert:opacity-100 hover:border-primary hover:text-primary focus-visible:opacity-100"
    >
      <Plus className="size-3" />
    </button>
  </div>
);

const WireNode = memo(({ node, depth, index, count, full, atMin }: { node: PageNode; depth: number; index: number; count: number; full: boolean; atMin: boolean }) => {
  const { actions, defs } = useEditor();
  const def = defs.get(node.component);
  const locale = useEditorState((s) => s.locale);
  const selected = useEditorState((s) => s.selection?.nodeId === node.id);
  const selectedField = useEditorState((s) => (s.selection?.nodeId === node.id ? (s.selection.path[0] ?? null) : null));
  const hovered = useEditorState((s) => s.hoveredNodeId === node.id);
  const error = useEditorState((s) => [...s.issues, ...s.saveIssues].some((i) => i.path[0] === "node" && i.path[1] === node.id));
  if (!def) {
    return (
      <div className="rounded-lg border border-dashed border-destructive/50 p-3 text-xs text-destructive" onClick={(e) => e.stopPropagation()}>
        Unknown component {node.component}
      </div>
    );
  }
  const fields = visibleFields(def, node);
  const variation = def.variations.length > 1 ? def.variations.find((v) => v.code === (node.variation ?? def.variations[0]?.code)) : null;
  const tool = (label: string, icon: ReactNode, run: () => void, disabled?: boolean, destructive?: boolean) => (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          run();
        }}
        className={cn("flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 [&_svg]:size-3.5", destructive && "hover:text-destructive")}
      >
        {icon}
      </button>
    </Tooltip>
  );
  return (
    <div
      data-wire-node={node.id}
      onClick={(e) => {
        e.stopPropagation();
        actions.select({ nodeId: node.id, path: [] });
      }}
      onMouseEnter={() => actions.hover(node.id)}
      onMouseLeave={() => actions.hover(null)}
      className={cn(
        "group/node relative cursor-pointer rounded-lg border bg-card transition-[box-shadow,border-color]",
        selected ? "border-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary)_18%,transparent)]" : hovered ? "border-primary/50" : "hover:border-primary/40",
        node.hidden && "border-dashed bg-muted/40 opacity-60",
        error && !selected && "border-destructive/60",
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <ComponentIcon name={def.icon} className={cn("size-3.5", selected ? "text-primary" : "text-muted-foreground")} />
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{def.name}</span>
        {variation ? <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{variation.name}</span> : null}
        {node.hidden ? (
          <span className="flex items-center gap-1 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
            <EyeOff className="size-3" /> Hidden
          </span>
        ) : null}
        <span className={cn("ml-auto flex items-center rounded-md border bg-background opacity-0 shadow-xs transition-opacity group-hover/node:opacity-100", selected && "opacity-100")}>
          {tool("Select parent", <CornerLeftUp />, () => actions.selectParent(node.id), depth === 0)}
          {tool("Move up", <ArrowUp />, () => actions.move(node.id, -1), index === 0)}
          {tool("Move down", <ArrowDown />, () => actions.move(node.id, 1), index === count - 1)}
          {tool("Duplicate", <Copy />, () => actions.duplicate(node.id), full)}
          {tool(node.hidden ? "Show" : "Hide", node.hidden ? <Eye /> : <EyeOff />, () => actions.toggleHidden(node.id))}
          {tool(atMin ? "Delete (at the minimum)" : "Delete", <Trash2 />, () => actions.remove(node.id), atMin, true)}
        </span>
      </div>
      <div className="px-3 pb-3">
        <FieldPreviews node={node} fields={fields.filter((f) => f.type !== "blocks")} locale={locale} selectedField={selectedField} onPick={(path) => actions.select({ nodeId: node.id, path }, { focus: true })} />
        {fields
          .filter((f) => f.type === "blocks")
          .map((field) => (
            <div key={field.key} className="mt-2.5 rounded-md bg-muted/40 p-2">
              <WireSlot parent={node} field={field} depth={depth + 1} />
            </div>
          ))}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------- field values

const imageOf = (value: unknown): ImageValue | null => (isObject(value) && typeof value.url === "string" && value.url ? (value as ImageValue) : null);

const FieldPreviews = ({ node, fields, locale, selectedField, onPick }: { node: PageNode; fields: FieldDefinition[]; locale: string; selectedField: string | null; onPick: (path: string[]) => void }) => {
  const names = useContext(NamesContext);
  const firstText = fields.find((f) => f.type === "text" && textIn(node.fields[f.key], locale, true).trim());
  const media = fields.filter((f) => f.type === "image" && imageOf(node.fields[f.key]));
  const chips: ReactNode[] = [];
  const blocks: ReactNode[] = [];
  const pick = (field: FieldDefinition, rest: string[] = []) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onPick([field.key, ...rest]);
  };
  const ring = (field: FieldDefinition) => cn("rounded-sm transition-shadow hover:ring-2 hover:ring-primary/30 hover:ring-offset-2 hover:ring-offset-card", selectedField === field.key && "ring-2 ring-primary/60 ring-offset-2 ring-offset-card");

  for (const field of fields) {
    const value = node.fields[field.key];
    switch (field.type) {
      case "text": {
        const text = textIn(value, locale, true).trim();
        const fallback = !textIn(value, locale).trim() && text;
        if (!text) {
          if (field.required) blocks.push(<Empty key={field.key} label={field.label} onClick={pick(field)} className={ring(field)} />);
          break;
        }
        blocks.push(
          <p key={field.key} onClick={pick(field)} className={cn(ring(field), field === firstText ? "text-[15px] leading-snug font-semibold" : "text-[13px] leading-relaxed text-foreground/80", "whitespace-pre-line", fallback && "text-muted-foreground italic")} title={fallback ? `Not translated to ${locale} yet` : field.label}>
            {truncate(text, field === firstText ? 140 : 280)}
          </p>,
        );
        break;
      }
      case "richText": {
        const text = textIn(value, locale, true).trim();
        if (!text) {
          if (field.required) blocks.push(<Empty key={field.key} label={field.label} onClick={pick(field)} className={ring(field)} />);
          break;
        }
        blocks.push(
          <div
            key={field.key}
            onClick={pick(field)}
            className={cn(ring(field), "line-clamp-6 text-[12.5px] leading-relaxed text-foreground/80 [&_a]:text-primary [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-1 [&_ul]:list-disc")}
            // renderMarkdown escapes the text first and only allows safe link targets.
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />,
        );
        break;
      }
      case "image":
        if (!imageOf(value) && field.required) blocks.push(<Empty key={field.key} label={field.label} onClick={pick(field)} className={ring(field)} />);
        break;
      case "list": {
        const items = Array.isArray(value) ? value.filter((v): v is { id: string; fields: Record<string, unknown> } => isObject(v) && typeof v.id === "string" && isObject(v.fields)) : [];
        if (!items.length) {
          if (field.required || field.min) blocks.push(<Empty key={field.key} label={field.label} onClick={pick(field)} className={ring(field)} />);
          break;
        }
        const thumbField = (field.fields ?? []).find((f) => f.type === "image");
        const refField = (field.fields ?? []).find((f) => f.type === "category" || f.type === "product");
        blocks.push(
          <div key={field.key} className="flex flex-col gap-1">
            <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{field.label}</p>
            <div className={cn("grid gap-1.5", items.length > 2 ? "grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]" : "grid-cols-1 sm:grid-cols-2")}>
              {items.map((item, i) => {
                const image = thumbField ? imageOf(item.fields[thumbField.key]) : null;
                const ref = refField && typeof item.fields[refField.key] === "string" ? names.get(item.fields[refField.key] as string) : undefined;
                const label = listItemLabel(field, item, locale, i);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={pick(field, [item.id])}
                    className={cn("flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:border-primary/40", selectedField === field.key && "border-primary/30")}
                  >
                    {image ? <img src={image.url} alt="" className="size-7 shrink-0 rounded object-cover" loading="lazy" /> : null}
                    <span className="min-w-0 flex-1 truncate">{label.match(/^\w+ \d+$/) && ref ? ref.label : label}</span>
                  </button>
                );
              })}
            </div>
          </div>,
        );
        break;
      }
      case "products": {
        const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
        if (!ids.length) {
          if (field.required || field.min) blocks.push(<Empty key={field.key} label={field.label} onClick={pick(field)} className={ring(field)} />);
          break;
        }
        blocks.push(
          <div key={field.key} onClick={pick(field)} className={cn(ring(field), "grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1.5")}>
            {ids.slice(0, 8).map((id) => {
              const product = names.get(id);
              return (
                <div key={id} className="flex min-w-0 flex-col gap-1">
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md border bg-muted">
                    {product?.image ? <img src={product.image} alt="" className="size-full object-cover" loading="lazy" /> : <ImageIcon className="size-4 text-muted-foreground/50" />}
                  </div>
                  <span className={cn("truncate text-[10px] text-muted-foreground", product?.missing && "text-destructive")}>{product?.label ?? "…"}</span>
                </div>
              );
            })}
            {ids.length > 8 ? <span className="flex aspect-square items-center justify-center rounded-md border text-xs text-muted-foreground">+{ids.length - 8}</span> : null}
          </div>,
        );
        break;
      }
      case "product":
      case "category": {
        if (typeof value !== "string") {
          if (field.required) blocks.push(<Empty key={field.key} label={field.label} onClick={pick(field)} className={ring(field)} />);
          break;
        }
        const ref = names.get(value);
        chips.push(<Chip key={field.key} label={field.label} value={ref?.label ?? "…"} onClick={pick(field)} className={ring(field)} danger={ref?.missing} />);
        break;
      }
      case "link": {
        if (!isLink(value)) {
          if (field.required) chips.push(<Chip key={field.key} label={field.label} value="missing" onClick={pick(field)} className={ring(field)} danger />);
          break;
        }
        const target = value.kind === "url" ? value.url : (names.get(value.id)?.hint ?? names.get(value.id)?.label ?? value.kind);
        chips.push(<Chip key={field.key} icon={<Link2 className="size-3" />} label={field.label} value={truncate(target, 40)} onClick={pick(field)} className={ring(field)} />);
        break;
      }
      case "select": {
        const option = field.options?.find((o) => o.value === value);
        if (option) chips.push(<Chip key={field.key} label={field.label} value={option.label} onClick={pick(field)} className={ring(field)} />);
        break;
      }
      case "boolean":
        if (typeof value === "boolean") chips.push(<Chip key={field.key} label={field.label} value={value ? "on" : "off"} onClick={pick(field)} className={ring(field)} />);
        break;
      case "number":
        if (typeof value === "number") chips.push(<Chip key={field.key} label={field.label} value={String(value)} onClick={pick(field)} className={ring(field)} />);
        break;
      case "color":
        if (typeof value === "string") chips.push(<Chip key={field.key} icon={<span className="size-2.5 rounded-sm border" style={{ background: value }} />} label={field.label} value={value} onClick={pick(field)} className={ring(field)} />);
        break;
      case "date":
        if (typeof value === "string") chips.push(<Chip key={field.key} label={field.label} value={value.slice(0, 10)} onClick={pick(field)} className={ring(field)} />);
        break;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {media.length ? (
        <div className={cn("grid gap-2", media.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
          {media.map((field) => {
            const image = imageOf(node.fields[field.key])!;
            return (
              <button key={field.key} type="button" onClick={pick(field)} className={cn(ring(field), "relative block overflow-hidden rounded-md border bg-muted")}>
                <img src={image.url} alt={plainText(textIn(image.alt, locale, true))} className="max-h-40 w-full object-cover" loading="lazy" />
              </button>
            );
          })}
        </div>
      ) : null}
      {blocks}
      {chips.length ? <div className="flex flex-wrap gap-1">{chips}</div> : null}
      {!media.length && !blocks.length && !chips.length ? <p className="text-xs text-muted-foreground italic">No content yet</p> : null}
    </div>
  );
};

const Empty = ({ label, onClick, className }: { label: string; onClick: (e: React.MouseEvent) => void; className?: string }) => (
  <button type="button" onClick={onClick} className={cn(className, "w-fit rounded border border-dashed border-destructive/40 px-2 py-0.5 text-[11px] text-destructive/80")}>
    {label} — required
  </button>
);

const Chip = ({ label, value, icon, onClick, className, danger }: { label: string; value: string; icon?: ReactNode; onClick: (e: React.MouseEvent) => void; className?: string; danger?: boolean }) => (
  <button type="button" onClick={onClick} className={cn(className, "flex max-w-full items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px]", danger && "border-destructive/40 text-destructive")}>
    {icon}
    <span className="text-muted-foreground">{label}:</span>
    <span className="truncate font-medium">{value}</span>
  </button>
);
