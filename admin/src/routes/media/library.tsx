import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, CloudOff, HardDrive, Images, Keyboard, RotateCw, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BulkActionDialog, type BulkOutcome } from "@/components/bulk-action";
import { Page, PageHeader } from "@/components/layout/page";
import { DropOverlay, KindFilter, LoadMore, MEDIA_GRID, MediaCaption, MediaGridSkeleton, MediaSearch, MediaThumb, moveGridFocus, pastedFiles, UploadTile, useFileDrop, useMediaAssets } from "@/components/media";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Alert, EmptyState, Kbd, Skeleton } from "@/components/ui/feedback";
import { Label } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Popover, PopoverContent, PopoverTrigger, Sheet, Tooltip } from "@/components/ui/overlay";
import { graphql } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes } from "@/lib/format";
import { useDebounced, useListSearch } from "@/lib/hooks";
import { MEDIA_KEYS, MEDIA_WRITE, mediaAccept, mediaTypeList, STORAGE_LABELS, useMediaStorage, useMediaUploads, type MediaAsset } from "@/lib/media-upload";
import { cn } from "@/lib/utils";
import { assetGid, AssetSheet, MediaAssetDelete, rawId, usageSummary, type MediaUsage } from "./asset-sheet";

const MediaUsageQuery = graphql(`
  query MediaUsage($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on MediaAsset {
        id
        usage {
          kind
          id
          title
        }
      }
    }
  }
`);

const describe = (error: unknown) => {
  const message = error instanceof Error ? error.message.trim() : "";
  return !message ? "Something went wrong." : /[.!?]$/.test(message) ? message : `${message}.`;
};

const PASTE_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? ["⌘", "V"] : ["Ctrl", "V"];

const Shortcut = ({ keys, children }: { keys: string[]; children: string }) => (
  <>
    <dt className="flex items-center gap-0.5">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </dt>
    <dd>{children}</dd>
  </>
);

const ShortcutsHelp = ({ write }: { write: boolean }) => (
  <Popover>
    <Tooltip content="Keyboard shortcuts">
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
          <Keyboard />
        </Button>
      </PopoverTrigger>
    </Tooltip>
    <PopoverContent align="end" className="w-80">
      <p className="mb-2.5 text-[13px] font-medium">Keyboard shortcuts</p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
        <Shortcut keys={["←", "→", "↑", "↓"]}>Move between files</Shortcut>
        <Shortcut keys={["Enter"]}>Open the file</Shortcut>
        {write ? (
          <>
            <Shortcut keys={["x"]}>Select or deselect it; with Shift, a range (or Shift-click)</Shortcut>
            <Shortcut keys={["Delete"]}>Delete the selected files, or this one</Shortcut>
            <Shortcut keys={["Esc"]}>Clear the selection</Shortcut>
            <Shortcut keys={PASTE_KEYS}>Upload a pasted image</Shortcut>
          </>
        ) : null}
      </dl>
    </PopoverContent>
  </Popover>
);

