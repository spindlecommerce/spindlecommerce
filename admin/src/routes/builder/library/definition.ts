import { Blocks, Boxes, CalendarDays, FolderTree, Hash, Image as ImageIcon, Link2, ListChecks, Package, Palette, Pilcrow, Rows3, ToggleRight, Type, type LucideIcon } from "lucide-react";
import { FIELD_TYPES, type ComponentKind, type FieldDefinition, type FieldOption, type FieldType, type TemplateFor, type Variation } from "../model";

/** Definition drafts, their CLI JSON, and a copy of the API's rules for showing problems inline. */

// ---------------------------------------------------------------- field types

export type FieldTypeInfo = { label: string; description: string; icon: LucideIcon };

export const FIELD_TYPE_INFO: Record<FieldType, FieldTypeInfo> = {
  text: { label: "Text", description: "Plain text on one line or several: headings, labels, captions.", icon: Type },
  richText: { label: "Rich text", description: "Formatted text in Markdown: paragraphs, lists, links.", icon: Pilcrow },
  number: { label: "Number", description: "A number, optionally within a range: counts, sizes, delays.", icon: Hash },
  boolean: { label: "Toggle", description: "On or off, e.g. show prices or autoplay.", icon: ToggleRight },
  select: { label: "Select", description: "One value from a fixed list of options: theme, alignment, size.", icon: ListChecks },
  color: { label: "Color", description: "A hex color such as #1f2937.", icon: Palette },
  image: { label: "Image", description: "An uploaded or linked image, with alt text.", icon: ImageIcon },
  link: { label: "Link", description: "A URL, or a page, product or category of the store.", icon: Link2 },
  date: { label: "Date", description: "A calendar date, optionally with a time.", icon: CalendarDays },
  product: { label: "Product", description: "One product from the catalog.", icon: Package },
  products: { label: "Products", description: "Several products, picked and ordered by hand.", icon: Boxes },
  category: { label: "Category", description: "One category from the catalog tree.", icon: FolderTree },
  blocks: { label: "Blocks", description: "A slot for nested components, e.g. a page's sections or a hero's buttons.", icon: Blocks },
  list: { label: "List", description: "Repeatable items with their own fields, e.g. FAQ entries or tiles.", icon: Rows3 },
};

export const ITEM_FIELD_TYPES = FIELD_TYPES.filter((t) => t !== "blocks" && t !== "list");

export const isLocalizable = (type: FieldType) => type === "text" || type === "richText";
export const hasPlaceholder = (type: FieldType) => type === "text" || type === "richText" || type === "number";
export const hasDefault = (type: FieldType) => ["text", "richText", "number", "boolean", "select", "color", "date"].includes(type);

/** What min and max mean for a type, or null when they mean nothing. */
export const rangeOf = (type: FieldType): { kind: "value" | "length" | "count"; min: string; max: string; hint: string } | null => {
  if (type === "number") return { kind: "value", min: "Minimum", max: "Maximum", hint: "Checked when a page is published." };
  if (type === "text") return { kind: "length", min: "Min length", max: "Max length", hint: "Characters; the maximum is checked when a page is published." };
  if (type === "blocks" || type === "list" || type === "products") return { kind: "count", min: "Min items", max: "Max items", hint: "How many entries, checked when a page is published." };
  return null;
};

export const INSPECTOR_GROUPS = ["Content", "Style", "Settings"] as const;

// ---------------------------------------------------------------- drafts

/** The editor's working copy. Empty strings mean "not set". */
export type DraftDefinition = {
  code: string;
  kind: ComponentKind;
  name: string;
  description: string;
  groupName: string;
  icon: string;
  previewImageUrl: string;
  fields: FieldDefinition[];
  variations: Variation[];
  /** Content types only. These two save as off while it is a template or holds sections. */
  routable: boolean;
  singleton: boolean;
  /** Content types: a template for product or category pages. Components: shows that data. */
  templateFor: TemplateFor | null;
  /** Content types only: each page holds one product's or category's own sections. */
  sectionsFor: TemplateFor | null;
};

