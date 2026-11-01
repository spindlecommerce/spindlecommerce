import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  Copy,
  GripVertical,
  ImageIcon,
  Images,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { UploadButton } from "@/components/inputs";
import { MediaPicker } from "@/components/media-picker";
import { RichTextEditor } from "@/components/rich-text";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/overlay";
import { useAuth } from "@/lib/auth";
import { languageName } from "@/lib/format";
import { altsOf, MEDIA_READ, MEDIA_WRITE, type MediaAsset } from "@/lib/media-upload";
import { cn } from "@/lib/utils";
import { cloneWithNewIds, createListItem, textIn, withText, type FieldDefinition, type ImageValue, type LinkValue, type ListItem, type PageNode } from "../model";
import { useReferenceNames } from "./api";
import { CategoryPicker, ClearButton, PagePicker, ProductPicker, ProductSearchPopover, Thumb } from "./pickers";
import { COLOR_PATTERN, fallbackText, filledLocales, IMAGE_URL_PATTERN, isLink, isObject, LINK_URL_PATTERN, listItemLabel } from "./util";

/**
 * Controlled editors, one per field type. `onChange` takes a value or an updater of the latest;
 * `undefined` clears. Half-typed URLs, colors and numbers stay local until they're valid.
 */

export type ValueChange = (value: unknown) => void;

export type ValueEditorProps = {
  field: FieldDefinition;
  value: unknown;
  onChange: ValueChange;
  locale: string;
  locales: readonly string[];
  invalid?: boolean;
  id?: string;
  /** Text fields: the text as typed, for instant preview updates. */
  onText?: (text: string) => void;
  /** Lists: the path to focus ("items"), problems by "itemId.subField", the item to open. */
  focusPath?: string;
  errors?: ReadonlyMap<string, string>;
  errorPrefix?: string;
  openItem?: string | null;
  onItemText?: (itemId: string, subKey: string, text: string) => void;
  onLocale?: (locale: string) => void;
};

const emptyToUndefined = (value: Record<string, string>) => (Object.keys(value).length ? value : undefined);

/** Local text for values that are only stored once valid; follows outside changes (undo). */
const useDraft = (stored: string) => {
  const [draft, setDraft] = useState(stored);
  const last = useRef(stored);
  useEffect(() => {
    if (stored !== last.current) {
      last.current = stored;
      setDraft(stored);
    }
  }, [stored]);
  return [draft, setDraft, (committed: string) => (last.current = committed)] as const;
};

// ---------------------------------------------------------------- field chrome

/** Which locales have text; the current one is ringed. Clicking one edits it. */
export const LocaleDots = ({ value, locale, locales, onLocale }: { value: unknown; locale: string; locales: readonly string[]; onLocale?: (locale: string) => void }) => {
  if (locales.length < 2) return null;
  const filled = new Set(filledLocales(value));
  return (
    <span className="ml-auto flex items-center gap-0.5">
      {locales.map((l) => (
        <Tooltip key={l} content={`${languageName(l)}${filled.has(l) ? "" : " · empty"}`}>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onLocale?.(l)}
            className={cn(
              "rounded px-1 py-px font-mono text-[10px] leading-4 transition-colors",
              filled.has(l) ? "bg-muted text-foreground/80" : "text-muted-foreground/60 line-through decoration-muted-foreground/30",
              l === locale && "bg-primary/12 text-primary ring-1 ring-primary/40",
            )}
          >
            {l.split("-")[0]}
            {locales.filter((o) => o.split("-")[0] === l.split("-")[0]).length > 1 ? `-${l.split("-")[1] ?? ""}` : ""}
          </button>
        </Tooltip>
      ))}
    </span>
  );
};

export const FieldShell = ({
  label,
  required,
  description,
  error,
  path,
  htmlFor,
  aside,
  children,
  inline,
  className,
}: {
  label: ReactNode;
  required?: boolean;
  description?: ReactNode;
  error?: string | null;
  path: string;
  htmlFor?: string;
  aside?: ReactNode;
  children: ReactNode;
  inline?: boolean;
  className?: string;
}) => (
  <div data-field-path={path} className={cn("scroll-mt-16 rounded-lg transition-[background-color,box-shadow] duration-500 data-[flash=true]:bg-primary/8 data-[flash=true]:ring-4 data-[flash=true]:ring-primary/8", className)}>
    <div className={cn("flex min-h-5 items-center gap-2", inline ? "justify-between" : "mb-1.5")}>
      <Label htmlFor={htmlFor} className="gap-1 text-[13px]">
        {label}
        {required ? <span className="text-destructive" aria-label="required">*</span> : null}
      </Label>
      {aside}
      {inline ? children : null}
    </div>
    {inline ? null : children}
    {error ? (
      <p className="mt-1.5 flex items-start gap-1 text-xs text-destructive">
        <CircleAlert className="mt-px size-3.5 shrink-0" />
        {error}
      </p>
    ) : description ? (
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
    ) : null}
  </div>
);

