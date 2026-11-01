import { z } from "zod";
import type { LocalizedText } from "../../lib/i18n.ts";
import { parseGlobalId } from "../../lib/ids.ts";

/**
 * The page builder's document model, shared by the service, the API and the admin. A document is
 * a tree of component nodes; references in it are global ids.
 */

export const FIELD_TYPES = ["text", "richText", "number", "boolean", "select", "color", "image", "link", "date", "product", "products", "category", "blocks", "list"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type ComponentKind = "content_type" | "component";
/**
 * A content type with `templateFor` is a product or category template; a component with it shows
 * that object's data. A content type with `sectionsFor` holds one product's or category's sections.
 */
export const TEMPLATE_KINDS = ["product", "category"] as const;
export type TemplateFor = (typeof TEMPLATE_KINDS)[number];

export type FieldOption = { value: string; label: string };
export type FieldDefinition = {
  key: string;
  type: FieldType;
  label: string;
  description?: string;
  required?: boolean;
  /** Text and rich text only: one value per locale. */
  localized?: boolean;
  /** Inspector tab, e.g. "Content", "Style". */
  group?: string;
  /** Only shown for these variations; all when absent. */
  variations?: string[];
  placeholder?: string;
  multiline?: boolean;
  options?: FieldOption[];
  /** Numbers: value range. Text: length. blocks, list, products: item count. */
  min?: number;
  max?: number;
  /** blocks only: component codes allowed here; empty allows every component. */
  allowedComponents?: string[];
  /** list only: the fields of each item. */
  fields?: FieldDefinition[];
  defaultValue?: unknown;
};
export type Variation = { code: string; name: string; description?: string; previewImageUrl?: string };

export type ImageValue = { url: string; alt?: LocalizedText | string; width?: number; height?: number };
export type LinkValue = { kind: "url"; url: string; newTab?: boolean } | { kind: "page" | "product" | "category"; id: string; newTab?: boolean };
export type NodeVisibility = { channelIds?: string[]; locales?: string[]; from?: string | null; until?: string | null };
export type PageNode = { id: string; component: string; variation?: string; hidden?: boolean; visibility?: NodeVisibility; fields: Record<string, unknown> };
export type ListItem = { id: string; fields: Record<string, unknown> };
export type PageSeo = { title?: LocalizedText; description?: LocalizedText; image?: ImageValue | null; noIndex?: boolean };
/** Everything that is drafted and published together. */
export type PageDocument = { title: LocalizedText; path: string | null; seo: PageSeo; root: PageNode };

export type ComponentDefinition = {
  code: string;
  kind: ComponentKind;
  name: string;
  description?: string | null;
  groupName?: string | null;
  icon?: string | null;
  previewImageUrl?: string | null;
  fields: FieldDefinition[];
  variations: Variation[];
  routable?: boolean;
  singleton?: boolean;
  templateFor?: TemplateFor | null;
  /** Content types only: pages of this type are one product's or category's own sections. */
  sectionsFor?: TemplateFor | null;
};

export type ValidationIssue = { path: string[]; message: string };

export const MAX_NODES = 1000;
export const MAX_DEPTH = 12;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-zA-Z]{1,3})?$/;
const NODE_ID = /^[A-Za-z0-9_-]{2,64}$/;
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

// ---------------------------------------------------------------- definitions

const code = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "Lowercase letters, digits and underscores, starting with a letter");
const fieldKey = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,47}$/, "Start with a lowercase letter; letters, digits and underscores");

const baseField = {
  key: fieldKey,
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  required: z.boolean().optional(),
  localized: z.boolean().optional(),
  group: z.string().max(40).optional(),
  variations: z.array(code).optional(),
  placeholder: z.string().max(200).optional(),
  multiline: z.boolean().optional(),
  options: z.array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(120) })).max(100).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  allowedComponents: z.array(code).optional(),
  defaultValue: z.unknown().optional(),
};
const leafField = z.object({ ...baseField, type: z.enum(FIELD_TYPES.filter((t) => t !== "blocks" && t !== "list") as [Exclude<FieldType, "blocks" | "list">, ...Exclude<FieldType, "blocks" | "list">[]]) });
const fieldSchema: z.ZodType<FieldDefinition> = z.lazy(() =>
  z.object({ ...baseField, type: z.enum(FIELD_TYPES), fields: z.array(leafField).max(40).optional() }),
) as z.ZodType<FieldDefinition>;

