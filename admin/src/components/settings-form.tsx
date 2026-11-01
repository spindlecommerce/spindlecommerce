import { useId, type ReactNode } from "react";
import { Field } from "@/components/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { MutationError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * A setting as SettingsForm renders it; the API's PluginSetting fits as is. SettingsForm is
 * controlled: start `values` from `initialSettingValues(fields)`, pass `errors` as
 * `{ ...validateSettings(fields, values), ...settingsErrors(error) }`, and save
 * `changedSettings(fields, initial, values)`.
 *
 * Values are strings ("" for none), numbers or null, and booleans. Secrets are write-only:
 * undefined keeps the stored one, a string replaces it, null clears it. Fields set by an
 * environment variable are read-only.
 */
export type SettingDescriptor = {
  key: string;
  label: string;
  description?: string | null;
  /** string, secret, boolean, number or select, in any case (the API's enum is upper case). */
  type: string;
  required?: boolean | null;
  options?: readonly { value: string; label: string }[] | null;
  placeholder?: string | null;
  multiline?: boolean | null;
  min?: number | null;
  max?: number | null;
  integer?: boolean | null;
  /** Used while no value is set. With `source: "DEFAULT"`, `value` is taken as the default. */
  default?: unknown;
  /** The stored value; never a secret's. */
  value?: unknown;
  /** Whether a secret is stored. */
  isSet?: boolean | null;
  /** ADMIN (saved here), ENV, DEFAULT or UNSET; when absent, `value` is saved here. */
  source?: string | null;
  /** The environment variable that can supply the value instead. */
  env?: string | null;
};

type Kind = "string" | "secret" | "boolean" | "number" | "select";

const kindOf = (field: SettingDescriptor): Kind => {
  const kind = field.type.toLowerCase();
  return kind === "secret" || kind === "boolean" || kind === "number" || kind === "select" ? kind : "string";
};
const sourceOf = (field: SettingDescriptor) => field.source?.toUpperCase() ?? null;
/** Set by an environment variable on the server: shown here, changed there. */
const fromEnv = (field: SettingDescriptor) => sourceOf(field) === "ENV";
const defaultOf = (field: SettingDescriptor) => (field.default !== undefined && field.default !== null ? field.default : sourceOf(field) === "DEFAULT" ? field.value : undefined);
const blank = (value: unknown) => value === undefined || value === null || value === "";

/** Values to edit, from the stored ones; defaults and environment values start empty. */
export const initialSettingValues = (fields: readonly SettingDescriptor[]): Record<string, unknown> =>
  Object.fromEntries(
    fields.map((field) => {
      const own = sourceOf(field) === null || sourceOf(field) === "ADMIN" ? field.value : undefined;
      switch (kindOf(field)) {
        case "secret":
          return [field.key, undefined];
        case "boolean":
          // A switch always shows a state: the one in effect.
          return [field.key, typeof field.value === "boolean" ? field.value : defaultOf(field) === true];
        case "number":
          return [field.key, typeof own === "number" ? own : null];
        default:
          return [field.key, blank(own) ? "" : String(own)];
      }
    }),
  );

/** Changed keys only: blanks as null (back to the default), secrets only when replaced or cleared. */
export const changedSettings = (fields: readonly SettingDescriptor[], initial: Record<string, unknown>, values: Record<string, unknown>) => {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    if (fromEnv(field) || !(field.key in values)) continue;
    const value = values[field.key];
    if (kindOf(field) === "secret") {
      // "" is a replacement not typed yet.
      if (value === null || (typeof value === "string" && value !== "")) patch[field.key] = value;
    } else if (!(blank(value) && blank(initial[field.key])) && value !== initial[field.key]) {
      patch[field.key] = blank(value) ? null : value;
    }
  }
  return patch;
};

/** Errors by key: numbers out of range and, with `required`, empty required fields. */
export const validateSettings = (fields: readonly SettingDescriptor[], values: Record<string, unknown>, options: { required?: boolean } = {}) => {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    const kind = kindOf(field);
    if (fromEnv(field)) continue;
    if (kind === "number" && typeof value === "number") {
      if (Number.isNaN(value)) errors[field.key] = "Enter a number";
      else if (field.integer && !Number.isInteger(value)) errors[field.key] = "Enter a whole number";
      else if (field.min != null && value < field.min) errors[field.key] = `At least ${field.min}`;
      else if (field.max != null && value > field.max) errors[field.key] = `At most ${field.max}`;
    }
    const missing = kind === "secret" ? value === null || ((value === undefined || value === "") && !field.isSet) : kind !== "boolean" && blank(value) && defaultOf(field) === undefined;
    if (options.required && field.required && missing) errors[field.key] = "Required";
  }
  return errors;
};

/** Field messages by key from a failed save, for errors at `[...path, key]`. */
export const settingsErrors = (error: unknown, path: readonly string[] = ["input", "settings"]) => {
  const errors: Record<string, string> = {};
  if (!(error instanceof MutationError)) return errors;
  for (const fieldError of error.fieldErrors) {
    const key = fieldError.path[path.length];
    if (key && fieldError.path.length === path.length + 1 && path.every((part, i) => fieldError.path[i] === part)) errors[key] ??= fieldError.message;
  }
  return errors;
};