// ---------------------------------------------------------------- text

const Counter = ({ length, max }: { length: number; max?: number }) =>
  max ? <span className={cn("pointer-events-none absolute right-2 bottom-1.5 text-[10px] tabular-nums text-muted-foreground", length > max && "text-destructive")}>{`${length}/${max}`}</span> : null;

const localText = (field: FieldDefinition, value: unknown, locale: string) => (field.localized ? textIn(value, locale) : typeof value === "string" ? value : textIn(value, locale, true));
const nextText = (field: FieldDefinition, value: unknown, locale: string, text: string) =>
  field.localized ? emptyToUndefined(withText(value, locale, text)) : text === "" ? undefined : text;

const TextEditor = ({ field, value, onChange, locale, locales, invalid, id, onText }: ValueEditorProps) => {
  const text = localText(field, value, locale);
  const placeholder = (field.localized && !text ? fallbackText(value, locale, locales) : "") || field.placeholder || "";
  const set = (next: string) => {
    onChange(nextText(field, value, locale, next));
    onText?.(next);
  };
  const common = { id, value: text, placeholder, "aria-invalid": invalid || undefined, spellCheck: true };
  return (
    <div className="relative">
      {field.multiline ? (
        <Textarea {...common} rows={3} className={cn("min-h-[4.5rem] resize-y", field.max && "pb-5")} onChange={(e) => set(e.target.value)} />
      ) : (
        <Input {...common} className={cn(field.max && "pr-14")} onChange={(e) => set(e.target.value)} />
      )}
      <Counter length={text.length} max={field.max} />
    </div>
  );
};

// ---------------------------------------------------------------- rich text (Markdown)

/** Formatted text, stored as Markdown: the shared editor, one per locale. */
const RichTextField = ({ field, value, onChange, locale, locales, invalid, id }: ValueEditorProps) => {
  const text = localText(field, value, locale);
  const placeholder = (field.localized && !text ? fallbackText(value, locale, locales) : "") || field.placeholder || "Write here: ## for a heading, - for a list, ⌘K for a link";
  return <RichTextEditor key={locale} id={id} value={text} onChange={(next) => onChange(nextText(field, value, locale, next))} format="markdown" placeholder={placeholder} invalid={invalid} rows={5} locale={locale} />;
};

// ---------------------------------------------------------------- number, select, boolean, color, date

const NumberEditor = ({ field, value, onChange, invalid, id }: ValueEditorProps) => {
  const stored = typeof value === "number" ? String(value) : "";
  const [draft, setDraft, committed] = useDraft(stored);
  const parsed = draft.trim() === "" ? null : Number(draft);
  const bad = parsed !== null && !Number.isFinite(parsed);
  const out = parsed !== null && Number.isFinite(parsed) && ((field.min != null && parsed < field.min) || (field.max != null && parsed > field.max));
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        className="w-32"
        min={field.min}
        max={field.max}
        value={draft}
        placeholder={field.placeholder}
        aria-invalid={invalid || bad || out || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const text = e.target.value.trim();
          if (text === "") {
            committed("");
            onChange(undefined);
            return;
          }
          const n = Number(text);
          if (Number.isFinite(n)) {
            committed(String(n));
            onChange(n);
          }
        }}
      />
      {field.min != null || field.max != null ? (
        <span className={cn("text-xs text-muted-foreground", out && "text-destructive")}>{field.min != null && field.max != null ? `${field.min}–${field.max}` : field.min != null ? `at least ${field.min}` : `at most ${field.max}`}</span>
      ) : null}
    </div>
  );
};

const SelectEditor = ({ field, value, onChange, id }: ValueEditorProps) => (
  <Select
    id={id}
    value={typeof value === "string" ? value : ""}
    onValueChange={(v) => onChange(v || undefined)}
    options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
    placeholder={field.placeholder ?? "Choose…"}
    allowEmpty={!field.required}
    emptyLabel="Default"
  />
);

