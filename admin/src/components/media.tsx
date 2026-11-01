import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Film, ImageOff, Play, RotateCw, Search, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/overlay";
import { graphql } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { kindOf, MEDIA_KEYS, MediaAssetFields, typeLabel, type MediaAsset, type MediaKind, type MediaUpload } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

/** Pieces the media library screen and the media picker share. */

// ---------------------------------------------------------------- the list

const MediaAssetsQuery = graphql(
  `
    query MediaAssets($first: Int!, $after: String, $query: String, $kind: MediaKind) {
      mediaAssets(first: $first, after: $after, query: $query, kind: $kind) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            ...MediaAssetFields
          }
        }
      }
    }
  `,
  [MediaAssetFields],
);

/** A multiple of 2, 3, 4, 6 and 8 columns, so full pages fill whole rows. */
const PAGE_SIZE = 48;

/** Newest first; `query` matches the start of words in file names and alt text. */
export const useMediaAssets = ({ query, kind }: { query: string; kind?: MediaKind }) => {
  const result = useInfiniteQuery({
    queryKey: [...MEDIA_KEYS.assets, { query, kind: kind ?? null }],
    queryFn: ({ pageParam, signal }) => request(MediaAssetsQuery, { first: PAGE_SIZE, after: pageParam, query: query || null, kind: kind ?? null }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.mediaAssets?.pageInfo.hasNextPage ? (page.mediaAssets.pageInfo.endCursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
  });
  // Keyset pages: new uploads never shift later pages, so no row appears twice.
  const assets = useMemo(() => (result.data?.pages ?? []).flatMap((page) => (page.mediaAssets?.edges ?? []).flatMap((edge) => (edge?.node ? [edge.node] : []))), [result.data]);
  return {
    assets,
    total: result.data?.pages[0]?.mediaAssets?.totalCount ?? null,
    loading: result.isLoading,
    /** Showing the previous search's results while the new ones load. */
    stale: result.isPlaceholderData,
    error: result.error,
    hasMore: !!result.hasNextPage,
    loadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
    retry: () => void result.refetch(),
  };
};

// ---------------------------------------------------------------- tiles

export const MEDIA_GRID = "grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]";

/** "PNG · 1200×800 · 245 KB", "MP4 video · 1920×1080 · 12 MB". */
export const mediaSummary = (asset: Pick<MediaAsset, "contentType" | "width" | "height" | "size">) =>
  [
    `${typeLabel(asset.contentType)}${kindOf(asset.contentType) === "VIDEO" ? " video" : ""}`,
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    asset.size != null ? formatBytes(asset.size) : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** A video frame, loaded as the tile nears the screen. */
const VideoFrame = ({ url, className }: { url: string | null | undefined; className?: string }) => {
  const frame = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const element = frame.current;
    if (!element || near) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNear(true);
      observer.disconnect();
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return (
    <span ref={frame} aria-hidden className={cn("relative flex size-full items-center justify-center bg-muted text-muted-foreground", className)}>
      {/* #t=0.1 shows a frame rather than black, in Safari too. */}
      {near && url && !broken ? (
        <video src={`${url}#t=0.1`} preload="metadata" muted playsInline disablePictureInPicture tabIndex={-1} onError={() => setBroken(true)} className="absolute inset-0 size-full object-cover" />
      ) : (
        <Film className="size-5" />
      )}
      <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
        <Play className="size-2.5 fill-current" />
        Video
      </span>
    </span>
  );
};

/** Decorative (alt=""): the tile names the file. */
export const MediaThumb = ({ asset, className }: { asset: Pick<MediaAsset, "url" | "kind">; className?: string }) => {
  const [broken, setBroken] = useState<string | null>(null);
  if (asset.kind === "VIDEO") return <VideoFrame url={asset.url} className={className} />;
  if (!asset.url || broken === asset.url) {
    return (
      <span aria-hidden className={cn("flex size-full items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageOff className="size-5" />
      </span>
    );
  }
  // Not draggable: a dragged image carries a file, which the page would take as an upload.
  return <img src={asset.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(asset.url ?? null)} className={cn("size-full bg-muted object-cover", className)} />;
};

export const MediaCaption = ({ asset }: { asset: Pick<MediaAsset, "filename" | "contentType" | "width" | "height" | "size"> }) => (
  <span className="block min-w-0 px-2 pt-1.5 pb-2">
    <span className="block truncate text-[13px] font-medium" title={asset.filename ?? undefined}>
      {asset.filename}
    </span>
    <span className="block truncate text-xs text-muted-foreground">{mediaSummary(asset)}</span>
  </span>
);

const TileButton = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => (
  <Tooltip content={label}>
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5"
    >
      {children}
    </button>
  </Tooltip>
);

/** An upload's preview and progress with Cancel; once failed, the error with Retry and Dismiss. */
export const UploadTile = ({ upload, onCancel, onRetry, onDismiss }: { upload: MediaUpload; onCancel: () => void; onRetry: () => void; onDismiss: () => void }) => {
  const failed = upload.status === "failed";
  const percent = Math.round(upload.progress * 100);
  const status = failed ? "Failed" : upload.status === "queued" ? "Waiting…" : upload.status === "saving" ? "Saving…" : `Uploading ${percent}%`;
  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-lg border bg-card", failed && "border-destructive/50")}>
      <div className="relative aspect-square overflow-hidden bg-muted">
        {upload.preview ? (
          <img src={upload.preview} alt="" draggable={false} onError={(event) => (event.currentTarget.style.visibility = "hidden")} className={cn("size-full object-cover", !failed && "opacity-60")} />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">{upload.kind === "VIDEO" ? <Film className="size-5" /> : <ImageOff className="size-5" />}</span>
        )}
        {failed ? (
          <p role="alert" className="absolute inset-0 flex items-center justify-center overflow-y-auto bg-background/90 p-3 text-center text-xs text-destructive">
            {upload.error}
          </p>
        ) : (
          <div
            role="progressbar"
            aria-label={`Uploading ${upload.file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={upload.status === "queued" ? undefined : percent}
            className="absolute inset-x-2 bottom-2 h-1.5 overflow-hidden rounded-full bg-background/80"
          >
            <div className={cn("h-full rounded-full bg-primary transition-[width] duration-200", upload.status === "saving" && "animate-pulse")} style={{ width: `${upload.status === "queued" ? 0 : Math.max(percent, 2)}%` }} />
          </div>
        )}
      </div>
      <span className="block min-w-0 px-2 pt-1.5 pb-2">
        <span className="block truncate text-[13px] font-medium" title={upload.file.name}>
          {upload.file.name}
        </span>
        <span className={cn("block truncate text-xs tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>{status}</span>
      </span>
      <div className="absolute top-1.5 right-1.5 flex gap-1">
        {failed ? (
          <>
            {upload.retryable ? (
              <TileButton label={`Retry ${upload.file.name}`} onClick={onRetry}>
                <RotateCw />
              </TileButton>
            ) : null}
            <TileButton label={`Dismiss ${upload.file.name}`} onClick={onDismiss}>
              <X />
            </TileButton>
          </>
        ) : upload.status !== "saving" ? (
          <TileButton label={`Cancel uploading ${upload.file.name}`} onClick={onCancel}>
            <X />
          </TileButton>
        ) : null}
      </div>
    </div>
  );
};

export const MediaGridSkeleton = ({ count = 12 }: { count?: number }) => (
  <div className={MEDIA_GRID} aria-hidden>
    {Array.from({ length: count }, (_, i) => (
      <div key={i} className="overflow-hidden rounded-lg border">
        <Skeleton className="aspect-square rounded-none" />
        <div className="space-y-1.5 px-2 pt-2 pb-2.5">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------- search, filter, paging

export const MediaSearch = ({ value, onChange, onKeyDown, className }: { value: string; onChange: (value: string) => void; onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void; className?: string }) => (
  <div className={cn("relative w-full sm:max-w-xs", className)}>
    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    <Input type="search" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Search names and alt text" aria-label="Search media" className="h-8 pl-8" />
  </div>
);

export const KindFilter = ({ value, onChange }: { value: MediaKind | undefined; onChange: (kind: MediaKind | undefined) => void }) => (
  <Tabs value={value ?? "ALL"} onValueChange={(next) => onChange(next === "IMAGE" || next === "VIDEO" ? next : undefined)}>
    <TabsList aria-label="Show" className="h-8">
      <TabsTrigger value="ALL" className="px-2.5 text-[13px]">
        All
      </TabsTrigger>
      <TabsTrigger value="IMAGE" className="px-2.5 text-[13px]">
        Images
      </TabsTrigger>
      <TabsTrigger value="VIDEO" className="px-2.5 text-[13px]">
        Videos
      </TabsTrigger>
    </TabsList>
  </Tabs>
);

/**
 * Loads the next page when scrolled into view (`root` is the scroller, if not the window); the
 * Load more button does the same from the keyboard.
 */
export const LoadMore = ({ hasMore, loading, onLoad, shown, total, root }: { hasMore: boolean; loading: boolean; onLoad: () => void; shown: number; total: number | null; root?: Element | null }) => {
  const sentinel = useRef<HTMLDivElement>(null);
  const latest = useRef(onLoad);
  latest.current = onLoad;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || loading) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && latest.current(), { root, rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading, root]);
  return (
    <div ref={sentinel} className="flex flex-col items-center gap-2 pt-5 text-[13px] text-muted-foreground">
      {total !== null && (hasMore || total > shown) ? <span className="tabular-nums">{`${shown.toLocaleString()} of ${total.toLocaleString()}`}</span> : null}
      {hasMore ? (
        <Button type="button" variant="outline" size="sm" loading={loading} onClick={onLoad}>
          Load more
        </Button>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------- keyboard

/** Arrow keys, Home and End move between `data-tile` elements as laid out; true if handled. */
export const moveGridFocus = (event: KeyboardEvent, grid: HTMLElement | null) => {
  if (!grid || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
  const tiles = [...grid.querySelectorAll<HTMLElement>("[data-tile]")];
  const index = tiles.indexOf(event.currentTarget as HTMLElement);
  if (index < 0) return false;
  event.preventDefault();
  const top = tiles[0]!.getBoundingClientRect().top;
  const wrap = tiles.findIndex((tile) => Math.abs(tile.getBoundingClientRect().top - top) > 1);
  const columns = wrap < 0 ? tiles.length : wrap;
  const last = tiles.length - 1;
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: Math.min(index + columns, last), ArrowUp: index - columns, Home: 0, End: last }[event.key]!;
  const target = tiles[Math.max(0, Math.min(next, last))]!;
  target.focus();
  target.scrollIntoView({ block: "nearest" });
  return true;
};

/**
 * Radix returns focus only to a dialog's own trigger. Pass this as `onCloseAutoFocus` to return it
 * to whatever had focus at open; call it in a component that mounts with the dialog content.
 */
export const useReturnFocus = () => {
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  return (event: Event) => {
    if (!opener?.isConnected) return;
    event.preventDefault();
    opener.focus();
  };
};

// ---------------------------------------------------------------- dropping and pasting files

/**
 * Sends files dropped anywhere on the page to `onFiles` and returns whether files are dragged over
 * it. A stray drop never opens the file in the tab; drags from the page itself are ignored.
 */
export const useFileDrop = (onFiles: (files: File[]) => void, enabled = true) => {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    let fromPage = false;
    const external = (event: DragEvent) => !fromPage && !!event.dataTransfer?.types.includes("Files");
    const start = () => (fromPage = true);
    const end = () => (fromPage = false);
    const enter = (event: DragEvent) => {
      if (!external(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!external(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!external(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!external(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) latest.current(files);
    };
    const listeners = { dragstart: start, dragend: end, dragenter: enter, dragover: over, dragleave: leave, drop } as const;
    for (const [type, listener] of Object.entries(listeners)) window.addEventListener(type, listener as EventListener);
    return () => {
      for (const [type, listener] of Object.entries(listeners)) window.removeEventListener(type, listener as EventListener);
      setDragging(false);
    };
  }, [enabled]);
  return dragging;
};

/** Files in a paste (a screenshot, a copied image); none when text is being pasted into a field. */
export const pastedFiles = (event: ClipboardEvent | ReactClipboardEvent) => {
  const data = event.clipboardData;
  const files = [...(data?.files ?? [])];
  const target = event.target instanceof Element ? event.target : null;
  if (!files.length || (target?.closest("input, textarea, [contenteditable='true']") && data?.types.includes("text/plain"))) return [];
  return files;
};

/** Shown while files are dragged over the page (or, with `className`, over a dialog). */
export const DropOverlay = ({ show, label, className }: { show: boolean; label: ReactNode; className?: string }) =>
  show ? (
    <div aria-hidden className={cn("pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-primary/10 p-6 backdrop-blur-[1px]", className)}>
      <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary bg-popover px-10 py-8 text-center shadow-lg">
        <Upload className="size-6 text-primary" />
        <p className="text-sm font-medium">{label}</p>
      </div>
    </div>
  ) : null;
