import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, ExternalLink, LayoutTemplate, Package, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Field, FormSection, reportError } from "@/components/form";
import { LocalizedInput } from "@/components/inputs";
import { useReturnFocus } from "@/components/media";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, Detail, Separator, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { ConfirmDialog, DialogTitle, SheetContent, Tooltip } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDateTime, languageName } from "@/lib/format";
import { copyText, useAction, useReference } from "@/lib/hooks";
import { altsOf, MEDIA_KEYS, MediaAssetFields, STORAGE_LABELS, typeLabel } from "@/lib/media-upload";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { toLocalizedList } from "@/lib/utils";

const MediaAssetQuery = graphql(
  `
    query MediaAssetDetail($id: ID!) {
      mediaAsset(id: $id) {
        ...MediaAssetFields
        storage
        createdBy {
          id
          name
          email
        }
        usage {
          kind
          id
          title
        }
      }
    }
  `,
  [MediaAssetFields],
);

type DetailAsset = NonNullable<ResultOf<typeof MediaAssetQuery>["mediaAsset"]>;
export type MediaUsage = NonNullable<DetailAsset["usage"]>[number];

const MediaAssetUpdate = graphql(
  `
    mutation MediaAssetUpdate($id: ID!, $input: MediaAssetUpdateInput!) {
      mediaAssetUpdate(id: $id, input: $input) {
        __typename
        ... on MediaAssetPayload {
          asset {
            ...MediaAssetFields
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields, MediaAssetFields],
);

export const MediaAssetDelete = graphql(
  `
    mutation MediaAssetDelete($id: ID!, $force: Boolean) {
      mediaAssetDelete(id: $id, force: $force) {
        __typename
        ... on DeletePayload {
          deletedId
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** The UUID of a global id, for URLs ("gid://ecom/MediaAsset/0192…" → "0192…"). */
export const rawId = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const assetGid = (id: string) => (id.startsWith("gid://") ? id : `gid://ecom/MediaAsset/${id}`);

/** "2 products and 1 page". */
export const usageSummary = (usage: readonly MediaUsage[]) => {
  const products = usage.filter((u) => u.kind === "PRODUCT").length;
  const pages = usage.filter((u) => u.kind === "PAGE").length;
  return [products ? `${products} product${products === 1 ? "" : "s"}` : null, pages ? `${pages} page${pages === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
};

const UsageList = ({ usage }: { usage: readonly MediaUsage[] }) => {
  const { can } = useAuth();
  return (
    <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border text-[13px]">
      {usage.map((u) => {
        const product = u.kind === "PRODUCT";
        const Icon = product ? Package : LayoutTemplate;
        const label = u.title || (product ? "Untitled product" : "Untitled page");
        const linkClass = "min-w-0 flex-1 truncate font-medium hover:underline";
        return (
          <li key={`${u.kind}:${u.id}`} className="flex items-center gap-2.5 px-3 py-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            {u.id && product && can("catalog:read") ? (
              <Link to="/products/$id" params={{ id: u.id }} className={linkClass}>
                {label}
              </Link>
            ) : u.id && !product && can("content:read") ? (
              <Link to="/pages/$id" params={{ id: rawId(u.id) }} className={linkClass}>
                {label}
              </Link>
            ) : (
              <span className="min-w-0 flex-1 truncate">{label}</span>
            )}
            <span className="text-xs text-muted-foreground">{product ? "Product" : "Page"}</span>
          </li>
        );
      })}
    </ul>
  );
};

/** Alt text compared as the API stores it: trimmed, empty locales dropped. */
const altKey = (alt: Record<string, string>) =>
  JSON.stringify(
    Object.entries(alt)
      .map(([locale, text]) => [locale, text.trim()])
      .filter(([, text]) => text)
      .sort(([a], [b]) => (a! < b! ? -1 : 1)),
  );

/** Mount inside a Sheet, keyed by the asset id. */
export const AssetSheet = ({ id, write, onClose, onDeleted }: { id: string; write: boolean; onClose: () => void; onDeleted: (id: string) => void }) => {
  const query = useQuery({ queryKey: MEDIA_KEYS.asset(id), queryFn: ({ signal }) => request(MediaAssetQuery, { id }, { signal }) });
  const asset = query.data?.mediaAsset;
  const [dirty, setDirty] = useState(false);
  const unsaved = useUnsavedChanges(dirty, { description: "Your changes to this file's name and alt text will be lost." });
  const returnFocus = useReturnFocus();

  return (
    <SheetContent aria-describedby={undefined} className="gap-0 sm:w-[38rem] sm:max-w-[38rem]" dirty={dirty} onCloseAutoFocus={returnFocus}>
      {asset ? (
        <AssetDetails key={asset.id} asset={asset} write={write} onDirtyChange={setDirty} onClose={onClose} onDeleted={onDeleted} refetch={() => void query.refetch()} />
      ) : query.isLoading ? (
        <div className="flex flex-col gap-4">
          <DialogTitle className="sr-only">Loading the file</DialogTitle>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 pr-8">
          <DialogTitle>File not found</DialogTitle>
          <Alert variant={query.error ? "destructive" : "info"} title={query.error ? "The file could not be loaded" : "It is no longer in the media library"}>
            {query.error instanceof Error ? query.error.message : "It may have been deleted."}
          </Alert>
        </div>
      )}
      {unsaved.dialog}
    </SheetContent>
  );
};

const AssetDetails = ({
  asset,
  write,
  onDirtyChange,
  onClose,
  onDeleted,
  refetch,
}: {
  asset: DetailAsset;
  write: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
  refetch: () => void;
}) => {
  const queryClient = useQueryClient();
  const reference = useReference();
  // The channels' languages, and any the file already has alt text in.
  const locales = useMemo(() => [...new Set([...reference.locales, ...(asset.alts ?? []).flatMap((a) => (a.locale ? [a.locale] : []))])], [reference.locales, asset.alts]);
  const [saved, setSaved] = useState(() => ({ filename: asset.filename ?? "", alt: altsOf(asset) }));
  const [filename, setFilename] = useState(saved.filename);
  const [alt, setAlt] = useState(saved.alt);
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dirty = write && (filename.trim() !== saved.filename || altKey(alt) !== altKey(saved.alt));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const usage = asset.usage ?? [];
  const url = asset.url ?? "";
  const video = asset.kind === "VIDEO";

  const save = useAction(
    async () => unwrap((await request(MediaAssetUpdate, { id: asset.id, input: { filename: filename.trim(), alts: toLocalizedList(alt) } })).mediaAssetUpdate).asset,
    {
      success: "File details saved",
      invalidate: [MEDIA_KEYS.assets],
      onSuccess: (updated) => {
        if (!updated) return;
        const next = { filename: updated.filename ?? "", alt: altsOf(updated) };
        setSaved(next);
        setFilename(next.filename);
        setAlt(next.alt);
        queryClient.setQueryData(MEDIA_KEYS.asset(asset.id), (old: ResultOf<typeof MediaAssetQuery> | undefined) => (old?.mediaAsset ? { mediaAsset: { ...old.mediaAsset, ...updated } } : old));
      },
      onError: (error) => {
        const message = error instanceof MutationError ? error.fieldErrors.find((e) => e.path.includes("filename"))?.message : undefined;
        if (message) setFilenameError(message);
        else reportError(error);
      },
    },
  );

  const remove = useAction(async (force: boolean) => unwrap((await request(MediaAssetDelete, { id: asset.id, force })).mediaAssetDelete), {
    success: `Deleted ${asset.filename}`,
    invalidate: [MEDIA_KEYS.assets],
    onSuccess: () => {
      setDeleting(false);
      queryClient.removeQueries({ queryKey: MEDIA_KEYS.asset(asset.id) });
      onDeleted(asset.id);
    },
    onError: (error) => {
      // Something started using it since the panel opened: reload, so the dialog says where.
      if (error instanceof MutationError && error.typename === "InvalidStateError") refetch();
      reportError(error);
    },
  });

  const submit = () => {
    if (!dirty || save.isPending) return;
    if (!filename.trim()) return setFilenameError("Give the file a name");
    setFilenameError(null);
    save.mutate(undefined);
  };

  return (
    <form
      // Its own height, at least the panel's: the panel scrolls, and the footer sits at the bottom.
      className="flex min-h-full shrink-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        // ⌘S saves here too; the screen's own shortcut leaves dialogs and panels alone.
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5 pr-8">
        <DialogTitle className="break-all">{saved.filename || "Untitled file"}</DialogTitle>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <Badge variant={video ? "info" : "secondary"}>{video ? "Video" : "Image"}</Badge>
          <span>{[typeLabel(asset.contentType), asset.width && asset.height ? `${asset.width}×${asset.height}` : null, formatBytes(asset.size)].filter(Boolean).join(" · ")}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
        {video ? (
          <video src={url} controls preload="metadata" playsInline className="max-h-80 w-full bg-black" />
        ) : (
          <img src={url} alt={asset.alt ?? ""} className="max-h-80 w-auto max-w-full object-contain" />
        )}
      </div>

      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="File URL" className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        <Tooltip content="Copy the URL">
          <Button type="button" variant="outline" size="icon" aria-label="Copy the URL" onClick={() => void copyText(url, "URL copied")}>
            <Copy />
          </Button>
        </Tooltip>
        <Tooltip content="Open in a new tab">
          <Button asChild variant="outline" size="icon">
            <a href={url} target="_blank" rel="noreferrer" aria-label="Open in a new tab">
              <ExternalLink />
            </a>
          </Button>
        </Tooltip>
      </div>

      {write ? (
        <FormSection title="Details" description="Renaming changes how the file is listed and found, not its URL.">
          <Field label="Name" required error={filenameError ?? undefined}>
            <Input
              value={filename}
              maxLength={255}
              onChange={(event) => {
                setFilename(event.target.value);
                setFilenameError(null);
              }}
            />
          </Field>
          <Field label="Alt text" hint="Describes the file for screen readers and search engines. Products and pages that add it get this text; editing it here later doesn't change theirs.">
            <LocalizedInput value={alt} onChange={setAlt} locales={locales} placeholder={video ? "What the video shows" : "What the image shows"} />
          </Field>
        </FormSection>
      ) : (
        <dl>
          <Detail label="Alt text">
            {asset.alts?.length ? (
              <ul className="flex flex-col gap-1">
                {asset.alts.map((a) => (
                  <li key={a.locale}>
                    <span className="text-muted-foreground">{a.locale ? languageName(a.locale) : ""}: </span>
                    {a.value}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Detail>
        </dl>
      )}

      <Separator />
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Information</h3>
        <dl>
          <Detail label="Type">
            {typeLabel(asset.contentType)} {video ? "video" : "image"} <span className="font-mono text-xs text-muted-foreground">({asset.contentType})</span>
          </Detail>
          <Detail label="Size">{formatBytes(asset.size)}</Detail>
          <Detail label="Dimensions">{asset.width && asset.height ? `${asset.width} × ${asset.height} px` : "Unknown"}</Detail>
          <Detail label="Storage">{asset.storage ? (STORAGE_LABELS[asset.storage] ?? asset.storage) : "—"}</Detail>
          <Detail label="Uploaded">
            {formatDateTime(asset.createdAt)}
            {asset.createdBy ? <span className="text-muted-foreground"> by {asset.createdBy.name || asset.createdBy.email}</span> : null}
          </Detail>
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Used by{usage.length ? ` (${usage.length})` : ""}</h3>
        {usage.length ? (
          <UsageList usage={usage} />
        ) : (
          <p className="text-[13px] text-muted-foreground">Not used by any product or page. Product descriptions and component preview images are not checked.</p>
        )}
      </section>

      {write ? (
        // Sticky offsets count from inside the panel's padding: -bottom-6 pins it to the edge.
        <div className="sticky -bottom-6 -mx-6 mt-auto -mb-6 flex flex-wrap items-center gap-2 border-t bg-popover px-6 py-4">
          <Button type="button" variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => setDeleting(true)}>
            <Trash2 />
            Delete…
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => {
                setFilename(saved.filename);
                setAlt(saved.alt);
                setFilenameError(null);
              }}
            >
              Discard
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
          <Button type="submit" loading={save.isPending} disabled={!dirty}>
            {save.isPending ? null : <Save />}
            Save
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={usage.length ? `${asset.filename} is in use` : `Delete ${asset.filename}?`}
        description={
          usage.length
            ? `It is used by ${usageSummary(usage)}. Deleting it leaves them pointing at a file that no longer exists, so they show a broken image until it is replaced there.`
            : "The file is deleted from storage. This cannot be undone."
        }
        confirmLabel={usage.length ? "Delete anyway" : "Delete"}
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate(usage.length > 0)}
      >
        {usage.length ? <UsageList usage={usage} /> : null}
      </ConfirmDialog>
    </form>
  );
};
