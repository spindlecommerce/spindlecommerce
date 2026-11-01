import { createContext, useContext, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ApiError, request } from "@/lib/api";
import {
  allowedIn,
  createNode,
  textIn,
  withText,
  duplicateNode,
  findSlot,
  fitsPage,
  insertNode,
  moveNode,
  nodeLabel,
  pageKindOf,
  relocateNode,
  removeNode,
  setField,
  TEMPLATE_KINDS,
  updateNode,
  type ComponentDef,
  type Definitions,
  type FieldDefinition,
  type ListItem,
  type PageDocument,
  type PageNode,
  type Selection,
} from "../model";
import { PageSaveDraftMutation, type Frontend, type PageMetaShape, type PageStatusShape } from "./api";
import { indexTree, isObject, nodeLimits, normalizeIssues, type Issue } from "./util";

/** An external store: edits re-render only the panels whose slice changed, never the preview. */

export type Device = "desktop" | "tablet" | "mobile";
export type Mode = "edit" | "browse";
export type PreviewKind = "live" | "structure";
export type SelectionSource = "editor" | "bridge";

export const DEVICES: Record<Device, { label: string; width: number | null }> = {
  desktop: { label: "Desktop", width: null },
  tablet: { label: "Tablet", width: 820 },
  mobile: { label: "Mobile", width: 390 },
};

/** Where the picker inserts; no index means at the end. */
export type PickerTarget = { parentId: string; fieldKey: string; index?: number };

type HistoryEntry = { doc: PageDocument; selection: Selection | null };

export type PageMeta = PageMetaShape;

export type EditorState = {
  doc: PageDocument;
  /** The last document the API accepted; `doc !== savedDoc` means unsaved changes. */
  savedDoc: PageDocument;
  /** The page version the next save is based on. */
  version: number;
  past: HistoryEntry[];
  future: HistoryEntry[];
  coalesce: { key: string; at: number } | null;
  selection: Selection | null;
  selectionSource: SelectionSource;
  /** Bumped to scroll the inspector to the selected field; focusMode "focus" also focuses it. */
  focusRequest: number;
  focusMode: "focus" | "reveal";
  hoveredNodeId: string | null;
  locale: string;
  /** The channel the live preview shows. */
  channelId: string;
  /** Templates: the product or category (global id) to preview with; null lets the API pick. */
  previewWith: string | null;
  device: Device;
  mode: Mode;
  previewKind: PreviewKind;
  saving: boolean;
  saveError: string | null;
  conflict: string | null;
  /** Problems from publishing or scheduling (cleared field by field as they are edited). */
  issues: Issue[];
  /** Problems the last draft save reported. */
  saveIssues: Issue[];
  meta: PageMeta;
  picker: PickerTarget | null;
};

