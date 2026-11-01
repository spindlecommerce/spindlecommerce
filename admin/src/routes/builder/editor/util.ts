import { slugify } from "@/lib/utils";
import { childSlots, textIn, type ComponentDef, type Definitions, type FieldDefinition, type LinkValue, type PageDocument, type PageNode } from "../model";

/** Path rules mirror src/modules/builder/model.ts, so the editor only sends paths the API accepts. */

// ---------------------------------------------------------------- paths

export const PATH_PATTERN = /^\/(?:[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)?$/;
const RESERVED_PATH_PREFIXES = ["/products/", "/categories/", "/api/", "/_next/", "/admin/"];

export const normalizePath = (input: string) => {
  const trimmed = input.trim().toLowerCase().replace(/\/{2,}/g, "/");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
};

export const pathProblem = (path: string): string | null => {
  if (!PATH_PATTERN.test(path)) return "Use lowercase letters, digits, hyphens and slashes, e.g. /summer-sale";
  if (path.length > 300) return "At most 300 characters";
  const reserved = RESERVED_PATH_PREFIXES.find((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
  return reserved ? `${reserved.replace(/\/$/, "")} is reserved for storefront routes` : null;
};

/** "Summer Sale 2026!" → "/summer-sale-2026". */
export const pathFromTitle = (title: string) => `/${slugify(title)}`;

// ---------------------------------------------------------------- values

export const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const LINK_URL_PATTERN = /^(https?:\/\/|mailto:|tel:|\/|#)/;
export const IMAGE_URL_PATTERN = /^(https?:\/\/|\/)/;

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const isEmptyValue = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.values(value).every((v) => typeof v === "string" && !v.trim()));

/** Locales a localized value has text in; "*" for a plain string. */
export const filledLocales = (value: unknown): string[] =>
  typeof value === "string" ? (value.trim() ? ["*"] : []) : isObject(value) ? Object.entries(value).flatMap(([locale, text]) => (typeof text === "string" && text.trim() ? [locale] : [])) : [];

/** Another locale's text, to show as a placeholder for an empty one (the default locale first). */
export const fallbackText = (value: unknown, locale: string, locales: readonly string[]) => {
  if (!isObject(value)) return "";
  for (const other of locales) if (other !== locale && typeof value[other] === "string" && (value[other] as string).trim()) return value[other] as string;
  return textIn(value, locale, true);
};

/** Text with Markdown syntax removed, for one-line summaries. */
export const plainText = (markdown: string) =>
  markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

export const truncate = (text: string, length = 60) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

export const isLink = (value: unknown): value is LinkValue =>
  isObject(value) && (value.kind === "url" ? typeof value.url === "string" : (value.kind === "page" || value.kind === "product" || value.kind === "category") && typeof value.id === "string");

/** A list item's title: its first text field with content, else "Item n". */
export const listItemLabel = (field: FieldDefinition, item: { fields: Record<string, unknown> }, locale: string, index: number) => {
  for (const sub of field.fields ?? []) {
    if (sub.type !== "text" && sub.type !== "richText") continue;
    const text = plainText(textIn(item.fields[sub.key], locale, true));
    if (text) return truncate(text, 48);
  }
  return `${field.label.replace(/s$/, "") || "Item"} ${index + 1}`;
};

// ---------------------------------------------------------------- documents

export type NodeEntry = { node: PageNode; parentId: string | null; fieldKey: string | null; index: number; depth: number; trail: string[] };

const indexes = new WeakMap<PageNode, Map<string, NodeEntry>>();

/** Every node by id with where it sits; cached per tree, so lookups after an edit stay cheap. */
export const indexTree = (root: PageNode, defs: Definitions): Map<string, NodeEntry> => {
  let index = indexes.get(root);
  if (index) return index;
  index = new Map();
  const visit = (node: PageNode, parentId: string | null, fieldKey: string | null, position: number, depth: number, trail: string[]) => {
    index!.set(node.id, { node, parentId, fieldKey, index: position, depth, trail });
    for (const slot of childSlots(node, defs)) slot.children.forEach((child, i) => visit(child, node.id, slot.field.key, i, depth + 1, [...trail, node.id]));
  };
  visit(root, null, null, 0, 0, []);
  indexes.set(root, index);
  return index;
};

export type NodeAbilities = { selectParent: boolean; insertBefore: boolean; insertAfter: boolean; moveUp: boolean; moveDown: boolean; duplicate: boolean; remove: boolean };
export type NodeLimits = { abilities: NodeAbilities; field: FieldDefinition | null; count: number; min: number; max: number | null };

/** What can be done to a node where it sits; shared by the toolbar, the tree and the shortcuts. */
export const nodeLimits = (root: PageNode, defs: Definitions, nodeId: string): NodeLimits | null => {
  const index = indexTree(root, defs);
  const entry = index.get(nodeId);
  if (!entry || entry.parentId === null || entry.fieldKey === null) return null;
  const parent = index.get(entry.parentId)!.node;
  const field = defs.get(parent.component)?.fields.find((f) => f.key === entry.fieldKey) ?? null;
  const siblings = Array.isArray(parent.fields[entry.fieldKey]) ? (parent.fields[entry.fieldKey] as unknown[]) : [];
  const count = siblings.length;
  const max = field?.max ?? null;
  const min = Math.max(field?.required ? 1 : 0, field?.min ?? 0);
  const room = max === null || count < max;
  return {
    field,
    count,
    min,
    max,
    abilities: { selectParent: entry.parentId !== root.id, insertBefore: room, insertAfter: room, moveUp: entry.index > 0, moveDown: entry.index < count - 1, duplicate: room, remove: count - 1 >= min },
  };
};

export const docTitle = (doc: Pick<PageDocument, "title">, locale: string) => textIn(doc.title, locale, true).trim();

export const labelsOf = (components: readonly Pick<ComponentDef, "code" | "name">[]) => Object.fromEntries(components.map((c) => [c.code, c.name]));

// ---------------------------------------------------------------- validation issues

export type Issue = { path: string[]; message: string };

/**
 * API field errors for a page: publish and schedule report ["node", id, field, …], ["title"],
 * ["path"] or ["seo", key]; draft saves prefix them with "document" and restores with "version".
 */
export const normalizeIssues = (errors: readonly { path?: readonly string[] | null; message?: string | null }[]): Issue[] =>
  errors.map((e) => {
    const path = [...(e.path ?? [])];
    if (path[0] === "document" || path[0] === "version" || path[0] === "input") path.shift();
    if (path[0] === "root") return { path: ["node", "root", ...path.slice(1)], message: e.message ?? "Invalid" };
    return { path, message: e.message ?? "Invalid" };
  });

/** Issues for one node: on the node itself, and by field path ("title", "items.itemId.question"). */
export const issuesForNode = (issues: readonly Issue[], nodeId: string) => {
  const self: string[] = [];
  const fields = new Map<string, string>();
  for (const issue of issues) {
    if (issue.path[0] !== "node" || issue.path[1] !== nodeId) continue;
    const rest = issue.path.slice(2);
    if (!rest.length) self.push(issue.message);
    else if (!fields.has(rest.join("."))) fields.set(rest.join("."), issue.message);
  }
  return { self, fields };
};

/** Page-level issues by key ("title", "path", "seo.title"). */
export const pageIssues = (issues: readonly Issue[]) => {
  const map = new Map<string, string>();
  for (const issue of issues) if (issue.path[0] !== "node" && issue.path.length) map.set(issue.path.join("."), issue.message);
  return map;
};

// ---------------------------------------------------------------- dates

/** ISO date-time ↔ `<input type="datetime-local">`, in the viewer's time zone. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value: string) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** True when focus is in something that takes typing, where editor shortcuts stand down. */
export const isTyping = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
};

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl+";