/** A definition as componentsSync accepts it and `pnpm components pull` writes it. */
export type DefinitionJson = {
  code: string;
  kind: "component" | "content_type";
  name: string;
  description?: string;
  groupName?: string;
  icon?: string;
  previewImageUrl?: string;
  fields: FieldDefinition[];
  variations: Variation[];
  routable?: boolean;
  singleton?: boolean;
  templateFor?: "product" | "category";
  sectionsFor?: "product" | "category";
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The order keys are written in, so previews and exports read the same way every time. */
const FIELD_KEYS = ["key", "type", "label", "description", "required", "localized", "group", "variations", "placeholder", "multiline", "options", "min", "max", "allowedComponents", "fields", "defaultValue"] as const;

/** A field from the API (jsonb does not keep key order) in a predictable shape. */
export const normalizeField = (input: unknown): FieldDefinition => {
  const field = isObject(input) ? input : {};
  const out: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    const value = field[key];
    if (value === undefined) continue;
    if (key === "fields") out.fields = asArray(value).map(normalizeField);
    else if (key === "options") out.options = asArray(value).map((o) => (isObject(o) ? { value: String(o.value ?? ""), label: String(o.label ?? "") } : { value: "", label: "" }));
    else out[key] = value;
  }
  out.key = typeof out.key === "string" ? out.key : "";
  out.label = typeof out.label === "string" ? out.label : "";
  out.type = FIELD_TYPES.includes(out.type as FieldType) ? out.type : "text";
  return out as FieldDefinition;
};

export const normalizeVariation = (input: unknown): Variation => {
  const v = isObject(input) ? input : {};
  return {
    code: typeof v.code === "string" ? v.code : "",
    name: typeof v.name === "string" ? v.name : "",
    ...(typeof v.description === "string" ? { description: v.description } : {}),
    ...(typeof v.previewImageUrl === "string" ? { previewImageUrl: v.previewImageUrl } : {}),
  };
};

type ComponentLike = {
  code?: string | null;
  kind?: ComponentKind | null;
  name?: string | null;
  description?: string | null;
  groupName?: string | null;
  icon?: string | null;
  previewImageUrl?: string | null;
  fields?: unknown;
  variations?: unknown;
  routable?: boolean | null;
  singleton?: boolean | null;
  templateFor?: TemplateFor | null;
  sectionsFor?: TemplateFor | null;
};

export const toDraft = (c: ComponentLike): DraftDefinition => ({
  code: c.code ?? "",
  kind: c.kind ?? "COMPONENT",
  name: c.name ?? "",
  description: c.description ?? "",
  groupName: c.groupName ?? "",
  icon: c.icon ?? "",
  previewImageUrl: c.previewImageUrl ?? "",
  fields: asArray(c.fields).map(normalizeField),
  variations: asArray(c.variations).map(normalizeVariation),
  routable: c.kind === "CONTENT_TYPE" ? (c.routable ?? true) : false,
  singleton: c.kind === "CONTENT_TYPE" ? (c.singleton ?? false) : false,
  templateFor: c.templateFor ?? null,
  sectionsFor: c.kind === "CONTENT_TYPE" ? (c.sectionsFor ?? null) : null,
});

/** Templates and section holders have no path and aren't singletons, whatever their switches say. */
const isPathless = (draft: DraftDefinition) => draft.kind === "CONTENT_TYPE" && !!(draft.templateFor || draft.sectionsFor);

export const emptyDraft = (kind: ComponentKind): DraftDefinition => toDraft({ kind, routable: kind === "CONTENT_TYPE", singleton: false });

/** A new field with the settings its type needs to be valid. */
export const newField = (type: FieldType): FieldDefinition => ({
  key: "",
  type,
  label: "",
  ...(type === "select" ? { options: [] } : {}),
  ...(type === "list" ? { fields: [] } : {}),
  ...(isLocalizable(type) ? { localized: true } : {}),
});

