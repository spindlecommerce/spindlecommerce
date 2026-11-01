import { ArrowDown, ArrowUp, Film, ImageOff, Images, Link2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { UploadButton } from "@/components/inputs";
import { MediaPicker } from "@/components/media-picker";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Input, NativeSelect } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { altsOf, MEDIA_READ, type MediaAsset } from "@/lib/media-upload";

/** `alt` is per locale; saving media replaces all of it, so every locale is kept in the form. */
export type MediaRow = { url: string; alt: Record<string, string>; variantSku: string; kind: "IMAGE" | "VIDEO" };

export const emptyMedia = (url = ""): MediaRow => ({ url, alt: {}, variantSku: "", kind: /\.mp4($|\?)/i.test(url) ? "VIDEO" : "IMAGE" });

/** Alt text only in the locales the editor shows: it saves what it shows. */
const rowOf = (asset: MediaAsset, locales: readonly string[]): MediaRow => ({ url: asset.url ?? "", alt: altsOf(asset, locales), variantSku: "", kind: asset.kind === "VIDEO" ? "VIDEO" : "IMAGE" });

const Preview = ({ row, alt }: { row: MediaRow; alt: string }) => {
  if (!row.url) {
    return (
      <span className="flex size-16 shrink-0 items-center justify-center rounded-lg border border-dashed bg-muted/40">
        <ImageOff className="size-5 text-muted-foreground" />
      </span>
    );
  }
  if (row.kind === "VIDEO") {
    return (
      <span className="flex size-16 shrink-0 items-center justify-center rounded-lg border bg-muted">
        <Film className="size-5 text-muted-foreground" />
      </span>
    );
  }
  return <img src={row.url} alt={alt} className="size-16 shrink-0 rounded-lg border bg-muted object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />;
};

/** One locale at a time; the others show the default locale's text as a placeholder. */
const AltInput = ({ value, onChange, locales, disabled }: { value: Record<string, string>; onChange: (value: Record<string, string>) => void; locales: readonly string[]; disabled?: boolean }) => {
  const [active, setActive] = useState(locales[0] ?? "");
  const current = locales.includes(active) ? active : (locales[0] ?? active);
  const fallback = current !== locales[0] ? value[locales[0] ?? ""] : undefined;
  return (
    <div className="flex gap-2">
      {locales.length > 1 ? (
        <NativeSelect className="w-28 shrink-0" value={current} onChange={(e) => setActive(e.target.value)} aria-label="Alt text language">
          {locales.map((locale) => (
            <option key={locale} value={locale}>
              {locale}
              {value[locale]?.trim() ? "" : " (empty)"}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      <Input value={value[current] ?? ""} placeholder={fallback || "Alt text"} onChange={(e) => onChange({ ...value, [current]: e.target.value })} disabled={disabled} aria-label={`Alt text (${current})`} />
    </div>
  );
};

/** The first image is the product's main image; media with a variant SKU shows for that variant. */
export const MediaEditor = ({
  value,
  onChange,
  skus,
  locales,
  disabled,
}: {
  value: MediaRow[];
  onChange: (value: MediaRow[]) => void;
  skus: readonly string[];
  /** Default locale first. */
  locales: readonly string[];
  disabled?: boolean;
}) => {
  const { can } = useAuth();
  const [picking, setPicking] = useState(false);
  // Uploads and picks arrive several at once; append to the latest list, not the one this render saw.
  const latest = useRef(value);
  latest.current = value;
  const append = (assets: readonly MediaAsset[]) => {
    latest.current = [...latest.current, ...assets.map((asset) => rowOf(asset, locales))];
    onChange(latest.current);
  };
  const update = (index: number, patch: Partial<MediaRow>) => onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, delta: number) => {
    const next = [...value];
    const [row] = next.splice(index, 1);
    next.splice(index + delta, 0, row!);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? <EmptyState icon={ImageOff} title="No media" description="Upload images and videos, choose them from the media library, or link to files on your CDN." className="py-8" /> : null}
      {value.map((row, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start">
          <Preview row={row} alt={row.alt[locales[0] ?? ""] ?? ""} />
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            <Input className="sm:col-span-2" value={row.url} placeholder="https://cdn.example.com/image.jpg" onChange={(e) => update(index, { url: e.target.value })} disabled={disabled} aria-label="Media URL" />
            <AltInput value={row.alt} onChange={(alt) => update(index, { alt })} locales={locales} disabled={disabled} />
            <div className="flex gap-2">
              <NativeSelect value={row.variantSku} onChange={(e) => update(index, { variantSku: e.target.value })} disabled={disabled} aria-label="Variant">
                <option value="">All variants</option>
                {skus.map((sku) => (
                  <option key={sku} value={sku}>
                    {sku}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect className="w-28" value={row.kind} onChange={(e) => update(index, { kind: e.target.value as MediaRow["kind"] })} disabled={disabled} aria-label="Kind">
                <option value="IMAGE">Image</option>
                <option value="VIDEO">Video</option>
              </NativeSelect>
            </div>
          </div>
          {disabled ? null : (
            <div className="flex shrink-0 gap-1 sm:flex-col">
              <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, i) => i !== index))} aria-label="Remove">
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
      ))}
      {disabled ? null : (
        <div className="flex flex-wrap gap-2">
          <UploadButton multiple label="Upload files" onUploaded={(_url, asset) => append([asset])} />
          {can(MEDIA_READ) ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              <Images />
              Choose from library
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, emptyMedia()])}>
            <Link2 />
            Add by URL
          </Button>
        </div>
      )}
      <MediaPicker open={picking} onOpenChange={setPicking} multiple title="Add product media" confirmLabel="Add" onSelect={append} />
    </div>
  );
};
