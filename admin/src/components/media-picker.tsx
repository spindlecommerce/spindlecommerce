import { Check, Images, Search, Upload } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState, Kbd } from "@/components/ui/feedback";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { useAuth } from "@/lib/auth";
import { formatBytes } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { isUploading, MEDIA_WRITE, mediaAccept, useMediaStorage, useMediaUploads, type MediaAsset, type MediaKind } from "@/lib/media-upload";
import { cn } from "@/lib/utils";
import { DropOverlay, KindFilter, LoadMore, MEDIA_GRID, MediaCaption, MediaGridSkeleton, MediaSearch, MediaThumb, moveGridFocus, pastedFiles, UploadTile, useFileDrop, useMediaAssets, useReturnFocus } from "./media";

const defaultTitle = (kind: MediaKind | undefined, multiple: boolean) =>
  kind === "IMAGE" ? (multiple ? "Choose images" : "Choose an image") : kind === "VIDEO" ? (multiple ? "Choose videos" : "Choose a video") : multiple ? "Choose media" : "Choose a file";

/**
 * Picks from the media library, or uploads by button, drop or paste; uploads lead the grid and are
 * selected as they land. Arrows move, Space selects, Enter picks, ⌘Enter confirms.
 */
export const MediaPicker = ({
  open,
  onOpenChange,
  kind,
  multiple = false,
  onSelect,
  title,
  confirmLabel = "Choose",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Offer only images, or only videos. */
  kind?: MediaKind;
  multiple?: boolean;
  /** The assets chosen, in the order they were selected. */
  onSelect: (assets: MediaAsset[]) => void;
  title?: string;
  /** The confirm button's verb; with `multiple`, the count follows it ("Add 3"). */
  confirmLabel?: string;
}) => {
  // Handed over after the dialog closes and returns focus, so `onSelect` can move focus itself
  // (into a text editor) without the dialog pulling it back.
  const picked = useRef<MediaAsset[] | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <PickerContent
          kind={kind}
          multiple={multiple}
          title={title ?? defaultTitle(kind, multiple)}
          confirmLabel={confirmLabel}
          onCancel={() => onOpenChange(false)}
          onConfirm={(assets) => {
            picked.current = assets;
            onOpenChange(false);
          }}
          onClosed={() => {
            const assets = picked.current;
            picked.current = null;
            if (assets) onSelect(assets);
          }}
        />
      ) : null}
    </Dialog>
  );
};