/** A field as it is saved: trimmed, without settings its type ignores. Arrays keep their indices. */
export const cleanField = (field: FieldDefinition): FieldDefinition => {
  const type = field.type;
  const out: FieldDefinition = { key: field.key.trim(), type, label: field.label.trim() };
  const description = field.description?.trim();
  if (description) out.description = description;
  if (field.required) out.required = true;
  if (field.localized && isLocalizable(type)) out.localized = true;
  const group = field.group?.trim();
  if (group) out.group = group;
  if (field.variations?.length) out.variations = [...field.variations];
  const placeholder = field.placeholder?.trim();
  if (placeholder && hasPlaceholder(type)) out.placeholder = placeholder;
  if (field.multiline && type === "text") out.multiline = true;
  if (type === "select") out.options = (field.options ?? []).map((o) => ({ value: o.value.trim(), label: o.label.trim() }));
  if (rangeOf(type)) {
    if (isNumber(field.min)) out.min = field.min;
    if (isNumber(field.max)) out.max = field.max;
  }
  if (type === "blocks" && field.allowedComponents?.length) out.allowedComponents = [...field.allowedComponents];
  if (type === "list") out.fields = (field.fields ?? []).map(cleanField);
  if (field.defaultValue !== undefined && hasDefault(type)) out.defaultValue = field.defaultValue;
  return out;
};

export const cleanVariation = (v: Variation): Variation => ({
  code: v.code.trim(),
  name: v.name.trim(),
  ...(v.description?.trim() ? { description: v.description.trim() } : {}),
  ...(v.previewImageUrl?.trim() ? { previewImageUrl: v.previewImageUrl.trim() } : {}),
});

export const kindValue = (kind: ComponentKind) => (kind === "CONTENT_TYPE" ? "content_type" : "component");

export const toDefinitionJson = (draft: DraftDefinition): DefinitionJson => ({
  code: draft.code.trim(),
  kind: kindValue(draft.kind),
  name: draft.name.trim(),
  ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
  ...(draft.groupName.trim() ? { groupName: draft.groupName.trim() } : {}),
  ...(draft.icon.trim() ? { icon: draft.icon.trim() } : {}),
  ...(draft.previewImageUrl.trim() ? { previewImageUrl: draft.previewImageUrl.trim() } : {}),
  fields: draft.fields.map(cleanField),
  variations: draft.variations.map(cleanVariation),
  ...(draft.kind === "CONTENT_TYPE" ? { routable: draft.routable && !isPathless(draft), singleton: draft.singleton && !isPathless(draft) } : {}),
  ...(draft.templateFor ? { templateFor: draft.templateFor === "PRODUCT" ? ("product" as const) : ("category" as const) } : {}),
  ...(draft.kind === "CONTENT_TYPE" && draft.sectionsFor ? { sectionsFor: draft.sectionsFor === "PRODUCT" ? ("product" as const) : ("category" as const) } : {}),
});

/** componentCreate/componentUpdate input. Empty optional text is sent as null, which clears it. */
export const toComponentInput = (draft: DraftDefinition, creating: boolean) => {
  const json = toDefinitionJson(draft);
  return {
    ...(creating ? { code: json.code, kind: draft.kind } : {}),
    name: json.name,
    description: json.description ?? null,
    groupName: json.groupName ?? null,
    icon: json.icon ?? null,
    previewImageUrl: json.previewImageUrl ?? null,
    fields: json.fields,
    variations: json.variations,
    routable: draft.kind === "CONTENT_TYPE" && draft.routable && !isPathless(draft),
    singleton: draft.kind === "CONTENT_TYPE" && draft.singleton && !isPathless(draft),
    // Null makes it neither a template nor bound to product or category data.
    templateFor: draft.templateFor,
    sectionsFor: draft.kind === "CONTENT_TYPE" ? draft.sectionsFor : null,
  };
};

/** Keeps the settings that still apply to the new type. */
export const retypeField = (field: FieldDefinition, type: FieldType): FieldDefinition => {
  if (field.type === type) return field;
  const out: FieldDefinition = { key: field.key, type, label: field.label };
  if (field.description) out.description = field.description;
  if (field.required) out.required = true;
  if (field.group) out.group = field.group;
  if (field.variations?.length) out.variations = field.variations;
  if (field.localized && isLocalizable(type)) out.localized = true;
  if (field.placeholder && hasPlaceholder(type)) out.placeholder = field.placeholder;
  if (field.multiline && type === "text") out.multiline = true;
  if (type === "select") out.options = field.options ?? [];
  if (rangeOf(type) && rangeOf(type)?.kind === rangeOf(field.type)?.kind) {
    if (field.min !== undefined) out.min = field.min;
    if (field.max !== undefined) out.max = field.max;
  }
  if (type === "blocks" && field.allowedComponents) out.allowedComponents = field.allowedComponents;
  if (type === "list") out.fields = field.fields ?? [];
  return out;
};