const BooleanEditor = ({ value, onChange, id }: ValueEditorProps) => <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />;

const ColorEditor = ({ value, onChange, invalid, id }: ValueEditorProps) => {
  const stored = typeof value === "string" ? value : "";
  const [draft, setDraft, committed] = useDraft(stored);
  const valid = draft === "" || COLOR_PATTERN.test(draft);
  const commit = (next: string) => {
    setDraft(next);
    if (next === "") {
      committed("");
      onChange(undefined);
    } else if (COLOR_PATTERN.test(next)) {
      committed(next);
      onChange(next);
    }
  };
  // <input type="color"> only takes #rrggbb.
  const swatch = /^#[0-9a-f]{6}$/i.test(stored) ? stored : /^#[0-9a-f]{3}$/i.test(stored) ? `#${[...stored.slice(1)].map((c) => c + c).join("")}` : "#000000";
  return (
    <div className="flex items-center gap-2">
      <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-md border shadow-xs" style={{ background: stored || "transparent" }} title="Pick a color">
        {!stored ? <span className="absolute inset-0 bg-[linear-gradient(45deg,transparent_45%,var(--color-destructive)_45%,var(--color-destructive)_55%,transparent_55%)] opacity-40" /> : null}
        <input type="color" value={swatch} onChange={(e) => commit(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Pick a color" />
      </label>
      <Input id={id} value={draft} placeholder="#1f2937" className="w-32 font-mono" aria-invalid={invalid || !valid || undefined} onChange={(e) => commit(e.target.value.trim())} />
      {!valid ? <span className="text-xs text-destructive">Use a hex color</span> : null}
      {stored ? <ClearButton onClick={() => commit("")} label="Clear color" /> : null}
    </div>
  );
};

const DateEditor = ({ value, onChange, invalid, id }: ValueEditorProps) => (
  <div className="flex items-center gap-1">
    <Input id={id} type="date" className="w-44" value={typeof value === "string" ? value.slice(0, 10) : ""} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value || undefined)} />
    {typeof value === "string" && value ? <ClearButton onClick={() => onChange(undefined)} label="Clear date" /> : null}
  </div>
);

// ---------------------------------------------------------------- image

const asImage = (value: unknown): ImageValue | null => (isObject(value) && typeof value.url === "string" && value.url ? (value as ImageValue) : null);

/** Image dimensions help storefronts reserve space; read them once the image loads. */
const measure = (url: string) =>
  new Promise<{ width: number; height: number } | null>((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });

/** Alt text in any locale; older values keep it as one string. */
const hasAlt = (alt: ImageValue["alt"]) => (typeof alt === "string" ? alt.trim() !== "" : Object.values(alt ?? {}).some((text) => text.trim() !== ""));

