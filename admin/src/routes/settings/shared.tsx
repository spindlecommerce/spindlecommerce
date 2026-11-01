import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useListSearch } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { ListSearch } from "@/router";

export const SettingsCard = ({ title, description, action, children, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) => (
  <Card className={className}>
    <CardHeader>
      <div>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </div>
      {action}
    </CardHeader>
    {children}
  </Card>
);

export const CardBody = ({ children, className }: { children: ReactNode; className?: string }) => <CardContent className={className}>{children}</CardContent>;

/** Edit and delete actions for a table row; extra items go in the menu. */
export const RowActions = ({ onEdit, onDelete, deleteLabel = "Delete", children }: { onEdit?: () => void; onDelete?: () => void; deleteLabel?: string; children?: ReactNode }) => (
  <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
    {onEdit ? (
      <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit">
        <Pencil />
      </Button>
    ) : null}
    {onDelete || children ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {children}
          {onDelete ? (
            <DropdownMenuItem destructive onSelect={onDelete}>
              <Trash2 />
              {deleteLabel}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null}
  </div>
);

/** Chips for a short list, collapsing the rest into "+N". */
export const Chips = ({ items, max = 6, empty = "—", className }: { items: readonly string[]; max?: number; empty?: string; className?: string }) =>
  items.length === 0 ? (
    <span className="text-muted-foreground">{empty}</span>
  ) : (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {items.slice(0, max).map((item) => (
        <span key={item} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium">
          {item}
        </span>
      ))}
      {items.length > max ? <span className="px-1 text-[11px] text-muted-foreground">+{items.length - max}</span> : null}
    </span>
  );

/**
 * A grid filter bound to any URL search param (FilterSelect is limited to the shared keys).
 * The root route keeps unknown string params, so these survive reloads and saved views.
 */
export const ParamFilter = ({ param, label, options }: { param: string; label: string; options: readonly { value: string; label: string }[] }) => {
  const [search, setSearch] = useListSearch();
  const value = (search as Record<string, string | undefined>)[param] ?? "";
  const set = (next: string | undefined) => setSearch({ [param]: next } as Partial<ListSearch>);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={value ? "secondary" : "outline"} size="sm" className={cn(value && "border border-primary/30")}>
          {label}
          {value ? <span className="font-normal text-muted-foreground">: {options.find((o) => o.value === value)?.label ?? value}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuCheckboxItem checked={!value} onCheckedChange={() => set(undefined)}>
          Any
        </DropdownMenuCheckboxItem>
        {options.map((o) => (
          <DropdownMenuCheckboxItem key={o.value} checked={value === o.value} onCheckedChange={() => set(o.value)}>
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ---------------------------------------------------------------- money in minor units

/** ISO 4217 minor-unit exponents that differ from 2 (matches src/lib/money.ts). */
const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};
export const exponentOf = (currency: string) => EXPONENTS[currency] ?? 2;

/** Minor units → the decimal string the API's Decimal inputs take: (599, "USD") → "5.99". */
export const minorToDecimal = (minor: number, currency: string) => {
  const exponent = exponentOf(currency);
  return (minor / 10 ** exponent).toFixed(exponent);
};

export const amountsToList = (amounts: Record<string, number> | null | undefined) =>
  Object.entries(amounts ?? {}).map(([currencyCode, minor]) => ({ currencyCode, amount: minorToDecimal(minor, currencyCode) }));

export const formatMinor = (minor: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 10 ** exponentOf(currency));

// ---------------------------------------------------------------- CSV

/** RFC 4180: quoted fields, escaped quotes, CRLF or LF line ends. Drops a BOM and blank lines. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
};

export const readFileText = (file: File) => file.text();

// ---------------------------------------------------------------- locales

export const COMMON_LOCALES = [
  "en-US", "en-GB", "en-CA", "en-AU", "en-IE", "de-DE", "de-AT", "de-CH", "fr-FR", "fr-CA", "fr-BE", "fr-CH", "es-ES", "es-MX", "it-IT", "nl-NL", "nl-BE",
  "pt-PT", "pt-BR", "sv-SE", "da-DK", "nb-NO", "fi-FI", "pl-PL", "cs-CZ", "hu-HU", "ro-RO", "el-GR", "tr-TR", "ja-JP", "ko-KR", "zh-CN", "zh-TW",
];

/** The API's LocalizedString has nullable fields; keep the complete pairs. */
export const localizedPairs = (list: readonly { locale?: string | null; value?: string | null }[] | null | undefined) =>
  (list ?? []).flatMap((l) => (l.locale && l.value != null ? [{ locale: l.locale, value: l.value }] : []));

/** Error message of a react-hook-form field whose value is an object (e.g. per-locale text). */
export const objectFieldError = (error: unknown) => (error as { message?: string } | undefined)?.message;