// ---------------------------------------------------------------- names

const ascii = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** "Product grid" → "product_grid": the code rules (2–48 characters, starting with a letter). */
export const toCode = (name: string) => {
  let code = ascii(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (code && !/^[a-z]/.test(code)) code = `c_${code}`;
  return code.slice(0, 48).replace(/_+$/, "");
};

/** "Button label" → "buttonLabel": the field key rules. */
export const toKey = (label: string) => {
  const words = ascii(label).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let key = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  if (key && !/^[a-z]/.test(key)) key = /^[A-Z]/.test(key) ? key.charAt(0).toLowerCase() + key.slice(1) : `f${key}`;
  return key.slice(0, 48);
};

/** "Full bleed" → "full_bleed", for select option values. */
export const toOptionValue = (label: string) => ascii(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);

/** `base`, or `base2`, `base3`… whichever is free. */
export const uniqueName = (base: string, taken: readonly string[]) => {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
};

// ---------------------------------------------------------------- list helpers

export const move = <T>(list: readonly T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

/** Stable React keys for immutably edited objects; `keepUid` passes a key on to the replacement. */
const uids = new WeakMap<object, string>();
let lastUid = 0;
export const uidOf = (value: object) => {
  let id = uids.get(value);
  if (!id) {
    id = `u${(lastUid += 1)}`;
    uids.set(value, id);
  }
  return id;
};
export const keepUid = <T extends object>(from: object, to: T): T => {
  uids.set(to, uidOf(from));
  return to;
};

// ---------------------------------------------------------------- validation

/** A problem at a path such as ["fields", "2", "key"]; `missing` ones show after a save attempt. */
export type Issue = { path: string[]; message: string; missing?: boolean };

export const pathKey = (path: readonly (string | number)[]) => path.map(String).join(".");
export const issueAt = (issues: readonly Issue[], path: readonly (string | number)[]) => issues.find((i) => pathKey(i.path) === pathKey(path))?.message;
export const issuesUnder = (issues: readonly Issue[], prefix: readonly (string | number)[]) => issues.filter((i) => prefix.every((p, j) => i.path[j] === String(p)));

/**
 * An API field error path relative to the definition. componentCreate/Update report
 * ["input", "fields", "2", "key"]; unknown allowed components come as ["input", "0", "fields", …].
 */
export const definitionPath = (path: readonly string[]) => {
  let rest = path[0] === "input" ? path.slice(1) : [...path];
  if (/^\d+$/.test(rest[0] ?? "") && rest[1] === "fields") rest = rest.slice(1);
  return rest;
};

export const CODE_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
export const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,47}$/;
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
export const CODE_HINT = "2–48 lowercase letters, digits and underscores, starting with a letter";
export const KEY_HINT = "Start with a lowercase letter; letters, digits and underscores (camelCase)";

type ValidateContext = {
  /** Codes in the library, to check new codes and allowed components. */
  library: readonly { code: string; kind: ComponentKind }[];
  creating: boolean;
};

const defaultProblem = (field: FieldDefinition): string | null => {
  const value = field.defaultValue;
  if (value === undefined) return null;
  switch (field.type) {
    case "text":
    case "richText": {
      if (field.localized) {
        if (!isObject(value) || !Object.values(value).every((v) => typeof v === "string")) return "Expected text per language";
        if (field.type === "text" && field.max != null && Object.values(value).some((v) => String(v).length > field.max!)) return `At most ${field.max} characters`;
        return null;
      }
      if (typeof value !== "string") return "Expected text";
      return field.type === "text" && field.max != null && value.length > field.max ? `At most ${field.max} characters` : null;
    }
    case "number":
      if (!isNumber(value)) return "Expected a number";
      if (field.min != null && value < field.min) return `At least ${field.min}`;
      if (field.max != null && value > field.max) return `At most ${field.max}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "Expected on or off";
    case "select":
      return typeof value === "string" && (field.options ?? []).some((o) => o.value === value) ? null : "Pick one of the options";
    case "color":
      return typeof value === "string" && COLOR_PATTERN.test(value) ? null : "Use a hex color such as #1f2937";
    case "date":
      return typeof value === "string" && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) ? null : "Expected a date";
    default:
      return null;
  }
};

/** The API's componentDefinitionSchema and unknown-component check, on the cleaned definition. */
export const validateDefinition = (draft: DraftDefinition, context: ValidateContext): Issue[] => {
  const def = toDefinitionJson(draft);
  const issues: Issue[] = [];
  const add = (path: (string | number)[], message: string, missing = false) => issues.push({ path: path.map(String), message, ...(missing ? { missing } : {}) });
  const known = new Set([...context.library.map((c) => c.code), def.code]);

  if (context.creating) {
    if (!def.code) add(["code"], "Required", true);
    else if (!CODE_PATTERN.test(def.code)) add(["code"], CODE_HINT);
    else if (context.library.some((c) => c.code === def.code)) add(["code"], `A component ${def.code} already exists`);
  }
  if (!def.name) add(["name"], "Required", true);
  else if (def.name.length > 120) add(["name"], "At most 120 characters");
  if ((def.description ?? "").length > 1000) add(["description"], "At most 1000 characters");
  if ((def.groupName ?? "").length > 60) add(["groupName"], "At most 60 characters");
  if ((def.icon ?? "").length > 60) add(["icon"], "At most 60 characters");
  if ((def.previewImageUrl ?? "").length > 2000) add(["previewImageUrl"], "At most 2000 characters");

  const variationCodes = new Set(def.variations.map((v) => v.code));
  const checkFields = (fields: FieldDefinition[], path: (string | number)[], nested: boolean) => {
    const seen = new Set<string>();
    fields.forEach((field, i) => {
      const at = [...path, i];
      if (!field.key) add([...at, "key"], "Required", true);
      else if (!KEY_PATTERN.test(field.key)) add([...at, "key"], KEY_HINT);
      else if (seen.has(field.key)) add([...at, "key"], `Duplicate field key ${field.key}`);
      seen.add(field.key);
      if (!field.label) add([...at, "label"], "Required", true);
      else if (field.label.length > 120) add([...at, "label"], "At most 120 characters");
      if (nested && (field.type === "blocks" || field.type === "list")) add([...at, "type"], "List items cannot hold blocks or lists");
      if ((field.description ?? "").length > 500) add([...at, "description"], "At most 500 characters");
      if ((field.group ?? "").length > 40) add([...at, "group"], "At most 40 characters");
      if ((field.placeholder ?? "").length > 200) add([...at, "placeholder"], "At most 200 characters");
      if (field.type === "select") {
        const options = field.options ?? [];
        if (!options.length) add([...at, "options"], "A select field needs options", true);
        if (options.length > 100) add([...at, "options"], "At most 100 options");
        const values = new Set<string>();
        options.forEach((o, j) => {
          if (!o.value) add([...at, "options", j, "value"], "Required", true);
          else if (o.value.length > 100) add([...at, "options", j, "value"], "At most 100 characters");
          else if (values.has(o.value)) add([...at, "options", j, "value"], `Duplicate value ${o.value}`);
          values.add(o.value);
          if (!o.label) add([...at, "options", j, "label"], "Required", true);
          else if (o.label.length > 120) add([...at, "options", j, "label"], "At most 120 characters");
        });
      }
      if (field.type === "list") {
        if (!field.fields?.length) add([...at, "fields"], "A list needs item fields", true);
        else {
          if (field.fields.length > 40) add([...at, "fields"], "At most 40 item fields");
          checkFields(field.fields, [...at, "fields"], true);
        }
      }
      if (field.min != null && field.max != null && field.min > field.max) add([...at, "max"], "Must be at least min");
      if (rangeOf(field.type)?.kind !== "value" && ((field.min != null && field.min < 0) || (field.max != null && field.max < 0))) add([...at, field.min != null && field.min < 0 ? "min" : "max"], "Cannot be negative");
      for (const v of field.variations ?? []) if (!variationCodes.has(v)) add([...at, "variations"], `Unknown variation ${v}`);
      for (const code of field.allowedComponents ?? []) if (!known.has(code)) add([...at, "allowedComponents"], `No component ${code}`);
      const problem = defaultProblem(field);
      if (problem) add([...at, "defaultValue"], problem);
    });
  };
  checkFields(def.fields, ["fields"], false);
  if (def.fields.length > 80) add(["fields"], "At most 80 fields");

  const seenVariations = new Set<string>();
  def.variations.forEach((v, i) => {
    if (!v.code) add(["variations", i, "code"], "Required", true);
    else if (!CODE_PATTERN.test(v.code)) add(["variations", i, "code"], CODE_HINT);
    else if (seenVariations.has(v.code)) add(["variations", i, "code"], `Duplicate variation ${v.code}`);
    seenVariations.add(v.code);
    if (!v.name) add(["variations", i, "name"], "Required", true);
    else if (v.name.length > 120) add(["variations", i, "name"], "At most 120 characters");
    if ((v.description ?? "").length > 500) add(["variations", i, "description"], "At most 500 characters");
  });
  if (def.variations.length > 20) add(["variations"], "At most 20 variations");
  return issues;
};

/** Human-readable location of an issue, e.g. "Fields › Title › Key". */
export const describePath = (draft: DraftDefinition, path: readonly string[]) => {
  const parts: string[] = [];
  let fields: FieldDefinition[] | undefined = draft.fields;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    const next = path[i + 1];
    if (segment === "fields" && next !== undefined && /^\d+$/.test(next)) {
      const field: FieldDefinition | undefined = fields?.[Number(next)];
      parts.push(field ? field.label || field.key || `Field ${Number(next) + 1}` : `Field ${Number(next) + 1}`);
      fields = field?.fields;
      i++;
    } else if (segment === "variations" && next !== undefined && /^\d+$/.test(next) && i === 0) {
      const variation = draft.variations[Number(next)];
      parts.push(`Variation ${variation?.name || variation?.code || Number(next) + 1}`);
      i++;
    } else if (segment === "options" && next !== undefined && /^\d+$/.test(next)) {
      parts.push(`Option ${Number(next) + 1}`);
      i++;
    } else parts.push(PATH_LABELS[segment] ?? segment);
  }
  return parts.join(" › ");
};

const PATH_LABELS: Record<string, string> = {
  code: "Code",
  kind: "Kind",
  templateFor: "Template for",
  sectionsFor: "Its pages are",
  routable: "Has a path",
  singleton: "Singleton",
  name: "Name",
  description: "Description",
  groupName: "Group",
  icon: "Icon",
  previewImageUrl: "Preview image",
  key: "Key",
  label: "Label",
  type: "Type",
  group: "Inspector tab",
  placeholder: "Placeholder",
  options: "Options",
  value: "Value",
  min: "Min",
  max: "Max",
  allowedComponents: "Allowed components",
  variations: "Variations",
  defaultValue: "Default value",
  fields: "Item fields",
};

/** Pasted or uploaded definitions: an array, or { components: [...] } as the CLI accepts. */
export const parseDefinitionsJson = (text: string): { definitions: Record<string, unknown>[] } | { error: string } => {
  if (!text.trim()) return { error: "Paste or upload a JSON file first." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `Not valid JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  const list = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.components) ? parsed.components : null;
  if (!list) return { error: 'Expected an array of definitions, or { "components": [...] }.' };
  if (!list.length) return { error: "The file has no definitions." };
  if (list.length > 500) return { error: `At most 500 definitions at once; this file has ${list.length}.` };
  const bad = list.findIndex((d) => !isObject(d));
  if (bad >= 0) return { error: `Definition ${bad + 1} is not an object.` };
  return { definitions: list as Record<string, unknown>[] };
};

/** Fields as the API returns them, for counts and lookups elsewhere. */
export const fieldsOf = (value: unknown) => asArray(value).filter(isObject) as unknown as FieldDefinition[];
export const variationsOf = (value: unknown) => asArray(value).filter(isObject) as unknown as Variation[];
export type { FieldOption };