export type Store = {
  get: () => EditorState;
  set: (update: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  subscribe: (listener: () => void) => () => void;
};

export const createStore = (initial: EditorState): Store => {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update) => {
      const patch = typeof update === "function" ? update(state) : update;
      let changed = false;
      for (const key of Object.keys(patch) as (keyof EditorState)[]) {
        if (!Object.is(patch[key], state[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** What the store tells the live preview; set by the preview while a storefront is connected. */
export type BridgeHandle = {
  /** The selection, or what can be done to it, changed. */
  select: (selection: Selection | null) => void;
  hover: (nodeId: string | null) => void;
  patch: (nodeId: string, path: string[], value: unknown) => void;
  refresh: () => void;
};

const HISTORY_LIMIT = 100;
const COALESCE_MS = 1200;
const AUTOSAVE_MS = 800;
const RETRY_MS = 5000;

const sameSelection = (a: Selection | null, b: Selection | null) => (a === null || b === null ? a === b : a.nodeId === b.nodeId && a.path.join(".") === b.path.join("."));

const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((p, i) => path[i] === p);

export type FocusOption = boolean | "reveal";
const focusPatch = (state: EditorState, focus: FocusOption | undefined): Partial<EditorState> =>
  focus ? { focusRequest: state.focusRequest + 1, focusMode: focus === "reveal" ? "reveal" : "focus" } : {};

export type Actions = ReturnType<typeof createActions>;

/** Document changes, with undo history (typing coalesced), autosave and preview updates. */
export const createActions = (
  store: Store,
  env: { pageId: string; defs: () => Definitions; components: () => readonly ComponentDef[]; bridge: { current: BridgeHandle | null }; canWrite: () => boolean; onSaved?: () => void },
) => {
  const defs = () => env.defs();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<boolean> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const scheduleSave = (delay = AUTOSAVE_MS) => {
    clearTimer();
    timer = setTimeout(() => void flush(), delay);
  };

  const saveOnce = async (): Promise<boolean> => {
    const state = store.get();
    const doc = state.doc;
    store.set({ saving: true });
    try {
      const result = (await request(PageSaveDraftMutation, { id: env.pageId, baseVersion: state.version, document: doc })).pageSaveDraft;
      if (result?.__typename === "PagePayload" && result.page) {
        const page: PageStatusShape = result.page;
        store.set((s) => ({ savedDoc: doc, version: page.version ?? s.version + 1, meta: { ...s.meta, ...page }, saving: false, saveError: null, saveIssues: [] }));
        env.bridge.current?.refresh();
        env.onSaved?.();
        return true;
      }
      if (result?.__typename === "ConflictError") {
        store.set({ saving: false, conflict: result.message ?? "Someone else changed this page" });
        return false;
      }
      const fieldErrors = result && "fieldErrors" in result ? (result.fieldErrors ?? []) : [];
      store.set({ saving: false, saveError: (result && "message" in result ? result.message : null) ?? "The draft could not be saved", saveIssues: normalizeIssues(fieldErrors) });
      return false;
    } catch (error) {
      store.set({ saving: false, saveError: error instanceof Error ? error.message : "The draft could not be saved" });
      // Network trouble or a server error: try again shortly while there is something to save.
      if (!(error instanceof ApiError && ["PERMISSION_DENIED", "UNAUTHENTICATED"].includes(error.code))) scheduleSave(RETRY_MS);
      return false;
    }
  };

  /** Save now; resolves once everything so far is saved, or a save fails. One loop at a time. */
  const flush = (): Promise<boolean> => {
    clearTimer();
    if (running) return running;
    const loop = (async () => {
      for (let round = 0; round < 25; round++) {
        const state = store.get();
        if (state.conflict) return false;
        if (state.doc === state.savedDoc) return true;
        if (!(await saveOnce())) return false;
      }
      return store.get().doc === store.get().savedDoc;
    })();
    // Cleared after the assignment: a loop with nothing to save finishes synchronously, and a
    // `finally` inside it would run before `running` is set, leaving a settled promise behind.
    running = loop;
    void loop.then(() => {
      if (running === loop) running = null;
    });
    return loop;
  };

  const validSelection = (doc: PageDocument, ...candidates: (Selection | null)[]) => {
    const index = indexTree(doc.root, defs());
    return candidates.find((c) => c && index.has(c.nodeId)) ?? null;
  };

  type ChangeOptions = { coalesce?: string; select?: Selection | null; focus?: FocusOption; clearIssues?: string[] };

  let warned = false;
  const change = (update: (doc: PageDocument) => PageDocument, options: ChangeOptions = {}) => {
    if (!env.canWrite()) {
      if (!warned) toast.error("Your role cannot edit pages", { description: "It needs the content:write permission." });
      warned = true;
      return false;
    }
    const state = store.get();
    const next = update(state.doc);
    if (next === state.doc) return false;
    const now = Date.now();
    const coalesced = !!options.coalesce && state.coalesce?.key === options.coalesce && now - state.coalesce.at < COALESCE_MS;
    const past = coalesced ? state.past : [...state.past, { doc: state.doc, selection: state.selection }].slice(-HISTORY_LIMIT);
    const clear = options.clearIssues;
    store.set({
      doc: next,
      past,
      future: [],
      coalesce: options.coalesce ? { key: options.coalesce, at: now } : null,
      saveError: null,
      ...(clear ? { issues: state.issues.filter((i) => !startsWith(i.path, clear)), saveIssues: state.saveIssues.filter((i) => !startsWith(i.path, clear)) } : {}),
      ...(options.select !== undefined ? { selection: options.select, selectionSource: "editor" as const, ...focusPatch(state, options.focus) } : {}),
    });
    if (options.select !== undefined) env.bridge.current?.select(options.select);
    scheduleSave();
    return true;
  };

  const defOf = (code: string) => env.components().find((c) => c.code === code) ?? null;

  /** A field's value with one locale's text replaced; a plain string when not localized. */
  const textValue = (field: FieldDefinition, current: unknown, locale: string, text: string) => {
    if (!field.localized) return text === "" ? undefined : text;
    const next = withText(current, locale, text);
    return Object.keys(next).length ? next : undefined;
  };
  const nameOf = (node: PageNode) => defOf(node.component)?.name ?? node.component;

  /** Why a component can't go into a blocks field, or null when it can. */
  const roomIn = (doc: PageDocument, parentId: string, fieldKey: string, component: string, moving?: string): string | null => {
    const parent = indexTree(doc.root, defs()).get(parentId)?.node;
    const field = parent ? defOf(parent.component)?.fields.find((f) => f.key === fieldKey) : undefined;
    if (!parent || !field || field.type !== "blocks") return "That place does not take components";
    const def = defOf(component);
    // Product and category components fit only their kind's templates and sections, at any depth.
    const pageKind = pageKindOf(defOf(doc.root.component));
    if (def?.templateFor && !fitsPage(def, pageKind)) {
      const names = TEMPLATE_KINDS[def.templateFor];
      return `${def.name} shows ${names.one} data, so it only fits ${names.template.toLowerCase()}s and ${names.sections.toLowerCase()}`;
    }
    if (!def || !allowedIn(field, [def], pageKind).length) return `${def?.name ?? component} is not allowed in ${field.label}`;
    const children = Array.isArray(parent.fields[fieldKey]) ? (parent.fields[fieldKey] as PageNode[]) : [];
    const count = children.filter((c) => c.id !== moving).length;
    if (field.max != null && count >= field.max) return `${field.label} allows at most ${field.max}`;
    return null;
  };

  const actions = {
    flush,
    scheduleSave,
    isSaving: () => !!running,
    /** Stop the pending autosave and wait for one in flight, before replacing the draft. */
    settle: async () => {
      clearTimer();
      if (running) await running.catch(() => false);
      clearTimer();
    },

    // ---------------------------------------------------------------- selection

    /** `focus` scrolls the inspector to the selection and focuses it; "reveal" only scrolls. */
    select: (selection: Selection | null, options: { source?: SelectionSource; focus?: FocusOption } = {}) => {
      const state = store.get();
      const source = options.source ?? "editor";
      if (sameSelection(selection, state.selection) && !options.focus) return;
      store.set({ selection, selectionSource: source, ...focusPatch(state, options.focus) });
      env.bridge.current?.select(selection);
    },
    /** The component around a node (the page settings for top-level ones). */
    selectParent: (nodeId: string) => {
      const entry = indexTree(store.get().doc.root, defs()).get(nodeId);
      if (!entry) return;
      actions.select(entry.parentId && entry.parentId !== store.get().doc.root.id ? { nodeId: entry.parentId, path: [] } : null);
    },
    hover: (nodeId: string | null, options: { fromPreview?: boolean } = {}) => {
      if (store.get().hoveredNodeId === nodeId) return;
      store.set({ hoveredNodeId: nodeId });
      if (!options.fromPreview) env.bridge.current?.hover(nodeId);
    },

    // ---------------------------------------------------------------- fields

    /** `patch` also updates the preview's text instantly. */
    setField: (nodeId: string, key: string, value: unknown | ((current: unknown) => unknown), options: { patch?: { path: string[]; value: unknown }; history?: "coalesce" | "step" } = {}) => {
      change(
        (doc) => {
          const node = indexTree(doc.root, defs()).get(nodeId)?.node;
          if (!node) return doc;
          const next = typeof value === "function" ? (value as (current: unknown) => unknown)(node.fields[key]) : value;
          if (Object.is(next, node.fields[key])) return doc;
          return { ...doc, root: setField(doc.root, defs(), nodeId, key, next) };
        },
        { coalesce: options.history === "step" ? undefined : `field:${nodeId}:${key}`, clearIssues: ["node", nodeId, key] },
      );
      if (options.patch) env.bridge.current?.patch(nodeId, options.patch.path, options.patch.value);
    },
    /** Show typed text in the preview right away, before the draft is saved. */
    patchPreview: (nodeId: string, path: string[], value: unknown) => env.bridge.current?.patch(nodeId, path, value),
    /**
     * Text typed in the preview itself, in the editing locale. `path` is [field] or [field, itemId,
     * subField]; one undo step per pause, like typing in a field.
     */
    setText: (nodeId: string, path: readonly string[], text: string) => {
      const state = store.get();
      const node = indexTree(state.doc.root, defs()).get(nodeId)?.node;
      const field = node ? defOf(node.component)?.fields.find((f) => f.key === path[0]) : undefined;
      if (!node || !field) return false;
      const isText = (f: FieldDefinition) => f.type === "text" || f.type === "richText";
      if (path.length === 1 && isText(field)) {
        const current = node.fields[field.key];
        if ((field.localized ? textIn(current, state.locale) : typeof current === "string" ? current : "") === text) return true;
        actions.setField(nodeId, field.key, (value: unknown) => textValue(field, value, state.locale, text));
        return true;
      }
      const sub = field.type === "list" && path.length === 3 ? field.fields?.find((f) => f.key === path[2]) : undefined;
      if (!sub || !isText(sub)) return false;
      const items = Array.isArray(node.fields[field.key]) ? (node.fields[field.key] as ListItem[]) : [];
      const item = items.find((it) => isObject(it) && it.id === path[1]);
      if (!item) return false;
      if ((sub.localized ? textIn(item.fields[sub.key], state.locale) : typeof item.fields[sub.key] === "string" ? item.fields[sub.key] : "") === text) return true;
      actions.setField(nodeId, field.key, (value: unknown) =>
        (Array.isArray(value) ? (value as ListItem[]) : []).map((it) => {
          if (it.id !== path[1]) return it;
          const fields = { ...it.fields, [sub.key]: textValue(sub, it.fields[sub.key], state.locale, text) };
          if (fields[sub.key] === undefined) delete fields[sub.key];
          return { ...it, fields };
        }),
      );
      return true;
    },
    setNode: (nodeId: string, patch: Partial<Pick<PageNode, "variation" | "hidden" | "visibility">>, coalesce?: string) =>
      change(
        (doc) => ({
          ...doc,
          root: updateNode(doc.root, defs(), nodeId, (node) => {
            const next: PageNode = { ...node, ...patch };
            for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete next[key];
            return next;
          }),
        }),
        { coalesce: coalesce ? `node:${nodeId}:${coalesce}` : undefined, clearIssues: ["node", nodeId, ...(patch.variation !== undefined ? ["variation"] : [])] },
      ),
    /** Title, path or SEO. */
    setPage: (update: (doc: PageDocument) => PageDocument, key: string, clearIssues?: string[]) => change(update, { coalesce: `page:${key}`, clearIssues: clearIssues ?? [key] }),

    // ---------------------------------------------------------------- structure

    insert: (target: PickerTarget, def: ComponentDef) => {
      const doc = store.get().doc;
      const problem = roomIn(doc, target.parentId, target.fieldKey, def.code);
      if (problem) {
        toast.error(problem);
        return null;
      }
      const node = createNode(def);
      change((d) => ({ ...d, root: insertNode(d.root, defs(), target.parentId, target.fieldKey, node, target.index) }), { select: { nodeId: node.id, path: [] }, focus: true });
      return node.id;
    },
    remove: (nodeId: string) => {
      const state = store.get();
      const slot = findSlot(state.doc.root, defs(), nodeId);
      if (!slot) return;
      const limits = nodeLimits(state.doc.root, defs(), nodeId);
      if (limits && !limits.abilities.remove) {
        toast.error(`${slot.field.label} needs at least ${limits.min}`, { description: "Add another first, or change this one." });
        return;
      }
      const removed = slot.siblings[slot.index]!;
      const neighbour = slot.siblings[slot.index + 1] ?? slot.siblings[slot.index - 1];
      const selected = state.selection && indexTree(state.doc.root, defs()).get(state.selection.nodeId);
      const losesSelection = !!selected && (selected.node.id === nodeId || selected.trail.includes(nodeId));
      change((doc) => ({ ...doc, root: removeNode(doc.root, defs(), nodeId) }), losesSelection ? { select: neighbour ? { nodeId: neighbour.id, path: [] } : slot.parent.id === state.doc.root.id ? null : { nodeId: slot.parent.id, path: [] } } : {});
      toast(`Removed ${nodeLabel(removed, defs(), state.locale)}`, { action: { label: "Undo", onClick: () => actions.undo() } });
    },
    duplicate: (nodeId: string) => {
      const state = store.get();
      const slot = findSlot(state.doc.root, defs(), nodeId);
      if (!slot) return;
      const problem = roomIn(state.doc, slot.parent.id, slot.field.key, slot.siblings[slot.index]!.component);
      if (problem) {
        toast.error(problem);
        return;
      }
      const { root, copyId } = duplicateNode(state.doc.root, defs(), nodeId);
      if (!copyId) return;
      change((doc) => ({ ...doc, root }), { select: { nodeId: copyId, path: [] } });
    },
    move: (nodeId: string, delta: number) => {
      const slot = findSlot(store.get().doc.root, defs(), nodeId);
      if (!slot) return;
      change((doc) => ({ ...doc, root: moveNode(doc.root, defs(), nodeId, { delta }) }));
    },
    /** Drag and drop; `index` is in the field as it was before the move. */
    relocate: (nodeId: string, parentId: string, fieldKey: string, index: number) => {
      const state = store.get();
      const node = indexTree(state.doc.root, defs()).get(nodeId)?.node;
      if (!node) return;
      const problem = roomIn(state.doc, parentId, fieldKey, node.component, nodeId);
      if (problem) {
        toast.error(problem);
        return;
      }
      change((doc) => ({ ...doc, root: relocateNode(doc.root, defs(), nodeId, parentId, fieldKey, index) }));
    },
    toggleHidden: (nodeId: string) => {
      const node = indexTree(store.get().doc.root, defs()).get(nodeId)?.node;
      if (!node || nodeId === store.get().doc.root.id) return;
      actions.setNode(nodeId, { hidden: node.hidden ? undefined : true });
      toast(node.hidden ? `${nameOf(node)} is shown again` : `${nameOf(node)} is hidden on the storefront`);
    },
    canInsert: (target: PickerTarget, code: string) => roomIn(store.get().doc, target.parentId, target.fieldKey, code),
    canMove: (nodeId: string, parentId: string, fieldKey: string) => {
      const index = indexTree(store.get().doc.root, defs());
      const node = index.get(nodeId)?.node;
      const parent = index.get(parentId);
      if (!node || !parent) return "Not found";
      if (parentId === nodeId || parent.trail.includes(nodeId)) return "A component cannot go inside itself";
      return roomIn(store.get().doc, parentId, fieldKey, node.component, nodeId);
    },

    // ---------------------------------------------------------------- history

    undo: () => {
      const state = store.get();
      const entry = state.past.at(-1);
      if (!entry) return;
      store.set({
        doc: entry.doc,
        past: state.past.slice(0, -1),
        future: [...state.future, { doc: state.doc, selection: state.selection }],
        coalesce: null,
        selection: validSelection(entry.doc, state.selection, entry.selection),
        selectionSource: "editor",
      });
      env.bridge.current?.select(store.get().selection);
      scheduleSave();
    },
    redo: () => {
      const state = store.get();
      const entry = state.future.at(-1);
      if (!entry) return;
      store.set({
        doc: entry.doc,
        future: state.future.slice(0, -1),
        past: [...state.past, { doc: state.doc, selection: state.selection }].slice(-HISTORY_LIMIT),
        coalesce: null,
        selection: validSelection(entry.doc, state.selection, entry.selection),
        selectionSource: "editor",
      });
      env.bridge.current?.select(store.get().selection);
      scheduleSave();
    },

    // ---------------------------------------------------------------- server state

    /** After a discard, restore or reload: load the server's draft and clear the history. */
    replaceDocument: (doc: PageDocument, version: number, meta?: Partial<PageMeta>) => {
      clearTimer();
      const state = store.get();
      store.set({
        doc,
        savedDoc: doc,
        version,
        past: [],
        future: [],
        coalesce: null,
        conflict: null,
        saveError: null,
        issues: [],
        saveIssues: [],
        selection: validSelection(doc, state.selection),
        meta: meta ? { ...state.meta, ...meta } : state.meta,
      });
      env.bridge.current?.refresh();
    },
    setMeta: (meta: Partial<PageMeta>) => store.set((s) => ({ meta: { ...s.meta, ...meta } })),
    setIssues: (issues: Issue[]) => store.set({ issues }),
    openPicker: (target: PickerTarget) => store.set({ picker: target }),
    closePicker: () => store.set({ picker: null }),
    dispose: () => clearTimer(),
  };
  return actions;
};

// ---------------------------------------------------------------- React bindings

export type EditorContextValue = {
  store: Store;
  actions: Actions;
  pageId: string;
  defs: ReadonlyMap<string, ComponentDef>;
  components: readonly ComponentDef[];
  contentType: ComponentDef;
  locales: readonly string[];
  defaultLocale: string;
  channels: readonly { id: string; name?: string | null; code?: string | null; locales?: readonly string[] | null }[];
  /** The storefront previews run in; null when none is set up. */
  frontend: Frontend | null;
  /** Set by the live preview while it is mounted. */
  bridge: { current: BridgeHandle | null };
};

export const EditorContext = createContext<EditorContextValue | null>(null);

export const useEditor = () => {
  const context = useContext(EditorContext);
  if (!context) throw new Error("useEditor outside the page editor");
  return context;
};

/** The selector must return primitives or existing references. */
export const useEditorState = <T,>(selector: (state: EditorState) => T): T => {
  const { store } = useEditor();
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
};

export const isDirty = (state: EditorState) => state.doc !== state.savedDoc;