/** A stored value as text, for fields shown read-only. */
const shown = (field: SettingDescriptor) => {
  if (blank(field.value)) return "";
  if (kindOf(field) === "select") return field.options?.find((o) => o.value === field.value)?.label ?? String(field.value);
  return typeof field.value === "string" ? field.value : JSON.stringify(field.value);
};

export const SettingsForm = ({
  fields,
  values,
  onChange,
  errors = {},
  disabled,
  className,
}: {
  fields: readonly SettingDescriptor[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
  className?: string;
}) => (
  <div className={cn("grid gap-5", className)}>
    {fields.map((field) => (
      <SettingField key={field.key} field={field} value={values[field.key]} onChange={(value) => onChange({ ...values, [field.key]: value })} error={errors[field.key]} disabled={disabled} />
    ))}
  </div>
);

const SettingField = ({ field, value, onChange, error, disabled }: { field: SettingDescriptor; value: unknown; onChange: (value: unknown) => void; error?: string; disabled?: boolean }) => {
  const kind = kindOf(field);
  const env = fromEnv(field);
  const fallback = defaultOf(field);
  const label = (
    <>
      {field.label}
      {env && field.env ? (
        <Badge variant="outline" className="font-mono font-normal" title="Set by this environment variable on the server">
          {field.env}
        </Badge>
      ) : null}
    </>
  );
  const hint: ReactNode =
    field.description || field.env ? (
      <>
        {field.description}
        {field.description && field.env ? " " : null}
        {field.env ? (env ? `Set on the server by ${field.env}; change it there.` : `The server's ${field.env} variable, when set, takes its place.`) : null}
      </>
    ) : undefined;

  if (kind === "boolean") return <BooleanField field={field} value={value} onChange={onChange} error={error} disabled={disabled || env} label={label} hint={hint} />;

  const placeholder = fallback !== undefined && kind !== "select" ? String(fallback) : (field.placeholder ?? undefined);
  let control: ReactNode;
  if (kind === "secret") control = <SecretControl field={field} value={value} onChange={onChange} disabled={disabled} env={env} />;
  else if (env) control = <Input value={shown(field)} readOnly className="text-muted-foreground" />;
  else if (kind === "number")
    control = (
      <Input
        type="number"
        inputMode="decimal"
        step={field.integer ? 1 : "any"}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        value={typeof value === "number" && !Number.isNaN(value) ? value : ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.valueAsNumber)}
        placeholder={placeholder}
        disabled={disabled}
      />
    );
  else if (kind === "select") {
    const options = field.options ?? [];
    const current = typeof value === "string" ? value : "";
    const empty = fallback !== undefined ? `Default: ${options.find((o) => o.value === fallback)?.label ?? String(fallback)}` : field.required ? "Choose…" : "None";
    control = (
      <NativeSelect value={current} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">{empty}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {current && !options.some((o) => o.value === current) ? <option value={current}>{current}</option> : null}
      </NativeSelect>
    );
  } else if (field.multiline) control = <Textarea rows={4} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />;
  else control = <Input value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />;

  return (
    <Field label={label} required={!!field.required && !env} hint={hint} error={error}>
      {control}
    </Field>
  );
};

const BooleanField = ({ field, value, onChange, error, disabled, label, hint }: { field: SettingDescriptor; value: unknown; onChange: (value: unknown) => void; error?: string; disabled?: boolean; label: ReactNode; hint: ReactNode }) => {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} className="mt-0.5" checked={value === true} onCheckedChange={onChange} disabled={disabled} aria-describedby={error || hint ? `${id}-message` : undefined} aria-invalid={error ? true : undefined} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={id} className="text-[13px]">
          {label}
        </Label>
        {error ? (
          <p id={`${id}-message`} aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p id={`${id}-message`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
};

/** Set or not, with Replace and Clear; leaving a replacement empty keeps the stored value. */
const SecretControl = ({ field, value, onChange, disabled, env }: { field: SettingDescriptor; value: unknown; onChange: (value: unknown) => void; disabled?: boolean; env: boolean }) => {
  const set = !!field.isSet || env;
  if (typeof value === "string" && !env)
    return (
      <div className="flex gap-2">
        <Input type="password" autoComplete="new-password" spellCheck={false} autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={set ? "New value" : undefined} disabled={disabled} />
        <Button type="button" variant="ghost" onClick={() => onChange(undefined)}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value === null ? (
        <Badge variant="warning" dot>
          Cleared when you save
        </Badge>
      ) : (
        <Badge variant={set ? "success" : "secondary"} dot>
          {set ? "Set" : "Not set"}
        </Badge>
      )}
      {disabled || env ? null : value === null ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)} aria-label={`Keep ${field.label}`}>
          Undo
        </Button>
      ) : (
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange("")} aria-label={`${set ? "Replace" : "Set"} ${field.label}`}>
            {set ? "Replace" : "Set"}
          </Button>
          {set ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={`Clear ${field.label}`}>
              Clear
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
};