export const componentDefinitionSchema = z
  .object({
    code,
    kind: z.enum(["content_type", "component"]),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().optional(),
    groupName: z.string().max(60).nullable().optional(),
    icon: z.string().max(60).nullable().optional(),
    previewImageUrl: z.string().max(2000).nullable().optional(),
    fields: z.array(fieldSchema).max(80).default([]),
    variations: z.array(z.object({ code, name: z.string().min(1).max(120), description: z.string().max(500).optional(), previewImageUrl: z.string().max(2000).optional() })).max(20).default([]),
    routable: z.boolean().optional(),
    singleton: z.boolean().optional(),
    templateFor: z.enum(TEMPLATE_KINDS).nullable().optional(),
    sectionsFor: z.enum(TEMPLATE_KINDS).nullable().optional(),
  })
  .superRefine((def, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const checkFields = (fields: FieldDefinition[], path: (string | number)[]) => {
      const seen = new Set<string>();
      fields.forEach((field, i) => {
        if (seen.has(field.key)) issue([...path, i, "key"], `Duplicate field key ${field.key}`);
        seen.add(field.key);
        if (field.type === "select" && !field.options?.length) issue([...path, i, "options"], "A select field needs options");
        if (field.localized && field.type !== "text" && field.type !== "richText") issue([...path, i, "localized"], "Only text and rich text can be localized");
        if (field.type === "list") {
          if (!field.fields?.length) issue([...path, i, "fields"], "A list needs item fields");
          else checkFields(field.fields, [...path, i, "fields"]);
        } else if (field.fields?.length) issue([...path, i, "fields"], "Only list fields have item fields");
        if (field.allowedComponents?.length && field.type !== "blocks") issue([...path, i, "allowedComponents"], "Only blocks fields allow components");
        if (field.min != null && field.max != null && field.min > field.max) issue([...path, i, "max"], "Must be at least min");
        for (const v of field.variations ?? []) if (!def.variations.some((x) => x.code === v)) issue([...path, i, "variations"], `Unknown variation ${v}`);
        const problem = field.defaultValue === undefined ? null : defaultValueProblem(field);
        if (problem) issue([...path, i, "defaultValue"], problem);
      });
    };
    checkFields(def.fields, ["fields"]);
    const variations = new Set<string>();
    def.variations.forEach((v, i) => {
      if (variations.has(v.code)) issue(["variations", i, "code"], `Duplicate variation ${v.code}`);
      variations.add(v.code);
    });
    if (def.kind === "component" && (def.routable || def.singleton)) issue(["kind"], "Only content types can be routable or singletons");
    if (def.kind === "content_type" && def.templateFor) {
      if (def.routable) issue(["routable"], "Templates have no path: product and category pages render with them");
      if (def.singleton) issue(["singleton"], "A template cannot be a singleton; assign templates to products and categories instead");
    }
    if (def.sectionsFor) {
      if (def.kind !== "content_type") issue(["sectionsFor"], "Only content types hold a product's or category's sections");
      else if (def.templateFor) issue(["sectionsFor"], "A content type is either a template or holds sections, not both");
      if (def.routable) issue(["routable"], "Sections have no path: they show on their product's or category's page");
      if (def.singleton) issue(["singleton"], "Sections cannot be a singleton: each product or category has its own");
    }
  });

