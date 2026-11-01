import { Loader2, Plus, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { COUNTRY_CODES, countryName, languageName } from "@/lib/format";
import { isUploading, mediaAccept, useMediaStorage, useMediaUploads, type MediaAsset, type MediaKind } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

/** A locale's tab is dashed while it has no text. Nothing shows for a single locale. */
export const LocaleTabs = ({ locales, value, current, onSelect }: { locales: readonly string[]; value: Record<string, string>; current: string; onSelect: (locale: string) => void }) =>
  locales.length > 1 ? (
    <div className="flex flex-wrap gap-1">
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          onClick={() => onSelect(locale)}
          title={languageName(locale)}
          className={cn(
            "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
            locale === current ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
            !value[locale]?.trim() && locale !== current && "border-dashed",
          )}
        >
          {locale}
        </button>
      ))}
    </div>
  ) : null;

/** One text per locale. Empty locales fall back to the first, the default, on the storefront. */
export const LocalizedInput = ({
  value,
  onChange,
  locales,
  multiline,
  rows = 6,
  placeholder,
  className,
  invalid,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  locales: readonly string[];
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
  invalid?: boolean;
}) => {
  const [active, setActive] = useState(locales[0] ?? "en-US");
  const current = locales.includes(active) ? active : (locales[0] ?? active);
  const set = (text: string) => onChange({ ...value, [current]: text });
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <LocaleTabs locales={locales} value={value} current={current} onSelect={setActive} />
      {multiline ? (
        <Textarea rows={rows} value={value[current] ?? ""} onChange={(e) => set(e.target.value)} placeholder={current !== locales[0] && value[locales[0]!] ? value[locales[0]!] : placeholder} aria-invalid={invalid} />
      ) : (
        <Input value={value[current] ?? ""} onChange={(e) => set(e.target.value)} placeholder={current !== locales[0] && value[locales[0]!] ? value[locales[0]!] : placeholder} aria-invalid={invalid} />
      )}
    </div>
  );
};

export type MoneyByCurrency = { amount: string; currencyCode: string };

export const MoneyByCurrencyInput = ({ value, onChange, currencies }: { value: MoneyByCurrency[]; onChange: (value: MoneyByCurrency[]) => void; currencies: readonly string[] }) => {
  const unused = currencies.filter((c) => !value.some((v) => v.currencyCode === c));
  return (
    <div className="flex flex-col gap-2">
      {value.map((row, i) => (
        <div key={row.currencyCode + i} className="flex items-center gap-2">
          <NativeSelect className="w-24" value={row.currencyCode} onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, currencyCode: e.target.value } : r)))}>
            {[row.currencyCode, ...unused].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </NativeSelect>
          <Input inputMode="decimal" className="w-36" value={row.amount} placeholder="0.00" onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))} />
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label="Remove amount">
            <Trash2 />
          </Button>
        </div>
      ))}
      {unused.length ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange([...value, { currencyCode: unused[0]!, amount: "" }])}>
          <Plus />
          Add currency
        </Button>
      ) : null}
    </div>
  );
};

const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code), hint: code })).sort((a, b) => a.label.localeCompare(b.label));

export const CountryMultiSelect = ({ value, onChange, placeholder = "Any country" }: { value: string[]; onChange: (value: string[]) => void; placeholder?: string }) => (
  <MultiSelect options={COUNTRY_OPTIONS} value={value} onChange={onChange} placeholder={placeholder} searchPlaceholder="Search countries…" />
);

/** Pretty-printed JSON for payloads, metadata and audit inputs. */
export const JsonView = ({ value, className }: { value: unknown; className?: string }) => (
  <pre className={cn("max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed", className)}>{JSON.stringify(value, null, 2)}</pre>
);

/**
 * Uploads to the media library, straight to storage. Once all files land, calls back for each in
 * the order chosen (the first product image is the main one); failures become toasts.
 */
export const UploadButton = ({
  onUploaded,
  kind,
  label = "Upload",
  multiple,
  disabled,
}: {
  onUploaded: (url: string, asset: MediaAsset) => void;
  /** Accept only images, or only videos. */
  kind?: MediaKind;
  label?: string;
  multiple?: boolean;
  disabled?: boolean;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const storage = useMediaStorage();
  const uploads = useMediaUploads({ kind });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = uploads.uploads.filter(isUploading);
  const total = active.reduce((sum, u) => sum + u.file.size, 0);
  const percent = total ? Math.floor((active.reduce((sum, u) => sum + u.file.size * u.progress, 0) / total) * 100) : 0;
  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={input}
        type="file"
        accept={mediaAccept(storage, kind)}
        multiple={multiple}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={async (event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (!files.length) return;
          const settled = await uploads.add(files);
          if (!mounted.current) return;
          for (const upload of settled) {
            if (upload.asset?.url) onUploaded(upload.asset.url, upload.asset);
            else toast.error(`Couldn't upload ${upload.file.name}`, { description: upload.error ?? undefined });
          }
          uploads.dismiss();
        }}
      />
      <Button type="button" variant="outline" size="sm" disabled={disabled || active.length > 0} onClick={() => input.current?.click()}>
        {active.length ? <Loader2 className="animate-spin" /> : <Upload />}
        {active.length ? <span className="tabular-nums">{active.length > 1 ? `Uploading ${active.length} files · ${percent}%` : `Uploading ${percent}%`}</span> : label}
      </Button>
      {active.length ? (
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel upload" onClick={() => active.forEach((u) => uploads.cancel(u.id))}>
          <X />
        </Button>
      ) : null}
    </span>
  );
};