export const ImageEditor = ({ value, onChange, locale, locales, invalid, id }: ValueEditorProps) => {
  const { can } = useAuth();
  const image = asImage(value);
  const [draft, setDraft, committed] = useDraft(image?.url ?? "");
  const [broken, setBroken] = useState(false);
  const [picking, setPicking] = useState(false);
  const urlProblem = draft && !IMAGE_URL_PATTERN.test(draft) ? "Use an https:// URL or upload a file" : null;
  useEffect(() => setBroken(false), [image?.url]);

  const measureInto = (url: string) =>
    void measure(url).then((size) => {
      if (size) onChange((current: unknown) => (asImage(current)?.url === url ? { ...asImage(current)!, ...size } : current));
    });
  const setUrl = (url: string) => {
    setDraft(url);
    committed(url);
    if (!url) return onChange(undefined);
    onChange((current: unknown) => ({ ...(asImage(current) ?? {}), url, width: undefined, height: undefined }));
    measureInto(url);
  };
  /** A library image: its URL and size, and its alt text when the field has none yet. */
  const setAsset = (asset: MediaAsset) => {
    const url = asset.url ?? "";
    if (!IMAGE_URL_PATTERN.test(url)) return;
    setDraft(url);
    committed(url);
    onChange((current: unknown) => {
      const previous = asImage(current);
      const alt = previous && hasAlt(previous.alt) ? previous.alt : emptyToUndefined(altsOf(asset, locales));
      return { ...(previous ?? {}), url, alt, width: asset.width ?? undefined, height: asset.height ?? undefined };
    });
    if (!asset.width || !asset.height) measureInto(url);
  };
  const alt = image ? textIn(image.alt, locale, typeof image.alt === "string") : "";
  const altPlaceholder = image && !alt ? fallbackText(image.alt, locale, locales) : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-3">
        <div className={cn("relative flex size-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/60 text-muted-foreground", invalid && "border-destructive")}>
          {image && !broken ? <img src={image.url} alt="" className="size-full object-cover" onError={() => setBroken(true)} /> : <ImageIcon className="size-5" />}
          {image?.width && image.height ? <span className="absolute right-0.5 bottom-0.5 rounded bg-black/55 px-1 text-[9px] text-white tabular-nums">{`${image.width}×${image.height}`}</span> : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Input
            id={id}
            value={draft}
            placeholder="https://… or upload"
            aria-invalid={invalid || !!urlProblem || undefined}
            onChange={(e) => {
              const next = e.target.value.trim();
              setDraft(next);
              if (next === "" || IMAGE_URL_PATTERN.test(next)) setUrl(next);
            }}
            className="h-8 text-[13px]"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {can(MEDIA_WRITE) ? <UploadButton kind="IMAGE" label={image ? "Replace" : "Upload"} onUploaded={(_url, asset) => setAsset(asset)} /> : null}
            {can(MEDIA_READ) ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
                <Images />
                Library
              </Button>
            ) : null}
            {image ? (
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setUrl("")}>
                <Trash2 />
                Remove
              </Button>
            ) : null}
          </div>
          {urlProblem ? <p className="text-xs text-destructive">{urlProblem}</p> : broken ? <p className="text-xs text-warning">The image did not load; check the URL.</p> : null}
        </div>
      </div>
      <MediaPicker open={picking} onOpenChange={setPicking} kind="IMAGE" title={image ? "Replace the image" : "Choose an image"} onSelect={([asset]) => asset && setAsset(asset)} />
      {image ? (
        <div className="relative">
          <Input
            value={alt}
            placeholder={altPlaceholder || "Alt text: describe the image for screen readers"}
            aria-label={`Alt text (${locale})`}
            className="h-8 pr-12 text-[13px]"
            onChange={(e) => onChange({ ...image, alt: typeof image.alt === "string" && locales.length < 2 ? e.target.value || undefined : emptyToUndefined(withText(image.alt, locale, e.target.value)) })}
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground">alt</span>
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------- link

type LinkKind = LinkValue["kind"];
const LINK_KINDS: { value: LinkKind; label: string }[] = [
  { value: "url", label: "URL" },
  { value: "page", label: "Page" },
  { value: "product", label: "Product" },
  { value: "category", label: "Category" },
];

const LinkEditor = ({ value, onChange, invalid, id }: ValueEditorProps) => {
  const link = isLink(value) ? value : null;
  const [kind, setKind] = useState<LinkKind>(link?.kind ?? "url");
  useEffect(() => {
    if (link) setKind(link.kind);
  }, [link?.kind]);
  const [draft, setDraft, committed] = useDraft(link?.kind === "url" ? link.url : "");
  const urlProblem = kind === "url" && draft && !LINK_URL_PATTERN.test(draft) ? "Start with https://, /, #, mailto: or tel:" : null;
  const newTab = link?.newTab ? { newTab: true } : {};
  const setTarget = (id: string | null) => onChange(id ? { kind, id, ...newTab } : undefined);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Select
          aria-label="Link to"
          className="w-[6.5rem] shrink-0"
          value={kind}
          options={LINK_KINDS}
          onValueChange={(next) => {
            setKind(next as LinkKind);
            if (link && link.kind !== next) onChange(undefined);
          }}
        />
        {kind === "url" ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              id={id}
              value={draft}
              placeholder="https://example.com or /path"
              aria-invalid={invalid || !!urlProblem || undefined}
              onChange={(e) => {
                const next = e.target.value.trim();
                setDraft(next);
                if (next === "") {
                  committed("");
                  onChange(undefined);
                } else if (LINK_URL_PATTERN.test(next) && next.length <= 2000) {
                  committed(next);
                  onChange({ kind: "url", url: next, ...newTab });
                }
              }}
            />
            {link ? <ClearButton onClick={() => onChange(undefined)} label="Clear link" /> : null}
          </div>
        ) : kind === "page" ? (
          <PagePicker id={id} value={link?.kind === "page" ? link.id : null} onChange={setTarget} invalid={invalid} />
        ) : kind === "product" ? (
          <ProductPicker id={id} value={link?.kind === "product" ? link.id : null} onChange={setTarget} invalid={invalid} />
        ) : (
          <CategoryPicker value={link?.kind === "category" ? link.id : null} onChange={setTarget} />
        )}
      </div>
      {urlProblem ? <p className="text-xs text-destructive">{urlProblem}</p> : null}
      {link ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch className="scale-90" checked={!!link.newTab} onCheckedChange={(checked) => onChange({ ...link, newTab: checked || undefined })} />
          Open in a new tab
        </label>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------- products and categories

const ProductEditor = ({ value, onChange, invalid, id }: ValueEditorProps) => <ProductPicker id={id} value={typeof value === "string" ? value : null} onChange={(v) => onChange(v ?? undefined)} invalid={invalid} />;

const CategoryEditor = ({ value, onChange }: ValueEditorProps) => <CategoryPicker value={typeof value === "string" ? value : null} onChange={(v) => onChange(v ?? undefined)} />;

const move = <T,>(list: readonly T[], from: number, to: number) => {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

/** Reorder rows by dragging their handle. */
const useRowDrag = (count: number, onMove: (from: number, to: number) => void) => {
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  return {
    over: drag?.over ?? null,
    dragging: drag?.from ?? null,
    row: (index: number) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        if (drag.over !== index) setDrag({ ...drag, over: index });
      },
      onDrop: (e: React.DragEvent) => {
        if (!drag) return;
        e.preventDefault();
        onMove(drag.from, Math.min(index, count - 1));
        setDrag(null);
      },
    }),
    handle: (index: number) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        setDrag({ from: index, over: index });
      },
      onDragEnd: () => setDrag(null),
    }),
  };
};