/** Why a field's default value would make new instances invalid, or null. */
const defaultValueProblem = (field: FieldDefinition): string | null => {
  const v = field.defaultValue;
  switch (field.type) {
    case "text":
    case "richText":
      return typeof v === "string" || (field.localized && typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")) ? null : "Expected text";
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return "Expected a number";
      if ((field.min != null && v < field.min) || (field.max != null && v > field.max)) return "Outside the field's range";
      return null;
    case "boolean":
      return typeof v === "boolean" ? null : "Expected true or false";
    case "select":
      return typeof v === "string" && (field.options ?? []).some((o) => o.value === v) ? null : "Must be one of the options";
    case "color":
      return typeof v === "string" && COLOR.test(v) ? null : "Expected a hex color";
    case "date":
      return typeof v === "string" && DATE.test(v) ? null : "Expected a date";
    default:
      return `${field.type} fields have no default value`;
  }
};

// ---------------------------------------------------------------- paths

/** "/", "/summer-sale", "/journal/2026/field-notes". Lowercase, so links never differ by case. */
export const PATH_PATTERN = /^\/(?:[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)?$/;
/** Paths the storefront routes to products, categories and the frontend's own endpoints. */
export const RESERVED_PATH_PREFIXES = ["/products/", "/categories/", "/api/", "/_next/", "/admin/"];

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

// ---------------------------------------------------------------- documents

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isLocalizedText = (value: unknown): value is Record<string, string> => isObject(value) && Object.entries(value).every(([k, v]) => LOCALE.test(k) && typeof v === "string");
const hasText = (value: unknown) => (typeof value === "string" ? value.trim() !== "" : isLocalizedText(value) && Object.values(value).some((v) => v.trim() !== ""));
const isGid = (value: unknown, type: string) => typeof value === "string" && parseGlobalId(value)?.type === type;

/** Node and list item ids, short enough for URLs and data attributes. */
export const newNodeId = () => `n${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export type ValidateOptions = {
  components: ReadonlyMap<string, ComponentDefinition>;
  pageType: string;
  /** Draft saves check structure; publishing also checks required fields and counts. */
  mode: "draft" | "publish";
};

/**
 * Check a document against the component library. Issue paths start `["node", nodeId, …]`.
 * Values of removed fields are kept, so re-adding a field loses nothing.
 */
export const validateDocument = (input: unknown, options: ValidateOptions): { document: PageDocument | null; issues: ValidationIssue[] } => {
  const issues: ValidationIssue[] = [];
  if (!isObject(input)) return { document: null, issues: [{ path: [], message: "Expected a page document" }] };
  const pageType = options.components.get(options.pageType);
  if (!pageType || pageType.kind !== "content_type") return { document: null, issues: [{ path: ["type"], message: `Unknown content type ${options.pageType}` }] };

  if (!isLocalizedText(input.title ?? {})) issues.push({ path: ["title"], message: "Expected text per locale" });
  if (options.mode === "publish" && !hasText(input.title)) issues.push({ path: ["title"], message: "Give the page a title" });
  if (pageType.routable !== false) {
    if (typeof input.path !== "string") issues.push({ path: ["path"], message: "This content type needs a path" });
    else {
      const problem = pathProblem(input.path);
      if (problem) issues.push({ path: ["path"], message: problem });
    }
  } else if (input.path != null) issues.push({ path: ["path"], message: `${pageType.name} pages have no path` });
  const seo = input.seo ?? {};
  if (!isObject(seo)) issues.push({ path: ["seo"], message: "Expected an object" });
  else {
    for (const key of ["title", "description"] as const) if (seo[key] != null && !isLocalizedText(seo[key])) issues.push({ path: ["seo", key], message: "Expected text per locale" });
    if (seo.image != null && !isImage(seo.image)) issues.push({ path: ["seo", "image"], message: "Expected an image" });
    if (seo.noIndex != null && typeof seo.noIndex !== "boolean") issues.push({ path: ["seo", "noIndex"], message: "Expected true or false" });
  }

  const ids = new Set<string>();
  let count = 0;
  const checkNode = (node: unknown, depth: number, allowed: readonly string[] | null, at: string[]): void => {
    if (!isObject(node) || typeof node.component !== "string" || !isObject(node.fields)) {
      issues.push({ path: at, message: "Expected a component with fields" });
      return;
    }
    const nodeId = typeof node.id === "string" ? node.id : "";
    const here = ["node", nodeId || at.join(".")];
    if (!NODE_ID.test(nodeId)) issues.push({ path: here, message: "Missing or invalid node id" });
    else if (ids.has(nodeId)) issues.push({ path: here, message: `Duplicate node id ${nodeId}` });
    ids.add(nodeId);
    if (++count > MAX_NODES) {
      issues.push({ path: here, message: `A page can hold at most ${MAX_NODES} components` });
      return;
    }
    if (depth > MAX_DEPTH) {
      issues.push({ path: here, message: `Components can nest at most ${MAX_DEPTH} levels deep` });
      return;
    }
    const definition = options.components.get(node.component);
    if (!definition) {
      issues.push({ path: here, message: `Unknown component ${node.component}` });
      return;
    }
    if (depth > 0 && definition.kind !== "component") issues.push({ path: here, message: `${definition.name} is a content type and cannot be nested` });
    if (allowed && allowed.length && !allowed.includes(definition.code)) issues.push({ path: here, message: `${definition.name} is not allowed here` });
    // Sections show on their product's or category's page, so they may show its data.
    if (definition.kind === "component" && definition.templateFor && definition.templateFor !== (pageType.templateFor ?? pageType.sectionsFor)) {
      issues.push({ path: here, message: `${definition.name} shows ${definition.templateFor} data, so it only works in ${definition.templateFor} templates and sections` });
    }
    if (node.variation != null && (typeof node.variation !== "string" || !definition.variations.some((v) => v.code === node.variation))) {
      issues.push({ path: [...here, "variation"], message: `Unknown variation ${String(node.variation)}` });
    }
    if (node.hidden != null && typeof node.hidden !== "boolean") issues.push({ path: [...here, "hidden"], message: "Expected true or false" });
    if (node.visibility != null) checkVisibility(node.visibility, [...here, "visibility"]);
    const variation = typeof node.variation === "string" ? node.variation : definition.variations[0]?.code;
    for (const field of definition.fields) {
      if (field.variations?.length && variation && !field.variations.includes(variation)) continue;
      checkValue(field, node.fields[field.key], depth, [...here, field.key]);
    }
  };

  const checkVisibility = (value: unknown, at: string[]) => {
    if (!isObject(value)) return void issues.push({ path: at, message: "Expected an object" });
    if (value.channelIds != null && !(Array.isArray(value.channelIds) && value.channelIds.every((v) => isGid(v, "Channel")))) issues.push({ path: [...at, "channelIds"], message: "Expected channel ids" });
    if (value.locales != null && !(Array.isArray(value.locales) && value.locales.every((v) => typeof v === "string" && LOCALE.test(v)))) issues.push({ path: [...at, "locales"], message: "Expected locale codes" });
    for (const key of ["from", "until"] as const) if (value[key] != null && (typeof value[key] !== "string" || Number.isNaN(Date.parse(value[key] as string)))) issues.push({ path: [...at, key], message: "Expected a date and time" });
  };

  const publishing = options.mode === "publish";
  const checkCount = (field: FieldDefinition, length: number, at: string[]) => {
    if (!publishing) return;
    const min = Math.max(field.required ? 1 : 0, field.min ?? 0);
    if (length < min) issues.push({ path: at, message: min === 1 ? `${field.label} is required` : `${field.label} needs at least ${min}` });
    if (field.max != null && length > field.max) issues.push({ path: at, message: `${field.label} allows at most ${field.max}` });
  };

  const checkValue = (field: FieldDefinition, value: unknown, depth: number, at: string[]): void => {
    const missing = value === undefined || value === null || value === "";
    if (field.type === "blocks") {
      if (value != null && !Array.isArray(value)) return void issues.push({ path: at, message: "Expected a list of components" });
      const children = (value as unknown[] | undefined) ?? [];
      children.forEach((child, i) => checkNode(child, depth + 1, field.allowedComponents ?? [], [...at, String(i)]));
      return checkCount(field, children.length, at);
    }
    if (field.type === "list") {
      if (value != null && !Array.isArray(value)) return void issues.push({ path: at, message: "Expected a list" });
      const items = (value as unknown[] | undefined) ?? [];
      const itemIds = new Set<string>();
      items.forEach((item, i) => {
        if (!isObject(item) || typeof item.id !== "string" || !NODE_ID.test(item.id) || !isObject(item.fields)) return void issues.push({ path: [...at, String(i)], message: "Expected an item with an id and fields" });
        if (itemIds.has(item.id)) issues.push({ path: [...at, item.id], message: `Duplicate item id ${item.id}` });
        itemIds.add(item.id);
        for (const sub of field.fields ?? []) checkValue(sub, item.fields[sub.key], depth, [...at, item.id, sub.key]);
      });
      return checkCount(field, items.length, at);
    }
    if (field.type === "products") {
      if (value != null && !(Array.isArray(value) && value.every((v) => isGid(v, "Product")))) return void issues.push({ path: at, message: "Expected product ids" });
      return checkCount(field, ((value as unknown[] | undefined) ?? []).length, at);
    }
    if (missing) {
      if (publishing && field.required && field.type !== "boolean") issues.push({ path: at, message: `${field.label} is required` });
      return;
    }
    const fail = (message: string) => void issues.push({ path: at, message });
    switch (field.type) {
      case "text":
      case "richText": {
        const limit = field.type === "text" ? 10_000 : 200_000;
        if (field.localized) {
          if (!isLocalizedText(value)) return fail("Expected text per locale");
          if (Object.values(value).some((v) => v.length > limit)) return fail(`At most ${limit} characters`);
        } else if (typeof value !== "string") return fail("Expected text");
        else if (value.length > limit) return fail(`At most ${limit} characters`);
        if (publishing && field.required && !hasText(value)) return fail(`${field.label} is required`);
        if (publishing && field.type === "text" && field.max != null) {
          const texts = typeof value === "string" ? [value] : Object.values(value as Record<string, string>);
          if (texts.some((t) => t.length > field.max!)) return fail(`${field.label} allows at most ${field.max} characters`);
        }
        return;
      }
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return fail("Expected a number");
        if (publishing && field.min != null && value < field.min) return fail(`At least ${field.min}`);
        if (publishing && field.max != null && value > field.max) return fail(`At most ${field.max}`);
        return;
      case "boolean":
        return typeof value === "boolean" ? undefined : fail("Expected true or false");
      case "select":
        return typeof value === "string" && (field.options ?? []).some((o) => o.value === value) ? undefined : fail(`Choose one of ${(field.options ?? []).map((o) => o.value).join(", ")}`);
      case "color":
        return typeof value === "string" && COLOR.test(value) ? undefined : fail("Expected a hex color such as #1f2937");
      case "image":
        return isImage(value) ? undefined : fail("Expected an image with a URL");
      case "link":
        return isLink(value) ? undefined : fail("Expected a link to a URL, page, product or category");
      case "date":
        return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value)) ? undefined : fail("Expected a date");
      case "product":
        return isGid(value, "Product") ? undefined : fail("Expected a product id");
      case "category":
        return isGid(value, "Category") ? undefined : fail("Expected a category id");
    }
  };

  if (!isObject(input.root)) issues.push({ path: ["root"], message: "Expected the page's root component" });
  else {
    if (input.root.component !== options.pageType) issues.push({ path: ["node", String(input.root.id ?? "root")], message: `The root must be a ${pageType.name}` });
    checkNode(input.root, 0, null, ["root"]);
  }
  return {
    document: issues.length ? null : { title: (input.title ?? {}) as LocalizedText, path: (input.path as string | null | undefined) ?? null, seo: seo as PageSeo, root: input.root as PageNode },
    issues,
  };
};

const isImage = (value: unknown): value is ImageValue =>
  isObject(value) &&
  typeof value.url === "string" &&
  value.url.length > 0 &&
  value.url.length <= 2000 &&
  /^(https?:\/\/|\/)/.test(value.url) &&
  (value.alt == null || typeof value.alt === "string" || isLocalizedText(value.alt)) &&
  (value.width == null || (typeof value.width === "number" && value.width > 0)) &&
  (value.height == null || (typeof value.height === "number" && value.height > 0));

const isLink = (value: unknown): value is LinkValue => {
  if (!isObject(value) || (value.newTab != null && typeof value.newTab !== "boolean")) return false;
  if (value.kind === "url") return typeof value.url === "string" && /^(https?:\/\/|mailto:|tel:|\/|#)/.test(value.url) && value.url.length <= 2000;
  const type = { page: "Page", product: "Product", category: "Category" }[value.kind as string];
  return !!type && isGid(value.id, type);
};

/** A new content type's root node, with default values for its fields. */
export const emptyNode = (definition: ComponentDefinition, id = newNodeId()): PageNode => ({
  id,
  component: definition.code,
  ...(definition.variations[0] ? { variation: definition.variations[0].code } : {}),
  fields: Object.fromEntries(definition.fields.filter((f) => f.defaultValue !== undefined).map((f) => [f.key, f.defaultValue])),
});

/** Visit every node depth first, with its parent. */
export const walkNodes = (root: PageNode, components: ReadonlyMap<string, ComponentDefinition>, visit: (node: PageNode, parent: PageNode | null) => void) => {
  const go = (node: PageNode, parent: PageNode | null) => {
    visit(node, parent);
    const definition = components.get(node.component);
    for (const field of definition?.fields ?? []) {
      if (field.type !== "blocks") continue;
      const children = node.fields[field.key];
      if (Array.isArray(children)) for (const child of children) if (isObject(child)) go(child as PageNode, node);
    }
  };
  go(root, null);
};

/** Component codes used anywhere in a document, defined or not, for usage counts. */
export const componentCodesIn = (document: PageDocument | null | undefined): Set<string> => {
  const codes = new Set<string>();
  const go = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(go);
    if (!isObject(value)) return;
    if (typeof value.component === "string" && isObject(value.fields)) codes.add(value.component);
    for (const v of Object.values(value)) if (typeof v === "object") go(v);
  };
  if (document) go(document.root);
  return codes;
};
