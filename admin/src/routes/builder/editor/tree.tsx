import { ArrowDown, ArrowUp, ChevronRight, CircleAlert, Clock, Copy, CornerLeftUp, Eye, EyeOff, MoreHorizontal, Plus, Settings2, Trash2 } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";
import { findSlot, nodeLabel, type FieldDefinition, type PageNode } from "../model";
import { ComponentIcon } from "./icons";
import { useEditor, useEditorState, type EditorState } from "./store";
import { docTitle, indexTree, MOD, nodeLimits } from "./util";

/**
 * Rows are memoized on their node, and tree operations keep unchanged subtrees, so an edit
 * re-renders only the rows on the path to the change.
 */

// ---------------------------------------------------------------- drag state (its own tiny store)

type DropTarget = { parentId: string; fieldKey: string; index: number };
type DragState = { dragging: string | null; drop: DropTarget | null };

const createDragStore = () => {
  let state: DragState = { dragging: null, drop: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<DragState>) => {
    const merged = { ...state, ...next };
    if (merged.dragging === state.dragging && sameDrop(merged.drop, state.drop)) return;
    state = merged;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    set,
    reset: () => set({ dragging: null, drop: null }),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
};
const sameDrop = (a: DropTarget | null, b: DropTarget | null) => (a === null || b === null ? a === b : a.parentId === b.parentId && a.fieldKey === b.fieldKey && a.index === b.index);

type DragStore = ReturnType<typeof createDragStore>;
const DragContext = createContext<DragStore | null>(null);
const useDragStore = () => useContext(DragContext)!;
const useDrag = <T,>(selector: (state: DragState) => T) => {
  const store = useDragStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
};

const hasIssue = (s: EditorState, nodeId: string) => s.issues.some((i) => i.path[0] === "node" && i.path[1] === nodeId) || s.saveIssues.some((i) => i.path[0] === "node" && i.path[1] === nodeId);

// ---------------------------------------------------------------- menu items, shared by the context menu and the ⋯ menu

type ItemProps = { onSelect?: (event: Event) => void; disabled?: boolean; className?: string; children: ReactNode };

const NodeMenu = ({ nodeId, Item, Separator }: { nodeId: string; Item: ComponentType<ItemProps>; Separator: ComponentType<{ className?: string }> }) => {
  const { actions, defs, store } = useEditor();
  const doc = store.get().doc;
  const entry = indexTree(doc.root, defs).get(nodeId);
  const slot = findSlot(doc.root, defs, nodeId);
  const limits = nodeLimits(doc.root, defs, nodeId);
  if (!entry || !slot || !limits) return null;
  const can = limits.abilities;
  const insert = (offset: number) => actions.openPicker({ parentId: slot.parent.id, fieldKey: slot.field.key, index: slot.index + offset });
  return (
    <>
      <Item onSelect={() => actions.select({ nodeId, path: [] }, { focus: true })}>
        <Settings2 /> Edit fields
      </Item>
      <Item disabled={!can.selectParent} onSelect={() => actions.selectParent(nodeId)}>
        <CornerLeftUp /> Select parent
      </Item>
      <Item disabled={!can.duplicate} onSelect={() => actions.duplicate(nodeId)}>
        <Copy /> Duplicate <Shortcut>{MOD}D</Shortcut>
      </Item>
      <Item onSelect={() => actions.toggleHidden(nodeId)}>
        {entry.node.hidden ? <Eye /> : <EyeOff />} {entry.node.hidden ? "Show" : "Hide"}
      </Item>
      <Separator />
      <Item disabled={!can.moveUp} onSelect={() => actions.move(nodeId, -1)}>
        <ArrowUp /> Move up <Shortcut>{MOD}↑</Shortcut>
      </Item>
      <Item disabled={!can.moveDown} onSelect={() => actions.move(nodeId, 1)}>
        <ArrowDown /> Move down <Shortcut>{MOD}↓</Shortcut>
      </Item>
      <Item disabled={!can.insertBefore} onSelect={() => insert(0)}>
        <Plus /> Insert above…
      </Item>
      <Item disabled={!can.insertAfter} onSelect={() => insert(1)}>
        <Plus /> Insert below…
      </Item>
      <Separator />
      <Item disabled={!can.remove} className="text-destructive focus:text-destructive [&_svg]:!text-destructive" onSelect={() => actions.remove(nodeId)}>
        <Trash2 /> {can.remove ? "Delete" : `Delete (needs ${limits.min})`} <Shortcut>⌫</Shortcut>
      </Item>
    </>
  );
};

const Shortcut = ({ children }: { children: ReactNode }) => <span className="ml-auto pl-4 font-mono text-[11px] tracking-wide text-muted-foreground">{children}</span>;

const contextItemClass =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
const ContextItem = ({ className, ...props }: ItemProps) => <ContextMenuPrimitive.Item className={cn(contextItemClass, className)} {...props} />;
const ContextSeparator = () => <ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
const DropdownItem = ({ className, ...props }: ItemProps) => <DropdownMenuItem className={className} {...props} />;

// ---------------------------------------------------------------- tree

export const StructureTree = () => {
  const { actions, contentType, defs } = useEditor();
  const root = useEditorState((s) => s.doc.root);
  const drag = useMemo(createDragStore, []);
  const [menuNode, setMenuNode] = useState<string | null>(null);
  const slots = contentType.fields.filter((f) => f.type === "blocks");
  const container = useRef<HTMLDivElement>(null);
  const count = useMemo(() => indexTree(root, defs).size - 1, [root, defs]);

  /** ↑/↓ walk the visible rows, ←/→ fold and unfold. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = [...(container.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? [])];
    const current = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
    if (current < 0) return;
    event.preventDefault();
    const row = rows[current]!;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const expanded = row.getAttribute("aria-expanded");
      if ((event.key === "ArrowLeft" && expanded === "true") || (event.key === "ArrowRight" && expanded === "false")) row.querySelector<HTMLElement>("[data-chevron]")?.click();
      return;
    }
    const next = rows[current + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    next.focus();
    const id = next.getAttribute("data-tree-node");
    actions.select(id ? { nodeId: id, path: [] } : null);
  };

  return (
    <DragContext.Provider value={drag}>
      <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Structure</h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">{count === 1 ? "1 component" : `${count} components`}</span>
      </div>
      <ContextMenuPrimitive.Root modal={false}>
        <ContextMenuPrimitive.Trigger asChild>
          <div
            ref={container}
            role="tree"
            aria-label="Page structure"
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-6"
            onKeyDown={onKeyDown}
            onContextMenu={(event) => {
              const id = (event.target as HTMLElement).closest("[data-tree-node]")?.getAttribute("data-tree-node");
              if (!id) {
                event.preventDefault();
                return;
              }
              setMenuNode(id);
              actions.select({ nodeId: id, path: [] });
            }}
            onDragEnd={() => drag.reset()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) drag.set({ drop: null });
            }}
          >
            <RootRow />
            {slots.length ? (
              slots.map((field) => <TreeSlot key={field.key} parent={root} field={field} depth={0} top />)
            ) : (
              <p className="mx-2 mt-3 rounded-lg border border-dashed px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground">
                {contentType.name} keeps its content in fields rather than components. Edit them in the panel on the right, or click them in the preview.
              </p>
            )}
          </div>
        </ContextMenuPrimitive.Trigger>
        <ContextMenuPrimitive.Portal>
          <ContextMenuPrimitive.Content className="z-50 min-w-52 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
            {menuNode ? <NodeMenu nodeId={menuNode} Item={ContextItem} Separator={ContextSeparator} /> : null}
          </ContextMenuPrimitive.Content>
        </ContextMenuPrimitive.Portal>
      </ContextMenuPrimitive.Root>
    </DragContext.Provider>
  );
};

const RootRow = () => {
  const { actions, contentType } = useEditor();
  const title = useEditorState((s) => docTitle(s.doc, s.locale));
  const selected = useEditorState((s) => !s.selection || s.selection.nodeId === s.doc.root.id);
  const issues = useEditorState((s) => [...s.issues, ...s.saveIssues].some((i) => i.path[0] !== "node" || i.path[1] === s.doc.root.id));
  return (
    <div
      data-tree-row
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => actions.select(null)}
      onKeyDown={(e) => e.key === "Enter" && actions.select(null)}
      className={cn("group flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50", selected ? "bg-primary/10" : "hover:bg-accent/60")}
    >
      <span className="flex size-6 items-center justify-center rounded-md bg-primary/12 text-primary">
        <ComponentIcon name={contentType.icon} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{title || "Untitled"}</span>
      {issues ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : null}
      <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{contentType.name}</span>
    </div>
  );
};

const TreeSlot = memo(({ parent, field, depth, top }: { parent: PageNode; field: FieldDefinition; depth: number; top?: boolean }) => {
  const { actions } = useEditor();
  const drag = useDragStore();
  const children = useMemo(() => (Array.isArray(parent.fields[field.key]) ? (parent.fields[field.key] as PageNode[]) : []), [parent.fields, field.key]);
  const full = field.max != null && children.length >= field.max;
  const dropHere = useDrag((s) => (s.drop && s.drop.parentId === parent.id && s.drop.fieldKey === field.key ? s.drop.index : null));
  const indent = { paddingLeft: 8 + depth * 14 };

  const over = (index: number) => (event: React.DragEvent) => {
    const dragging = drag.get().dragging;
    if (!dragging) return;
    event.stopPropagation();
    if (actions.canMove(dragging, parent.id, field.key)) {
      event.dataTransfer.dropEffect = "none";
      drag.set({ drop: null });
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    drag.set({ drop: { parentId: parent.id, fieldKey: field.key, index } });
  };
  const drop = (event: React.DragEvent) => {
    const { dragging, drop: target } = drag.get();
    if (!dragging || !target) return;
    event.preventDefault();
    event.stopPropagation();
    actions.relocate(dragging, target.parentId, target.fieldKey, target.index);
    drag.reset();
  };
  const add = () => actions.openPicker({ parentId: parent.id, fieldKey: field.key });

  return (
    <div role="group" aria-label={field.label}>
      <div onDragOver={over(0)} onDrop={drop} className={cn("group/slot flex items-center gap-1.5 pr-1", top ? "mt-3 mb-0.5 h-7" : "h-6")} style={indent}>
        <span className={cn("truncate font-semibold tracking-wide text-muted-foreground uppercase", top ? "text-[11px]" : "text-[10px]")}>{field.label}</span>
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">{field.max != null ? `${children.length}/${field.max}` : children.length || ""}</span>
        <Tooltip content={full ? `${field.label} allows at most ${field.max}` : `Add to ${field.label.toLowerCase()}`}>
          <button
            type="button"
            onClick={add}
            disabled={full}
            aria-label={`Add to ${field.label}`}
            className={cn("ml-auto flex size-6 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground disabled:opacity-30", !top && "opacity-0 group-hover/slot:opacity-100 focus-visible:opacity-100")}
          >
            <Plus className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      {children.map((child, i) => (
        <TreeNode key={child.id} node={child} parentId={parent.id} fieldKey={field.key} index={i} depth={depth} dropLine={dropHere === i ? "top" : dropHere === children.length && i === children.length - 1 ? "bottom" : null} />
      ))}
      {children.length === 0 ? (
        <button
          type="button"
          onClick={add}
          onDragOver={over(0)}
          onDrop={drop}
          className={cn("my-0.5 flex w-[calc(100%-4px)] items-center gap-1.5 rounded-md border border-dashed py-1.5 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground", dropHere === 0 && "border-primary bg-primary/5")}
          style={{ marginLeft: 8 + depth * 14, width: `calc(100% - ${12 + depth * 14}px)`, paddingLeft: 8 }}
        >
          <Plus className="size-3.5" /> {field.min ? `Add at least ${field.min}` : "Empty — add a component"}
        </button>
      ) : top && !full ? (
        <button
          type="button"
          onClick={add}
          onDragOver={over(children.length)}
          onDrop={drop}
          className="mt-1 flex h-8 w-full items-center gap-1.5 rounded-md border border-dashed px-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
        >
          <Plus className="size-3.5" /> Add {field.label.replace(/s$/, "").toLowerCase()}
        </button>
      ) : null}
    </div>
  );
});

const TreeNode = memo(({ node, parentId, fieldKey, index, depth, dropLine }: { node: PageNode; parentId: string; fieldKey: string; index: number; depth: number; dropLine: "top" | "bottom" | null }) => {
  const { actions, defs, store } = useEditor();
  const drag = useDragStore();
  const def = defs.get(node.component);
  const locale = useEditorState((s) => s.locale);
  const selected = useEditorState((s) => s.selection?.nodeId === node.id);
  const hovered = useEditorState((s) => s.hoveredNodeId === node.id);
  const error = useEditorState((s) => hasIssue(s, node.id));
  const containsSelection = useEditorState((s) => (s.selection ? !!indexTree(s.doc.root, defs).get(s.selection.nodeId)?.trail.includes(node.id) : false));
  const descendantError = useEditorState((s) => [...s.issues, ...s.saveIssues].some((i) => i.path[0] === "node" && i.path[1] !== node.id && !!indexTree(s.doc.root, defs).get(i.path[1] ?? "")?.trail.includes(node.id)));
  const dragging = useDrag((s) => s.dragging === node.id);
  const slots = useMemo(() => (def?.fields ?? []).filter((f) => f.type === "blocks"), [def]);
  const [open, setOpen] = useState(depth < 1 || slots.length === 0);
  const row = useRef<HTMLDivElement>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (containsSelection) setOpen(true);
  }, [containsSelection]);
  useEffect(() => {
    if (!selected) return;
    row.current?.scrollIntoView({ block: "nearest" });
    // Keyboard focus follows selection made in the tree, not clicks in the preview.
    if (store.get().selectionSource === "editor" && row.current?.closest("[role=tree]")?.contains(document.activeElement)) row.current.focus({ preventScroll: true });
  }, [selected, store]);

  const label = nodeLabel(node, defs, locale);
  const visibility = node.visibility && (node.visibility.channelIds?.length || node.visibility.locales?.length || node.visibility.from || node.visibility.until);

  const onDragOver = (event: React.DragEvent) => {
    const source = drag.get().dragging;
    if (!source) return;
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const target = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
    if (actions.canMove(source, parentId, fieldKey)) {
      event.dataTransfer.dropEffect = "none";
      drag.set({ drop: null });
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    drag.set({ drop: { parentId, fieldKey, index: target } });
  };

  return (
    <div role="none">
      <div
        ref={row}
        data-tree-row
        data-tree-node={node.id}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={slots.length ? open : undefined}
        aria-level={depth + 1}
        tabIndex={selected ? 0 : -1}
        draggable
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-ecom-node", node.id);
          drag.set({ dragging: node.id, drop: null });
        }}
        onDragEnd={() => drag.reset()}
        onDragOver={onDragOver}
        onDragEnter={() => {
          if (slots.length && !open && drag.get().dragging && drag.get().dragging !== node.id) expandTimer.current = setTimeout(() => setOpen(true), 600);
        }}
        onDragLeave={() => {
          if (expandTimer.current) clearTimeout(expandTimer.current);
        }}
        onDrop={(event) => {
          const { dragging: source, drop } = drag.get();
          if (!source || !drop) return;
          event.preventDefault();
          event.stopPropagation();
          actions.relocate(source, drop.parentId, drop.fieldKey, drop.index);
          drag.reset();
        }}
        onClick={() => actions.select({ nodeId: node.id, path: [] })}
        onDoubleClick={() => actions.select({ nodeId: node.id, path: [] }, { focus: true })}
        onMouseEnter={() => actions.hover(node.id)}
        onMouseLeave={() => actions.hover(null)}
        className={cn(
          "group relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-[13px] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50",
          selected ? "bg-primary/10 text-foreground" : hovered ? "bg-accent/70" : "hover:bg-accent/50",
          node.hidden && "text-muted-foreground",
          dragging && "opacity-40",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {dropLine ? <span className={cn("pointer-events-none absolute right-1 left-2 z-10 h-0.5 rounded-full bg-primary", dropLine === "top" ? "-top-px" : "-bottom-px")} style={{ left: 4 + depth * 14 }} /> : null}
        <button
          type="button"
          data-chevron
          tabIndex={-1}
          aria-label={open ? "Collapse" : "Expand"}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
          className={cn("flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground", !slots.length && "invisible")}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <ComponentIcon name={def?.icon} className={cn("size-3.5", selected ? "text-primary" : "text-muted-foreground", node.hidden && "opacity-50")} />
        <span className={cn("min-w-0 truncate", node.hidden && "line-through decoration-muted-foreground/40")}>{label}</span>
        {def && label !== def.name ? <span className="min-w-0 shrink-[2] truncate text-[11px] text-muted-foreground">{def.name}</span> : null}
        {!def ? <span className="truncate text-[11px] text-destructive">unknown component</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
          {visibility ? (
            <Tooltip content="Shown only for some channels, languages or dates">
              <Clock className="size-3.5 text-warning" />
            </Tooltip>
          ) : null}
          {node.hidden ? (
            <Tooltip content="Hidden on the storefront">
              <EyeOff className="size-3.5" />
            </Tooltip>
          ) : null}
          {error || (!open && descendantError) ? (
            <Tooltip content={error ? "Needs attention before publishing" : "Something inside needs attention"}>
              <CircleAlert className="size-3.5 text-destructive" />
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                aria-label="More actions"
                onClick={(event) => event.stopPropagation()}
                className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background hover:text-foreground data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52" onClick={(event) => event.stopPropagation()}>
              <NodeMenu nodeId={node.id} Item={DropdownItem} Separator={DropdownMenuSeparator} />
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {open && slots.length ? (
        <div role="group">
          {slots.map((field) => (
            <TreeSlot key={field.key} parent={node} field={field} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
