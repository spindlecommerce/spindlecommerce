import { z } from "zod";
import { ValidationError, type FieldError } from "../../lib/errors.ts";
import type { AnyPluginDefinition, NumberField, SettingField, SettingsShape } from "../../plugins/sdk.ts";

export type Env = Record<string, string | undefined>;

/** In order of precedence. */
export type SettingSource = "env" | "admin" | "default" | "unset";

/** The plugin_settings row, secrets decrypted. */
export type StoredSettings = { values: Record<string, unknown>; secrets: Record<string, string> };

export type ResolvedSettings = {
  /** Every key; undefined when unset. Secrets included: server-side only. */
  values: Record<string, unknown>;
  sources: Record<string, SettingSource>;
  /** Required settings without a value: the plugin is not configured until there are none. */
  missing: string[];
};

const MAX_TEXT = 10_000;

/** Casts, since `settings` is loosely typed on AnyPluginDefinition. */
export const settingsOf = (definition: AnyPluginDefinition): SettingsShape => (definition.settings ?? {}) as SettingsShape;

const numberSchema = (field: NumberField) => {
  let schema = field.integer ? z.number().int() : z.number();
  if (field.min !== undefined) schema = schema.min(field.min);
  if (field.max !== undefined) schema = schema.max(field.max);
  return schema;
};

/** A setting's value as stored and as plugin code sees it. */
export const fieldSchema = (field: SettingField): z.ZodType => {
  switch (field.type) {
    case "string":
      return z.string().max(MAX_TEXT);
    case "secret":
      return z.string().min(1).max(MAX_TEXT);
    case "boolean":
      return z.boolean();
    case "number":
      return numberSchema(field);
    case "select":
      return z.enum(field.options.map((o) => o.value) as [string, ...string[]], { error: `Use one of ${field.options.map((o) => o.value).join(", ")}` });
  }
};

/** From a form or an environment variable, where numbers and booleans may be strings. */
const inputSchema = (field: SettingField): z.ZodType => {
  if (field.type === "number") return z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, "Enter a number").transform(Number)]).pipe(numberSchema(field));
  if (field.type === "boolean") {
    return z.union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no", "on", "off"]).transform((v) => ["true", "1", "yes", "on"].includes(v))]);
  }
  return fieldSchema(field);
};

/** Every key optional; null clears. */
export const settingsSchema = (shape: SettingsShape) =>
  z.object(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, inputSchema(field).nullable().optional()])));

const hasDefault = (field: SettingField): field is SettingField & { default: unknown } => "default" in field && field.default !== undefined;
export const isRequired = (field: SettingField) => "required" in field && field.required === true;

/**
 * Precedence: a non-empty environment variable, the stored value, the default. Values that no
 * longer fit the field are skipped with a warning.
 */
export const resolveSettings = (shape: SettingsShape, stored: StoredSettings, env: Env, warn: (message: string) => void): ResolvedSettings => {
  const values: Record<string, unknown> = {};
  const sources: Record<string, SettingSource> = {};
  const missing: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    let value: unknown;
    let source: SettingSource = "unset";
    const raw = field.env ? env[field.env]?.trim() : undefined;
    if (raw) {
      const parsed = inputSchema(field).safeParse(raw);
      if (parsed.success) [value, source] = [parsed.data, "env"];
      else warn(`${field.env} is not a valid value for the setting ${key}; ignored`);
    }
    if (source === "unset") {
      const saved = field.type === "secret" ? stored.secrets[key] : stored.values[key];
      if (saved !== undefined && saved !== null) {
        if (fieldSchema(field).safeParse(saved).success) [value, source] = [saved, "admin"];
        else warn(`the stored value of the setting ${key} no longer fits it; ignored`);
      }
    }
    if (source === "unset" && hasDefault(field)) [value, source] = [field.default, "default"];
    if (source === "unset" && field.type === "boolean") [value, source] = [false, "default"];
    values[key] = value;
    sources[key] = source;
    if (value === undefined && isRequired(field)) missing.push(key);
  }
  return { values, sources, missing };
};

/**
 * A value sets, null clears, a missing key keeps. An empty string clears text but keeps a secret,
 * since forms show secrets blank. Settings supplied by their environment variable refuse changes.
 */
export const applySettingsUpdate = (
  shape: SettingsShape,
  stored: StoredSettings,
  input: unknown,
  current: ResolvedSettings,
  basePath: string[] = ["input", "settings"],
): StoredSettings => {
  if (input === undefined || input === null) return stored;
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("The input is invalid", [{ path: basePath, message: "Settings are an object of values by key" }]);
  const errors: FieldError[] = [];
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = shape[key];
    if (!field) {
      errors.push({ path: [...basePath, key], message: "Unknown setting" });
      continue;
    }
    if (value === undefined || (value === "" && field.type === "secret")) continue;
    changes[key] = value === "" ? null : value;
  }
  const parsed = settingsSchema(shape).safeParse(changes);
  if (!parsed.success) for (const issue of parsed.error.issues) errors.push({ path: [...basePath, ...issue.path.map(String)], message: issue.message });
  const next: StoredSettings = { values: { ...stored.values }, secrets: { ...stored.secrets } };
  if (parsed.success) {
    for (const [key, value] of Object.entries(parsed.data as Record<string, unknown>)) {
      const field = shape[key]!;
      if (value !== null && current.sources[key] === "env") {
        // A form may post every field back: the value it shows is no change.
        if (field.type !== "secret" && value === current.values[key]) continue;
        errors.push({ path: [...basePath, key], message: `Set by the environment variable ${field.env}; change it there` });
        continue;
      }
      const target: Record<string, unknown> = field.type === "secret" ? next.secrets : next.values;
      if (value === null) delete target[key];
      else target[key] = value;
    }
  }
  if (errors.length) throw new ValidationError("The settings are invalid", errors);
  return next;
};
