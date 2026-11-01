import { LocalizedInput } from "@/components/inputs";
import { Combobox, MultiSelect } from "@/components/ui/combobox";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import type { AttributeType } from "./shared";
import { Swatch } from "./shared";

export type AttributeDef = {
  code: string | null;
  label: string | null;
  type: AttributeType | null;
  isLocalized: boolean | null;
  isRequired: boolean | null;
  unit: string | null;
  options: readonly { code: string | null; label: string | null; swatch: string | null }[] | null;
};

/** Booleans as "true"/"false", multiselect as string[], per-locale text as a record, else a string. */
export type AttributeFormValue = string | string[] | Record<string, string>;

/** The API's AttributeValueData (@oneOf): exactly one field set. */
export type AttributeValueData =
  | { text: string }
  | { localizedText: { locale: string; value: string }[] }
  | { number: number }
  | { boolean: boolean }
  | { option: string }
  | { options: string[] }
  | { date: string }
  | { clear: boolean };

const isLocalizedText = (def: AttributeDef) => (def.type === "TEXT" || def.type === "RICH_TEXT") && !!def.isLocalized;

/** Stored raw value (Product.attributeValues[code]) → form value. */
export const initialAttributeValue = (def: AttributeDef, raw: unknown, defaultLocale: string): AttributeFormValue => {
  if (isLocalizedText(def)) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
    return typeof raw === "string" ? { [defaultLocale]: raw } : {};
  }
  if (def.type === "MULTISELECT") return Array.isArray(raw) ? raw.map(String) : [];
  if (def.type === "BOOLEAN") return raw === true ? "true" : raw === false ? "false" : "";
  if (raw === null || raw === undefined) return "";
  return String(raw);
};

export const isEmptyAttribute = (value: AttributeFormValue | undefined) => {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value).every((v) => !v.trim());
  return value.trim() === "";
};

/** Null when the value is empty. */
export const toAttributeData = (def: AttributeDef, value: AttributeFormValue | undefined): AttributeValueData | null => {
  if (isEmptyAttribute(value)) return null;
  if (isLocalizedText(def)) {
    const record = value as Record<string, string>;
    return { localizedText: Object.entries(record).flatMap(([locale, text]) => (locale && text.trim() ? [{ locale, value: text }] : [])) };
  }
  switch (def.type) {
    case "NUMBER":
      return { number: Number(value) };
    case "BOOLEAN":
      return { boolean: value === "true" };
    case "SELECT":
      return { option: value as string };
    case "MULTISELECT":
      return { options: value as string[] };
    case "DATE":
      return { date: value as string };
    default:
      return { text: value as string };
  }
};

/** Emptied attributes that had a value get `clear`: updates merge, so leaving one out keeps it. */
export const attributeInputs = (defs: readonly AttributeDef[], values: Record<string, AttributeFormValue>, stored: Record<string, unknown> = {}) =>
  defs.flatMap((def) => {
    if (!def.code) return [];
    const data = toAttributeData(def, values[def.code]);
    if (data) return [{ code: def.code, value: data }];
    return stored[def.code] !== undefined && stored[def.code] !== null ? [{ code: def.code, value: { clear: true } as AttributeValueData }] : [];
  });

export const missingRequired = (defs: readonly AttributeDef[], values: Record<string, AttributeFormValue>) =>
  defs.filter((d) => d.isRequired && d.code && isEmptyAttribute(values[d.code])).map((d) => d.label ?? d.code ?? "");

export const AttributeInput = ({
  def,
  value,
  onChange,
  locales,
  invalid,
}: {
  def: AttributeDef;
  value: AttributeFormValue | undefined;
  onChange: (value: AttributeFormValue) => void;
  locales: readonly string[];
  invalid?: boolean;
}) => {
  const options = (def.options ?? []).map((o) => ({ value: o.code ?? "", label: o.label ?? o.code ?? "", icon: <Swatch swatch={o.swatch} /> }));
  if (isLocalizedText(def)) {
    return <LocalizedInput value={(value as Record<string, string>) ?? {}} onChange={onChange} locales={locales} multiline={def.type === "RICH_TEXT"} rows={4} invalid={invalid} />;
  }
  switch (def.type) {
    case "RICH_TEXT":
      return <Textarea rows={4} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />;
    case "NUMBER":
      return (
        <div className="flex items-center gap-2">
          <Input type="number" step="any" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />
          {def.unit ? <span className="text-[13px] text-muted-foreground">{def.unit}</span> : null}
        </div>
      );
    case "BOOLEAN":
      return (
        <NativeSelect value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid}>
          <option value="">Not set</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </NativeSelect>
      );
    case "SELECT":
      return <Combobox options={options} value={(value as string) ?? ""} onChange={onChange} placeholder="Not set" clearable />;
    case "MULTISELECT":
      return <MultiSelect options={options} value={(value as string[]) ?? []} onChange={onChange} placeholder="None selected" />;
    case "DATE":
      return <Input type="date" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />;
    default:
      return <Input value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} />;
  }
};