const ProductsEditor = ({ field, value, onChange }: ValueEditorProps) => {
  const ids = useMemo(() => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []), [value]);
  const { names } = useReferenceNames(ids);
  const full = field.max != null && ids.length >= field.max;
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  const drag = useRowDrag(ids.length, (from, to) => set(move(ids, from, to)));
  return (
    <div className="flex flex-col gap-1.5">
      {ids.length ? (
        <ul className="flex flex-col overflow-hidden rounded-md border">
          {ids.map((pid, i) => {
            const product = names.get(pid);
            return (
              <li key={pid} {...drag.row(i)} className={cn("group flex items-center gap-2 border-b bg-background px-1.5 py-1 last:border-b-0", drag.over === i && drag.dragging !== i && "shadow-[inset_0_2px_0_var(--color-primary)]")}>
                <span {...drag.handle(i)} className="cursor-grab text-muted-foreground/60 hover:text-muted-foreground" aria-label="Drag to reorder">
                  <GripVertical className="size-3.5" />
                </span>
                <Thumb src={product?.image} />
                <span className={cn("min-w-0 flex-1 truncate text-[13px]", product?.missing && "text-destructive")}>{product?.label ?? "Loading…"}</span>
                {product?.hint ? <span className="text-[10px] text-muted-foreground">{product.hint}</span> : null}
                <span className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton label="Move up" disabled={i === 0} onClick={() => set(move(ids, i, i - 1))}>
                    <ArrowUp />
                  </IconButton>
                  <IconButton label="Move down" disabled={i === ids.length - 1} onClick={() => set(move(ids, i, i + 1))}>
                    <ArrowDown />
                  </IconButton>
                  <IconButton label="Remove" onClick={() => set(ids.filter((x) => x !== pid))}>
                    <Trash2 />
                  </IconButton>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <ProductSearchPopover selected={ids} closeOnPick={false} disabled={full} onPick={(pid) => set(ids.includes(pid) ? ids.filter((x) => x !== pid) : [...ids, pid])}>
          <Button type="button" variant="outline" size="sm" disabled={full}>
            <Search />
            {ids.length ? "Add products" : "Choose products"}
          </Button>
        </ProductSearchPopover>
        <span className="text-xs text-muted-foreground">
          {ids.length}
          {field.max != null ? ` / ${field.max}` : ""} selected
        </span>
      </div>
    </div>
  );
};

const IconButton = ({ label, onClick, disabled, children, className }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; className?: string }) => (
  <Tooltip content={label}>
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn("flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5", className)}
    >
      {children}
    </button>
  </Tooltip>
);

// ---------------------------------------------------------------- list

const asItems = (value: unknown): ListItem[] => (Array.isArray(value) ? value.filter((v): v is ListItem => isObject(v) && typeof v.id === "string" && isObject(v.fields)) : []);

const ListItemCard = memo(
  ({
    field,
    item,
    index,
    count,
    open,
    locale,
    locales,
    errors,
    errorPrefix,
    focusPath,
    onToggle,
    onUpdate,
    onItemText,
    onLocale,
    dragRow,
    dragHandle,
    dropIndicator,
  }: {
    field: FieldDefinition;
    item: ListItem;
    index: number;
    count: number;
    open: boolean;
    locale: string;
    locales: readonly string[];
    errors?: ReadonlyMap<string, string>;
    errorPrefix: string;
    focusPath: string;
    onToggle: (id: string) => void;
    onUpdate: (update: (items: ListItem[]) => ListItem[]) => void;
    onItemText?: (itemId: string, subKey: string, text: string) => void;
    onLocale?: (locale: string) => void;
    dragRow: ReturnType<ReturnType<typeof useRowDrag>["row"]>;
    dragHandle: ReturnType<ReturnType<typeof useRowDrag>["handle"]>;
    dropIndicator: boolean;
  }) => {
    const baseId = useId();
    const label = listItemLabel(field, item, locale, index);
    const subErrors = (field.fields ?? []).filter((sub) => errors?.get(`${errorPrefix}${item.id}.${sub.key}`));
    const ownError = errors?.get(`${errorPrefix}${item.id}`);
    const thumb = (field.fields ?? []).find((sub) => sub.type === "image" && asImage(item.fields[sub.key]));
    const set = (sub: FieldDefinition) => (next: unknown) =>
      onUpdate((items) =>
        items.map((it) => {
          if (it.id !== item.id) return it;
          const value = typeof next === "function" ? (next as (current: unknown) => unknown)(it.fields[sub.key]) : next;
          const fields = { ...it.fields, [sub.key]: value };
          if (value === undefined) delete fields[sub.key];
          return { ...it, fields };
        }),
      );
    return (
      <li {...dragRow} data-field-path={`${focusPath}.${item.id}`} className={cn("rounded-md border bg-background shadow-xs transition-shadow", open && "ring-1 ring-primary/15", dropIndicator && "shadow-[0_-2px_0_var(--color-primary)]")}>
        <div className="group flex items-center gap-1 px-1 py-1">
          <span {...dragHandle} className="cursor-grab px-0.5 text-muted-foreground/50 hover:text-muted-foreground" aria-label="Drag to reorder">
            <GripVertical className="size-3.5" />
          </span>
          <button type="button" onClick={() => onToggle(item.id)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-[13px] hover:bg-accent/60" aria-expanded={open}>
            <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
            {thumb ? <Thumb src={asImage(item.fields[thumb.key])?.url} className="size-5 rounded-sm" /> : null}
            <span className="truncate">{label}</span>
            {subErrors.length || ownError ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : null}
          </button>
          <span className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton label="Move up" disabled={index === 0} onClick={() => onUpdate((items) => move(items, index, index - 1))}>
              <ArrowUp />
            </IconButton>
            <IconButton label="Move down" disabled={index === count - 1} onClick={() => onUpdate((items) => move(items, index, index + 1))}>
              <ArrowDown />
            </IconButton>
            <IconButton
              label="Duplicate"
              disabled={field.max != null && count >= field.max}
              onClick={() => onUpdate((items) => items.flatMap((it) => (it.id === item.id ? [it, cloneWithNewIds(it as unknown as PageNode) as unknown as ListItem] : [it])))}
            >
              <Copy />
            </IconButton>
            <IconButton label="Remove" className="hover:text-destructive" onClick={() => onUpdate((items) => items.filter((it) => it.id !== item.id))}>
              <Trash2 />
            </IconButton>
          </span>
        </div>
        {open ? (
          <div className="flex flex-col gap-3.5 border-t px-3 pt-3 pb-3.5">
            {ownError ? <p className="text-xs text-destructive">{ownError}</p> : null}
            {(field.fields ?? []).map((sub) => {
              const subId = `${baseId}-${sub.key}`;
              const error = errors?.get(`${errorPrefix}${item.id}.${sub.key}`);
              return (
                <FieldShell
                  key={sub.key}
                  path={`${focusPath}.${item.id}.${sub.key}`}
                  label={sub.label}
                  required={sub.required}
                  description={sub.description}
                  error={error}
                  htmlFor={subId}
                  inline={sub.type === "boolean"}
                  aside={sub.localized ? <LocaleDots value={item.fields[sub.key]} locale={locale} locales={locales} onLocale={onLocale} /> : null}
                >
                  <ValueEditor
                    id={subId}
                    field={sub}
                    value={item.fields[sub.key]}
                    onChange={set(sub)}
                    locale={locale}
                    locales={locales}
                    invalid={!!error}
                    onText={sub.type === "text" && onItemText ? (text) => onItemText(item.id, sub.key, text) : undefined}
                    onLocale={onLocale}
                  />
                </FieldShell>
              );
            })}
          </div>
        ) : null}
      </li>
    );
  },
);

const ListEditor = ({ field, value, onChange, locale, locales, errors, errorPrefix = "", focusPath = field.key, openItem, onItemText, onLocale }: ValueEditorProps) => {
  const items = useMemo(() => asItems(value), [value]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(items.length === 1 ? [items[0]!.id] : []));
  useEffect(() => {
    if (openItem) setOpen((s) => (s.has(openItem) ? s : new Set([...s, openItem])));
  }, [openItem]);
  const onUpdate = useCallback((update: (items: ListItem[]) => ListItem[]) => onChange((current: unknown) => {
    const next = update(asItems(current));
    return next.length ? next : undefined;
  }), [onChange]);
  const onToggle = useCallback((id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  const drag = useRowDrag(items.length, (from, to) => onUpdate((list) => move(list, from, to)));
  const full = field.max != null && items.length >= field.max;
  const singular = field.label.replace(/ies$/, "y").replace(/s$/, "");
  const add = () => {
    const item = createListItem(field);
    onUpdate((list) => [...list, item]);
    setOpen((s) => new Set([...s, item.id]));
    // Focus the new item's first input once it renders.
    requestAnimationFrame(() => (document.querySelector(`[data-field-path="${CSS.escape(`${focusPath}.${item.id}`)}"] input, [data-field-path="${CSS.escape(`${focusPath}.${item.id}`)}"] textarea`) as HTMLElement | null)?.focus());
  };

  return (
    <div className="flex flex-col gap-1.5">
      {items.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map((item, i) => (
            <ListItemCard
              key={item.id}
              field={field}
              item={item}
              index={i}
              count={items.length}
              open={open.has(item.id)}
              locale={locale}
              locales={locales}
              errors={errors}
              errorPrefix={errorPrefix}
              focusPath={focusPath}
              onToggle={onToggle}
              onUpdate={onUpdate}
              onItemText={onItemText}
              onLocale={onLocale}
              dragRow={drag.row(i)}
              dragHandle={drag.handle(i)}
              dropIndicator={drag.over === i && drag.dragging !== null && drag.dragging !== i}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">No {field.label.toLowerCase()} yet.</p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={full}>
          <Plus />
          Add {singular.toLowerCase() || "item"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {items.length}
          {field.max != null ? ` / ${field.max}` : ""}
          {field.min ? ` · at least ${field.min}` : ""}
        </span>
        {items.length > 1 ? (
          <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(open.size ? new Set() : new Set(items.map((it) => it.id)))}>
            {open.size ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- dispatch

export const ValueEditor = memo((props: ValueEditorProps) => {
  switch (props.field.type) {
    case "text":
      return <TextEditor {...props} />;
    case "richText":
      return <RichTextField {...props} />;
    case "number":
      return <NumberEditor {...props} />;
    case "boolean":
      return <BooleanEditor {...props} />;
    case "select":
      return <SelectEditor {...props} />;
    case "color":
      return <ColorEditor {...props} />;
    case "image":
      return <ImageEditor {...props} />;
    case "link":
      return <LinkEditor {...props} />;
    case "date":
      return <DateEditor {...props} />;
    case "product":
      return <ProductEditor {...props} />;
    case "products":
      return <ProductsEditor {...props} />;
    case "category":
      return <CategoryEditor {...props} />;
    case "list":
      return <ListEditor {...props} />;
    default:
      return <p className="text-xs text-muted-foreground">This field is edited in the structure tree.</p>;
  }
});
