/** Client copy of the page model in src/modules/builder/model.ts, plus immutable tree operations. */

export const FIELD_TYPES = ["text", "richText", "number", "boolean", "select", "color", "image", "link", "date", "product", "products", "category", "blocks", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type ComponentKind = "CONTENT_TYPE" | "COMPONENT";
/** What a template renders. Templates have no path; product or category pages render with them. */
export type TemplateFor = "PRODUCT" | "CATEGORY";

export type LocalizedText = Record<string, string>;
export type FieldOption = { value: string; label: string };
export type FieldDefinition = {
  key: string;
  type: FieldType;
  label: string;
  description?: string;
  required?: boolean;
  /** Text and rich text only: one value per locale. */
  localized?: boolean;
  /** Inspector tab, e.g. "Content", "Style". Absent means "Content". */
  group?: string;
  /** Only shown for these variations. */
  variations?: string[];
  placeholder?: string;
  multiline?: boolean;
  options?: FieldOption[];
  min?: number;
  max?: number;
  /** blocks only: allowed component codes; empty or absent allows every component. */
  allowedComponents?: string[];
  /** list only: item fields (no blocks or lists inside). */
  fields?: FieldDefinition[];
  defaultValue?: unknown;
};
export type Variation = { code: string; name: string; description?: string; previewImageUrl?: string };

/** The admin API's Component, with fields and variations parsed. */
export type ComponentDef = {
  id: string;
  code: string;
  kind: ComponentKind;
  name: string;
  description?: string | null;
  groupName?: string | null;
  icon?: string | null;
  previewImageUrl?: string | null;
  fields: FieldDefinition[];
  variations: Variation[];
  routable: boolean;
  singleton: boolean;
  /** Content types: their pages are templates of this kind. Components: they show this kind's data. */
  templateFor: TemplateFor | null;
  /** Content types: each page holds one product's or category's own sections. */
  sectionsFor: TemplateFor | null;
};

/** Admin labels for each template kind. */
export const TEMPLATE_KINDS: Record<TemplateFor, { template: string; data: string; sections: string; pages: string; one: string; many: string }> = {
  PRODUCT: { template: "Product template", data: "Product data", sections: "Product sections", pages: "product pages", one: "product", many: "products" },
  CATEGORY: { template: "Category template", data: "Category data", sections: "Category sections", pages: "category pages", one: "category", many: "categories" },
};

/** Whose data a page shows: its template kind, or the kind whose sections it holds. */
export const pageKindOf = (contentType: Pick<ComponentDef, "templateFor" | "sectionsFor"> | null | undefined): TemplateFor | null => contentType?.templateFor ?? contentType?.sectionsFor ?? null;

export type TemplateTargetsLike = { isDefault?: boolean | null; products?: readonly { name?: string | null }[] | null; categories?: readonly { name?: string | null }[] | null };

/** Where a template is used: "Default · 2 categories", "Women", "3 products" or "Not assigned". */
export const targetsSummary = (targets: TemplateTargetsLike | null | undefined) => {
  const parts: string[] = [];
  if (targets?.isDefault) parts.push("Default");
  const categories = targets?.categories ?? [];
  const products = targets?.products ?? [];
  if (categories.length) parts.push(categories.length === 1 ? categories[0]!.name || "1 category" : `${categories.length} categories`);
  if (products.length) parts.push(products.length === 1 ? products[0]!.name || "1 product" : `${products.length} products`);
  return parts.length ? parts.join(" · ") : "Not assigned";
};

export type ImageValue = { url: string; alt?: LocalizedText | string; width?: number; height?: number };
export type LinkValue = { kind: "url"; url: string; newTab?: boolean } | { kind: "page" | "product" | "category"; id: string; newTab?: boolean };
export type NodeVisibility = { channelIds?: string[]; locales?: string[]; from?: string | null; until?: string | null };
export type PageNode = { id: string; component: string; variation?: string; hidden?: boolean; visibility?: NodeVisibility; fields: Record<string, unknown> };
export type ListItem = { id: string; fields: Record<string, unknown> };
export type PageSeo = { title?: LocalizedText; description?: LocalizedText; image?: ImageValue | null; noIndex?: boolean };
export type PageDocument = { title: LocalizedText; path: string | null; seo: PageSeo; root: PageNode };

/** A node (empty path) or a field in it: [field] or [field, itemId, subField]. */
export type Selection = { nodeId: string; path: string[] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const newNodeId = () => `n${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export const createNode = (def: Pick<ComponentDef, "code" | "fields" | "variations">): PageNode => ({
  id: newNodeId(),
  component: def.code,
  ...(def.variations[0] ? { variation: def.variations[0].code } : {}),
  fields: Object.fromEntries(def.fields.filter((f) => f.defaultValue !== undefined).map((f) => [f.key, structuredClone(f.defaultValue)])),
});

export const createListItem = (field: FieldDefinition): ListItem => ({
  id: newNodeId(),
  fields: Object.fromEntries((field.fields ?? []).filter((f) => f.defaultValue !== undefined).map((f) => [f.key, structuredClone(f.defaultValue)])),
});

export type Definitions = ReadonlyMap<string, Pick<ComponentDef, "code" | "name" | "fields" | "variations" | "kind">>;

export const visibleFields = (def: Pick<ComponentDef, "fields" | "variations">, node: Pick<PageNode, "variation">) => {
  const variation = node.variation ?? def.variations[0]?.code;
  return def.fields.filter((f) => !f.variations?.length || !variation || f.variations.includes(variation));
};

/** Child nodes of a node's blocks fields, in order. */
export const childSlots = (node: PageNode, defs: Definitions) =>
  (defs.get(node.component)?.fields ?? [])
    .filter((f) => f.type === "blocks")
    .map((field) => ({ field, children: (Array.isArray(node.fields[field.key]) ? (node.fields[field.key] as unknown[]) : []).filter(isObject) as PageNode[] }));

/** Depth-first visit of every node. */
export const walk = (root: PageNode, defs: Definitions, visit: (node: PageNode, parent: PageNode | null, depth: number) => void) => {
  const go = (node: PageNode, parent: PageNode | null, depth: number) => {
    visit(node, parent, depth);
    for (const slot of childSlots(node, defs)) for (const child of slot.children) go(child, node, depth + 1);
  };
  go(root, null, 0);
};

export const findNode = (root: PageNode, defs: Definitions, id: string): PageNode | null => {
  let found: PageNode | null = null;
  walk(root, defs, (node) => {
    if (!found && node.id === id) found = node;
  });
  return found;
};

export const findSlot = (root: PageNode, defs: Definitions, id: string): { parent: PageNode; field: FieldDefinition; index: number; siblings: PageNode[] } | null => {
  let found: ReturnType<typeof findSlot> = null;
  walk(root, defs, (node) => {
    if (found) return;
    for (const slot of childSlots(node, defs)) {
      const index = slot.children.findIndex((c) => c.id === id);
      if (index >= 0) found = { parent: node, field: slot.field, index, siblings: slot.children };
    }
  });
  return found;
};

export const updateNode = (root: PageNode, defs: Definitions, id: string, update: (node: PageNode) => PageNode): PageNode => {
  if (root.id === id) return update(root);
  const fields = { ...root.fields };
  let changed = false;
  for (const slot of childSlots(root, defs)) {
    const next = slot.children.map((child) => {
      const updated = updateNode(child, defs, id, update);
      if (updated !== child) changed = true;
      return updated;
    });
    if (changed) fields[slot.field.key] = next;
  }
  return changed ? { ...root, fields } : root;
};

export const setField = (root: PageNode, defs: Definitions, id: string, key: string, value: unknown) => updateNode(root, defs, id, (node) => ({ ...node, fields: { ...node.fields, [key]: value } }));

export const insertNode = (root: PageNode, defs: Definitions, parentId: string, fieldKey: string, node: PageNode, index?: number) =>
  updateNode(root, defs, parentId, (parent) => {
    const list = Array.isArray(parent.fields[fieldKey]) ? [...(parent.fields[fieldKey] as PageNode[])] : [];
    list.splice(index ?? list.length, 0, node);
    return { ...parent, fields: { ...parent.fields, [fieldKey]: list } };
  });

export const removeNode = (root: PageNode, defs: Definitions, id: string) => {
  const slot = findSlot(root, defs, id);
  if (!slot) return root;
  return setField(root, defs, slot.parent.id, slot.field.key, slot.siblings.filter((c) => c.id !== id));
};

export const moveNode = (root: PageNode, defs: Definitions, id: string, move: { delta: number } | { toIndex: number }) => {
  const slot = findSlot(root, defs, id);
  if (!slot) return root;
  const target = "delta" in move ? slot.index + move.delta : move.toIndex;
  if (target < 0 || target >= slot.siblings.length || target === slot.index) return root;
  const list = [...slot.siblings];
  const [node] = list.splice(slot.index, 1);
  list.splice(target, 0, node!);
  return setField(root, defs, slot.parent.id, slot.field.key, list);
};

/** Move a node into any blocks field, at `index` as counted before the node is removed. */
export const relocateNode = (root: PageNode, defs: Definitions, id: string, parentId: string, fieldKey: string, index: number) => {
  const node = findNode(root, defs, id);
  if (!node) return root;
  // Never into itself or its own descendants.
  if (node.id === parentId || findNode(node, defs, parentId)) return root;
  const slot = findSlot(root, defs, id);
  const adjusted = slot && slot.parent.id === parentId && slot.field.key === fieldKey && slot.index < index ? index - 1 : index;
  return insertNode(removeNode(root, defs, id), defs, parentId, fieldKey, node, adjusted);
};

export const cloneWithNewIds = (node: PageNode): PageNode => {
  const renew = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(renew);
    if (!isObject(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) copy[k] = renew(v);
    // Nodes ({ id, component, fields }) and list items ({ id, fields }) get new ids.
    if (typeof copy.id === "string" && isObject(copy.fields)) copy.id = newNodeId();
    return copy;
  };
  return renew(structuredClone(node)) as PageNode;
};

export const duplicateNode = (root: PageNode, defs: Definitions, id: string) => {
  const slot = findSlot(root, defs, id);
  if (!slot) return { root, copyId: null };
  const copy = cloneWithNewIds(slot.siblings[slot.index]!);
  return { root: insertNode(root, defs, slot.parent.id, slot.field.key, copy, slot.index + 1), copyId: copy.id };
};

/** A component that shows product or category data only fits templates and sections of that kind. */
export const fitsPage = (def: Pick<ComponentDef, "templateFor">, pageKind: TemplateFor | null) => !def.templateFor || def.templateFor === pageKind;

/** Components a blocks field accepts on a page whose data is `pageKind` (see pageKindOf). */
export const allowedIn = <T extends Pick<ComponentDef, "code" | "kind" | "templateFor">>(field: FieldDefinition, all: readonly T[], pageKind: TemplateFor | null) =>
  all.filter((c) => c.kind === "COMPONENT" && (!field.allowedComponents?.length || field.allowedComponents.includes(c.code)) && fitsPage(c, pageKind));

/** A localized value in one locale, falling back to any locale when asked. */
export const textIn = (value: unknown, locale: string, fallback = false): string => {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  const text = value[locale];
  if (typeof text === "string") return text;
  if (!fallback) return "";
  const any = Object.values(value).find((v) => typeof v === "string" && v.trim());
  return typeof any === "string" ? any : "";
};

/** Set one locale of a localized value (removing it when empty). */
export const withText = (value: unknown, locale: string, text: string): LocalizedText => {
  const current = isObject(value) ? ({ ...value } as LocalizedText) : typeof value === "string" && value ? { [locale]: value } : {};
  if (text === "") delete current[locale];
  else current[locale] = text;
  return current;
};

/** Fields that name a component best, in order of preference; then any other text field. */
const LABEL_KEYS = ["title", "label", "name", "heading", "text", "question"];

/** A node's label in trees and breadcrumbs: its most title-like text, else the component name. */
export const nodeLabel = (node: PageNode, defs: Definitions, locale: string) => {
  const def = defs.get(node.component);
  const rank = (key: string) => (LABEL_KEYS.includes(key) ? LABEL_KEYS.indexOf(key) : LABEL_KEYS.length);
  for (const field of [...(def?.fields ?? [])].sort((a, b) => rank(a.key) - rank(b.key))) {
    if (field.type !== "text") continue;
    const text = textIn(node.fields[field.key], locale, true).trim();
    if (text) return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }
  return def?.name ?? node.component;
};

// ---------------------------------------------------------------- bridge protocol (see src/visual-editing/bridge.js)

export const BRIDGE_SOURCE = "ecom-visual-editing";
export const ADMIN_SOURCE = "ecom-admin";

export type BridgeMessage =
  /** features: what this bridge supports, e.g. "inline-text", "actions", "documents". */
  | { type: "bridge:ready"; path: string; url: string; title: string; bridgeVersion: number; features?: string[] }
  | { type: "bridge:connected"; path: string }
  /** documentId: the page the element belongs to (a header or footer is a page of its own). */
  | { type: "bridge:select"; nodeId: string | null; path: string[]; documentId: string | null }
  | { type: "bridge:hover"; nodeId: string | null; path: string[]; documentId: string | null }
  | { type: "bridge:action"; action: BridgeAction; nodeId: string }
  /** Text edited in place (data-ecom-patch="text"), in the preview locale; `done` when editing ends. */
  | { type: "bridge:input"; nodeId: string; path: string[]; value: string; documentId: string | null; done?: boolean }
  | { type: "bridge:navigated"; path: string; url: string; title: string }
  | { type: "bridge:rendered"; path: string };

export type BridgeAction = "selectParent" | "insertBefore" | "insertAfter" | "moveUp" | "moveDown" | "duplicate" | "remove";

export type EditorMessage =
  | { type: "editor:ping" }
  /** documentId: the edited page's global id; selection and patches apply inside its wrapper. */
  | { type: "editor:connect"; mode: "edit" | "browse"; labels: Record<string, string>; documentId: string }
  | { type: "editor:mode"; mode: "edit" | "browse" }
  /** actions: which toolbar buttons to enable for this node (omitted ones stay enabled). */
  | { type: "editor:select"; nodeId: string | null; path: string[]; scroll?: boolean; actions?: Partial<Record<BridgeAction, boolean>> }
  | { type: "editor:hover"; nodeId: string | null; path: string[] }
  | { type: "editor:patch"; nodeId: string; path: string[]; value: unknown }
  | { type: "editor:refresh"; reason?: string }
  | { type: "editor:navigate"; path: string };

/** A message from the preview frame, or null for other sources and versions. */
export const readBridgeMessage = (data: unknown): BridgeMessage | null =>
  isObject(data) && data.source === BRIDGE_SOURCE && data.version === 1 && typeof data.type === "string" && data.type.startsWith("bridge:") ? (data as unknown as BridgeMessage) : null;

export const editorMessage = (message: EditorMessage) => ({ source: ADMIN_SOURCE, version: 1, ...message });