/** Content › Media. The search, the kind filter and the open file (?asset=) live in the URL. */
export const MediaLibraryPage = () => {
  const { can } = useAuth();
  const write = can(MEDIA_WRITE);
  const queryClient = useQueryClient();
  const [search, setSearch] = useListSearch();
  const kind = search.kind === "IMAGE" || search.kind === "VIDEO" ? search.kind : undefined;
  const q = search.q ?? "";
  const filtered = !!(q || kind);

  // `pushed` tells our own URL updates apart from Back or Reset changing the query.
  const [text, setText] = useState(q);
  const debounced = useDebounced(text.trim(), 300);
  const pushed = useRef(q);
  useEffect(() => {
    if (debounced === pushed.current) return;
    pushed.current = debounced;
    setSearch({ q: debounced || undefined }, { keepCursor: true });
  }, [debounced, setSearch]);
  useEffect(() => {
    if (q === pushed.current) return;
    pushed.current = q;
    setText(q);
  }, [q]);

  const list = useMediaAssets({ query: q, kind });
  const storage = useMediaStorage();
  const uploads = useMediaUploads();
  const latestUploads = useRef(uploads.uploads);
  latestUploads.current = uploads.uploads;
  const dragging = useFileDrop((files) => void uploads.add(files), write);
  const fileInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MediaAsset[] | null>(null);

  useEffect(() => {
    if (!write) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = pastedFiles(event);
      if (!files.length) return;
      event.preventDefault();
      void uploads.add(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [write, uploads.add]);

  // Another search or filter: a fresh selection, and finished uploads make way for its results.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    uploads.dismiss();
  }, [q, kind, uploads.dismiss]);

  // Finished uploads lead the grid, newest first, until the list has them or another search starts.
  const listed = new Set(list.assets.map((a) => a.id));
  const landed = uploads.uploads.flatMap((u) => (u.status === "done" && u.asset && !listed.has(u.asset.id) ? [u.asset] : [])).reverse();
  const assets = [...landed, ...list.assets];
  const pending = uploads.uploads.filter((u) => u.status !== "done").reverse();
  const selectedAssets = assets.filter((a) => selected.has(a.id));
  const focusable = assets.some((a) => a.id === active) ? active : (assets[0]?.id ?? null);

  useEffect(() => {
    const ids = new Set(list.assets.map((a) => a.id));
    const shown = uploads.uploads.filter((u) => u.status === "done" && u.asset && ids.has(u.asset.id)).map((u) => u.id);
    if (shown.length) uploads.dismiss(shown);
  }, [list.assets, uploads.uploads, uploads.dismiss]);

  const openId = search.asset ? assetGid(search.asset) : null;
  const open = (asset: MediaAsset) => setSearch({ asset: rawId(asset.id) }, { keepCursor: true });
  const close = () => setSearch({ asset: undefined }, { keepCursor: true });
  /** After deleting: out of the selection, and out of the uploads that led the grid. */
  const forget = (ids: ReadonlySet<string>) => {
    setSelected((current) => new Set([...current].filter((id) => !ids.has(id))));
    uploads.dismiss(latestUploads.current.filter((u) => u.asset && ids.has(u.asset.id)).map((u) => u.id));
  };

  /** With `range`, every file from the last one toggled to this one takes its new state. */
  const toggle = (id: string, range: boolean) => {
    const ids = assets.map((a) => a.id);
    const from = range && anchor.current ? ids.indexOf(anchor.current) : -1;
    const to = ids.indexOf(id);
    const span = from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    setSelected((current) => {
      const next = new Set(current);
      const on = !current.has(id);
      for (const key of span) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
    anchor.current = id;
  };
  const clearSelection = () => {
    setSelected(new Set());
    anchor.current = null;
  };

  const onTileKey = (event: KeyboardEvent<HTMLButtonElement>, asset: MediaAsset) => {
    if (moveGridFocus(event, grid.current) || !write || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "x" || event.key === "X") {
      event.preventDefault();
      toggle(asset.id, event.shiftKey);
    } else if (event.key === "Escape" && selected.size) {
      event.preventDefault();
      clearSelection();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setDeleting(selectedAssets.length ? selectedAssets : [asset]);
    }
  };

  const StorageIcon = storage?.provider === "LOCAL" ? HardDrive : Cloud;
  const uploadButton = write ? (
    <Button onClick={() => fileInput.current?.click()}>
      <Upload />
      Upload
    </Button>
  ) : null;

  return (
    <Page wide>
      <PageHeader
        title="Media"
        description={
          <>
            Images and videos for products and pages.{write ? " Drop or paste files anywhere on this page to upload them." : null}
            {storage ? (
              <span className="mt-1 flex items-start gap-1.5 text-xs">
                <StorageIcon className="mt-px size-3.5 shrink-0" />
                <span>{`${STORAGE_LABELS[storage.provider ?? ""] ?? "Storage"} · up to ${formatBytes(storage.maxBytes)} per file · ${mediaTypeList(storage)}`}</span>
              </span>
            ) : null}
          </>
        }
        actions={uploadButton}
      />
      {write ? (
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={mediaAccept(storage)}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length) void uploads.add(files);
          }}
        />
      ) : null}

      <div className="overflow-clip rounded-xl border bg-card shadow-xs">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <MediaSearch value={text} onChange={setText} />
          <KindFilter value={kind} onChange={(next) => setSearch({ kind: next }, { keepCursor: true })} />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText("");
                setSearch({ q: undefined, kind: undefined }, { keepCursor: true });
              }}
            >
              <X />
              Reset
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {list.total !== null ? (
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {`${list.total.toLocaleString()} ${list.total === 1 ? "file" : "files"}${filtered ? " found" : ""}`}
              </span>
            ) : null}
            <ShortcutsHelp write={write} />
          </div>
        </div>

        {list.error && assets.length ? (
          <Alert
            variant="warning"
            className="items-center rounded-none border-x-0 border-t-0 py-2.5"
            title="Couldn't refresh the media library"
            action={
              <Button size="sm" variant="outline" onClick={list.retry}>
                <RotateCw />
                Try again
              </Button>
            }
          >
            {describe(list.error)} The files below may be out of date.
          </Alert>
        ) : null}

        <div className="p-4">
          {pending.length || assets.length ? (
            <div ref={grid} role="list" aria-label="Media files" aria-busy={list.stale || undefined} className={cn(MEDIA_GRID, list.stale && "opacity-60 transition-opacity delay-150")}>
              {pending.map((upload) => (
                <div role="listitem" key={upload.id}>
                  <UploadTile upload={upload} onCancel={() => uploads.cancel(upload.id)} onRetry={() => uploads.retry(upload.id)} onDismiss={() => uploads.dismiss([upload.id])} />
                </div>
              ))}
              {assets.map((asset) => {
                const isSelected = selected.has(asset.id);
                return (
                  <div role="listitem" key={asset.id} className={cn("group relative rounded-lg border bg-card transition-shadow hover:shadow-sm", isSelected && "border-primary ring-2 ring-primary/60")}>
                    <button
                      type="button"
                      data-tile
                      tabIndex={asset.id === focusable ? 0 : -1}
                      onFocus={() => setActive(asset.id)}
                      onKeyDown={(event) => onTileKey(event, asset)}
                      // Shift-click selects a range of files, not the text between the clicks.
                      onMouseDown={(event) => event.shiftKey && event.preventDefault()}
                      onClick={(event) => (write && (event.shiftKey || event.metaKey || event.ctrlKey) ? toggle(asset.id, event.shiftKey) : open(asset))}
                      className="block w-full overflow-hidden rounded-[inherit] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span className="block aspect-square overflow-hidden bg-muted">
                        <MediaThumb asset={asset} />
                      </span>
                      <MediaCaption asset={asset} />
                    </button>
                    {write ? (
                      <Checkbox
                        checked={isSelected}
                        tabIndex={asset.id === focusable ? 0 : -1}
                        aria-label={`Select ${asset.filename}`}
                        onClick={(event) => {
                          event.preventDefault();
                          toggle(asset.id, event.shiftKey);
                        }}
                        className={cn(
                          "absolute top-2 left-2 size-5 bg-background/90 shadow-sm transition-opacity",
                          isSelected || selected.size ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                        )}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : list.error ? (
            <div role="alert">
              <EmptyState
                icon={CloudOff}
                title="Couldn't load the media library"
                description={describe(list.error)}
                action={
                  <Button variant="outline" onClick={list.retry}>
                    <RotateCw />
                    Try again
                  </Button>
                }
              />
            </div>
          ) : list.loading ? (
            <MediaGridSkeleton />
          ) : filtered ? (
            <EmptyState
              icon={Search}
              title="Nothing found"
              description="Search matches the start of words in file names and in alt text, in any language."
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setText("");
                    setSearch({ q: undefined, kind: undefined }, { keepCursor: true });
                  }}
                >
                  Show all files
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Images}
              title="No media yet"
              description={write ? "Upload images and videos, or drop them anywhere on this page. Products and pages can then use them." : "Images and videos uploaded for products and pages appear here."}
              action={uploadButton ?? undefined}
            />
          )}
          {assets.length ? <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onLoad={list.loadMore} shown={list.assets.length} total={list.total} /> : null}
        </div>

        {write && selectedAssets.length ? (
          // Pinned to the bottom of the window while the grid runs past it, as in the admin's lists.
          <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-card))] px-4 py-2 text-[13px] shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.3)]">
            <span className="font-medium" aria-live="polite">
              {selectedAssets.length} selected
            </span>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
            {selectedAssets.length < assets.length ? (
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(assets.map((a) => a.id)))}>
                Select all {assets.length} shown
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDeleting(selectedAssets)}>
                <Trash2 />
                Delete
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Sheet open={!!openId} onOpenChange={(isOpen) => !isOpen && close()}>
        {openId ? (
          <AssetSheet
            key={openId}
            id={openId}
            write={write}
            onClose={close}
            onDeleted={(id) => {
              forget(new Set([id]));
              close();
            }}
          />
        ) : null}
      </Sheet>
      {deleting ? (
        <BulkDelete
          assets={deleting}
          onClose={() => setDeleting(null)}
          onFinished={(outcome) => {
            const deleted = new Set(outcome.done.map((a) => a.id));
            forget(deleted);
            // Failures stay selected, to try again.
            setSelected(new Set(outcome.failed.map((f) => f.item.id)));
            void queryClient.invalidateQueries({ queryKey: MEDIA_KEYS.assets });
            if (openId && deleted.has(openId)) close();
          }}
        />
      ) : null}
      <DropOverlay show={dragging} label="Drop to upload to the media library" />
    </Page>
  );
};