const PickerContent = ({
  kind,
  multiple,
  title,
  confirmLabel,
  onCancel,
  onConfirm,
  onClosed,
}: {
  kind?: MediaKind;
  multiple: boolean;
  title: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (assets: MediaAsset[]) => void;
  onClosed: () => void;
}) => {
  const { can } = useAuth();
  const write = can(MEDIA_WRITE);
  const storage = useMediaStorage();
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), 250);
  const [filter, setFilter] = useState<MediaKind | undefined>(undefined);
  const list = useMediaAssets({ query, kind: kind ?? filter });
  const [selected, setSelected] = useState<MediaAsset[]>([]);
  // The tile Tab enters the grid on (roving focus): the first, until another is focused.
  const [active, setActive] = useState<string | null>(null);
  const [scrollArea, setScrollArea] = useState<HTMLDivElement | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const returnFocus = useReturnFocus();

  const choose = (asset: MediaAsset, toggle: boolean) =>
    setSelected((current) => {
      const has = current.some((a) => a.id === asset.id);
      if (!multiple) return has && toggle ? [] : [asset];
      return has ? (toggle ? current.filter((a) => a.id !== asset.id) : current) : [...current, asset];
    });
  const uploads = useMediaUploads({ kind, onUploaded: (asset) => choose(asset, false) });
  const dragging = useFileDrop((files) => void uploads.add(files), write);

  const confirm = (assets: MediaAsset[]) => {
    if (assets.length) onConfirm(assets);
  };
  /** Enter or double click: confirm now with this asset, plus the selection in multiple mode. */
  const pick = (asset: MediaAsset) => confirm(multiple ? (selected.some((a) => a.id === asset.id) ? selected : [...selected, asset]) : [asset]);

  // Uploads that have landed lead the list, newest first, until they are in it.
  const landed = uploads.uploads.flatMap((u) => (u.status === "done" && u.asset ? [u.asset] : [])).reverse();
  const landedIds = new Set(landed.map((a) => a.id));
  const assets = [...landed, ...list.assets.filter((a) => !landedIds.has(a.id))];
  const pending = uploads.uploads.filter((u) => u.status !== "done").reverse();
  const sending = pending.filter(isUploading).length;
  const focusable = assets.some((a) => a.id === active) ? active : (assets[0]?.id ?? null);
  const order = new Map(selected.map((a, i) => [a.id, i + 1]));

  const onTileKey = (event: KeyboardEvent<HTMLDivElement>, asset: MediaAsset) => {
    if (moveGridFocus(event, grid.current)) return;
    if (event.key === " ") {
      event.preventDefault();
      choose(asset, true);
    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      pick(asset);
    }
  };

  const uploadButton = write ? (
    <Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
      <Upload />
      Upload
    </Button>
  ) : null;

  return (
    <DialogContent
      className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-5xl flex-col gap-0 overflow-hidden p-0"
      onCloseAutoFocus={(event) => {
        returnFocus(event);
        onClosed();
      }}
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
        event.preventDefault();
        confirm(selected);
      }}
      onPaste={(event) => {
        const files = write ? pastedFiles(event) : [];
        if (!files.length) return;
        event.preventDefault();
        void uploads.add(files);
      }}
    >
      <DialogHeader className="gap-3 border-b px-5 pt-5 pb-4">
        <div className="flex flex-col gap-1">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {write ? `From the media library, or upload new files: drop or paste them here${storage ? `, up to ${formatBytes(storage.maxBytes)} each` : ""}.` : "From the media library."}
          </DialogDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* No autoFocus: the dialog focuses it on open and remembers where focus returns. */}
          <MediaSearch
            value={text}
            onChange={setText}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              grid.current?.querySelector<HTMLElement>('[data-tile][tabindex="0"]')?.focus();
            }}
          />
          {kind ? null : <KindFilter value={filter} onChange={setFilter} />}
          {write ? (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple={multiple}
                accept={mediaAccept(storage, kind)}
                className="hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length) void uploads.add(files);
                }}
              />
              <span className="sm:ml-auto">{uploadButton}</span>
            </>
          ) : null}
        </div>
      </DialogHeader>

      <div ref={setScrollArea} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {pending.length ? (
          <div role="list" aria-label="Uploads" className={cn(MEDIA_GRID, "mb-3")}>
            {pending.map((upload) => (
              <div role="listitem" key={upload.id}>
                <UploadTile upload={upload} onCancel={() => uploads.cancel(upload.id)} onRetry={() => uploads.retry(upload.id)} onDismiss={() => uploads.dismiss([upload.id])} />
              </div>
            ))}
          </div>
        ) : null}
        {list.error && !assets.length ? (
          <Alert
            variant="destructive"
            title="Couldn't load the media library"
            action={
              <Button size="sm" variant="outline" onClick={list.retry}>
                Try again
              </Button>
            }
          >
            {list.error instanceof Error ? list.error.message : null}
          </Alert>
        ) : list.loading && !assets.length ? (
          <MediaGridSkeleton count={10} />
        ) : assets.length ? (
          <div ref={grid} role="listbox" aria-label="Media library" aria-multiselectable={multiple || undefined} className={cn(MEDIA_GRID, list.stale && "opacity-60 transition-opacity")}>
            {assets.map((asset) => {
              const position = order.get(asset.id);
              return (
                <div
                  key={asset.id}
                  role="option"
                  aria-selected={position !== undefined}
                  data-tile
                  tabIndex={asset.id === focusable ? 0 : -1}
                  onFocus={() => setActive(asset.id)}
                  onClick={() => choose(asset, true)}
                  onDoubleClick={() => !multiple && pick(asset)}
                  onKeyDown={(event) => onTileKey(event, asset)}
                  className={cn(
                    "relative cursor-pointer overflow-hidden rounded-lg border bg-card outline-none select-none hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    position !== undefined && "border-primary ring-2 ring-primary/60",
                  )}
                >
                  <span className="block aspect-square overflow-hidden bg-muted">
                    <MediaThumb asset={asset} />
                  </span>
                  <MediaCaption asset={asset} />
                  {position !== undefined ? (
                    <span className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow-sm">
                      {multiple ? position : <Check className="size-3.5" />}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : pending.length ? null : query ? (
          <EmptyState icon={Search} title="Nothing found" description="Search matches the start of words in file names and alt text." />
        ) : (
          <EmptyState
            icon={Images}
            title={kind === "VIDEO" || filter === "VIDEO" ? "No videos yet" : kind === "IMAGE" || filter === "IMAGE" ? "No images yet" : "The media library is empty"}
            description={write ? "Upload files, or drop them here." : undefined}
            action={uploadButton ?? undefined}
          />
        )}
        {assets.length ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onLoad={list.loadMore} shown={list.assets.length} total={list.total} root={scrollArea} /> : null}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t px-5 py-3">
        <p className="mr-auto flex items-center gap-2 text-[13px] text-muted-foreground" aria-live="polite">
          {selected.length ? (
            <>
              <span className="font-medium text-foreground">{selected.length} selected</span>
              <button type="button" className="text-primary hover:underline" onClick={() => setSelected([])}>
                Clear
              </button>
            </>
          ) : multiple ? (
            "Select one or more files."
          ) : (
            "Select a file."
          )}
          {sending ? <span>{`· Uploading ${sending}…`}</span> : null}
        </p>
        <p className="hidden items-center gap-1 text-xs text-muted-foreground lg:flex">
          <Kbd>Space</Kbd> selects, <Kbd>Enter</Kbd> picks
        </p>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={!selected.length} onClick={() => confirm(selected)}>
          {multiple && selected.length ? `${confirmLabel} ${selected.length}` : confirmLabel}
        </Button>
      </div>
      <DropOverlay show={dragging} label="Drop to upload to the media library" className="absolute rounded-xl" />
    </DialogContent>
  );
};
