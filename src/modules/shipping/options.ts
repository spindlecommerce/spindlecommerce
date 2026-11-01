import { ValidationError, type FieldError } from "../../lib/errors.ts";
import type { SettingField, SettingsShape } from "../../plugins/sdk.ts";

const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const parseOption = (field: SettingField, raw: unknown): { value: unknown } | { error: string } => {
  if (blank(raw)) {
    if ("default" in field && field.default !== undefined) return { value: field.default };
    if (field.type === "boolean") return { value: false };
    return "required" in field && field.required ? { error: "Required" } : { value: undefined };
  }
  switch (field.type) {
    case "boolean":
      if (typeof raw === "boolean") return { value: raw };
      return raw === "true" || raw === "false" ? { value: raw === "true" } : { error: "Expected true or false" };
    case "number": {
      // Form fields may send numbers as text.
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(n)) return { error: "Expected a number" };
      if (field.integer && !Number.isInteger(n)) return { error: "Expected a whole number" };
      if (field.min !== undefined && n < field.min) return { error: `At least ${field.min}` };
      if (field.max !== undefined && n > field.max) return { error: `At most ${field.max}` };
      return { value: n };
    }
    case "select":
      return field.options.some((o) => o.value === raw) ? { value: raw } : { error: `One of ${field.options.map((o) => o.value).join(", ")}` };
    case "string":
    case "secret":
      if (typeof raw !== "string") return { error: "Expected text" };
      return raw.length > 10_000 ? { error: "At most 10000 characters" } : { value: raw };
  }
};

/**
 * Checks a shipping method's provider options like plugin settings: unknown keys are dropped and
 * blank ones take their default. Numbers and booleans may arrive as text from forms.
 */
export const parseProviderOptions = (shape: SettingsShape, raw: unknown, path: string[]): Record<string, unknown> => {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const errors: FieldError[] = [];
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const result = parseOption(field, input[key]);
    if ("error" in result) errors.push({ path: [...path, key], message: result.error });
    else if (result.value !== undefined) values[key] = result.value;
  }
  if (errors.length) throw new ValidationError("Invalid provider options", errors);
  return values;
};