/** Files in use are skipped, saying where, unless the person chooses to delete them anyway. */
const BulkDelete = ({ assets, onClose, onFinished }: { assets: MediaAsset[]; onClose: () => void; onFinished: (outcome: BulkOutcome<MediaAsset>) => void }) => {
  const ids = assets.map((a) => a.id);
  const check = useQuery({ queryKey: [...MEDIA_KEYS.all, "usage", ids], queryFn: () => request(MediaUsageQuery, { ids }), staleTime: 0, gcTime: 0, retry: false });
  const [force, setForce] = useState(false);
  const count = `${assets.length} ${assets.length === 1 ? "file" : "files"}`;

  if (!check.data) {
    return (
      <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {count}?</DialogTitle>
            <DialogDescription>{check.error ? "Where the files are used could not be checked." : "Checking where the files are used…"}</DialogDescription>
          </DialogHeader>
          {check.error ? <Alert variant="destructive">{describe(check.error)}</Alert> : <Skeleton className="h-12 w-full" />}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {check.error ? <Button onClick={() => void check.refetch()}>Try again</Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const usageOf = new Map<string, readonly MediaUsage[]>((check.data.nodes ?? []).flatMap((node) => (node?.__typename === "MediaAsset" ? [[node.id, node.usage ?? []] as const] : [])));
  const inUse = assets.filter((a) => usageOf.get(a.id)?.length).length;

  return (
    <BulkActionDialog
      items={assets}
      title={`Delete ${count}?`}
      description={
        <>
          The files are deleted from storage. This cannot be undone.
          {inUse ? (
            <Label className="mt-3 items-start font-normal text-foreground">
              <Checkbox checked={force} onCheckedChange={(value) => setForce(value === true)} className="mt-0.5" />
              <span>
                {inUse === 1
                  ? "Also delete the file in use. Where it is used, a broken image shows until it is replaced there."
                  : `Also delete the ${inUse} files in use. Where they are used, broken images show until they are replaced there.`}
              </span>
            </Label>
          ) : null}
        </>
      }
      noun={["file", "files"]}
      verbs={["Deleting", "Deleted"]}
      confirmLabel={force && inUse ? "Delete anyway" : "Delete"}
      destructive
      itemKey={(a) => a.id}
      itemLabel={(a) => a.filename || "Untitled file"}
      skipReason={(a) => {
        const usage = usageOf.get(a.id);
        return !force && usage?.length ? `Used by ${usageSummary(usage)}` : null;
      }}
      run={async (a) => unwrap((await request(MediaAssetDelete, { id: a.id, force: force && !!usageOf.get(a.id)?.length })).mediaAssetDelete)}
      onClose={onClose}
      onFinished={onFinished}
    />
  );
};
