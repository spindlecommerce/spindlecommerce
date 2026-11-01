import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "./api";
import { formatBytes } from "./format";

/**
 * Uploads go straight from the browser to storage, since serverless request bodies are capped
 * (4.5 MB on Vercel): mediaUploadCreate hands out a short-lived target, then mediaAssetCreate
 * registers what storage holds. See docs/media.md.
 */

export const MediaAssetFields = graphql(`
  fragment MediaAssetFields on MediaAsset {
    id
    url
    filename
    contentType
    kind
    size
    width
    height
    alt
    alts {
      locale
      value
    }
    createdAt
  }
`);

export type MediaAsset = ResultOf<typeof MediaAssetFields>;
export type MediaKind = NonNullable<MediaAsset["kind"]>;

/** The library serves the catalog and the page builder: either area's permission is enough. */
export const MEDIA_READ = ["content:read", "catalog:read"] as const;
export const MEDIA_WRITE = ["content:write", "catalog:write"] as const;

export const MEDIA_KEYS = {
  all: ["media"] as const,
  storage: ["media", "storage"] as const,
  assets: ["media", "assets"] as const,
  asset: (id: string) => ["media", "asset", id] as const,
};

/** Alt text per locale, as the editors keep it. */
export const altsOf = (asset: Pick<MediaAsset, "alts">, locales?: readonly string[]): Record<string, string> =>
  Object.fromEntries((asset.alts ?? []).flatMap((a) => (a.locale && a.value && (!locales || locales.includes(a.locale)) ? [[a.locale, a.value]] : [])));

// ---------------------------------------------------------------- storage and types

const MediaStorageQuery = graphql(`
  query MediaStorage {
    mediaStorage {
      provider
      maxBytes
      allowedContentTypes
    }
  }
`);

export type MediaStorage = NonNullable<ResultOf<typeof MediaStorageQuery>["mediaStorage"]>;

/** Storage settings change only with the server's configuration. */
export const mediaStorageQuery = {
  queryKey: MEDIA_KEYS.storage,
  queryFn: async () => (await request(MediaStorageQuery)).mediaStorage ?? null,
  staleTime: 10 * 60_000,
};

export const useMediaStorage = () => useQuery(mediaStorageQuery).data ?? null;

export const STORAGE_LABELS: Record<string, string> = { LOCAL: "Local disk", S3: "S3 storage", VERCEL_BLOB: "Vercel Blob" };

/** What the API accepts, until it says (MediaStorageInfo.allowedContentTypes). */
const DEFAULT_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "video/mp4"];
const TYPE_LABELS: Record<string, string> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/gif": "GIF", "image/webp": "WebP", "image/avif": "AVIF", "video/mp4": "MP4" };
/** Other names browsers give these types, and the type an extension implies when they give none. */
const TYPE_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "video/x-m4v": "video/mp4" };
const EXTENSION_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", mp4: "video/mp4", m4v: "video/mp4" };

export const kindOf = (contentType: string | null | undefined): MediaKind => (contentType?.startsWith("video/") ? "VIDEO" : "IMAGE");

/** "PNG" for image/png. */
export const typeLabel = (contentType: string | null | undefined) => (contentType ? (TYPE_LABELS[contentType] ?? contentType.slice(contentType.indexOf("/") + 1).toUpperCase()) : "");

/** The type a file is declared as; the API checks it against the bytes. */
export const fileContentType = (file: File) => {
  const reported = file.type.toLowerCase();
  return TYPE_ALIASES[reported] ?? (reported || EXTENSION_TYPES[file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()] || "");
};

const acceptedTypes = (storage: MediaStorage | null | undefined, kind?: MediaKind) => (storage?.allowedContentTypes ?? DEFAULT_TYPES).filter((type) => !kind || kindOf(type) === kind);

/** A file input's `accept`: the types the storage takes, of one kind if given. */
export const mediaAccept = (storage: MediaStorage | null | undefined, kind?: MediaKind) => acceptedTypes(storage, kind).join(",");

/** "JPEG, PNG, GIF, WebP, AVIF or MP4". */
export const mediaTypeList = (storage: MediaStorage | null | undefined, kind?: MediaKind) => {
  const labels = acceptedTypes(storage, kind).map(typeLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : (labels[0] ?? "");
};

/** Why a file can't be uploaded, or null. The API checks again, and the bytes after upload. */
export const mediaFileProblem = (file: File, storage: MediaStorage | null | undefined, kind?: MediaKind) => {
  if (!acceptedTypes(storage, kind).includes(fileContentType(file))) {
    const types = mediaTypeList(storage, kind);
    return kind === "IMAGE" ? `Only images can be used here: ${types}.` : kind === "VIDEO" ? `Only videos can be used here: ${types}.` : `Upload a ${types} file.`;
  }
  if (file.size === 0) return "The file is empty.";
  if (storage?.maxBytes && file.size > storage.maxBytes) return `The file is ${formatBytes(file.size)}; files are limited to ${formatBytes(storage.maxBytes)}.`;
  return null;
};

// ---------------------------------------------------------------- the pipeline

const MediaUploadCreate = graphql(
  `
    mutation MediaUploadCreate($input: MediaUploadCreateInput!) {
      mediaUploadCreate(input: $input) {
        __typename
        ... on MediaUploadPayload {
          upload {
            provider
            key
            url
            headers
            clientToken
            pathname
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const MediaAssetCreate = graphql(
  `
    mutation MediaAssetCreate($input: MediaAssetCreateInput!) {
      mediaAssetCreate(input: $input) {
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

const canceled = () => new DOMException("The upload was canceled.", "AbortError");
export const isCanceled = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A failed step, worded for the uploader. Typed API errors already explain themselves. */
const failure = (error: unknown): Error => {
  if (error instanceof MutationError) {
    if (error.typename === "PermissionDeniedError") return new Error("Uploading needs the content:write or catalog:write permission.", { cause: error });
    return new Error(sentence(error.fieldErrors[0]?.message ?? error.message), { cause: error });
  }
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return new Error("The server could not be reached. Check your connection.", { cause: error });
  return new Error(sentence(error instanceof Error && error.message ? error.message : "The upload failed"), { cause: error });
};

/** Headers a page may not set; browsers send Content-Length and Host themselves. */
const FORBIDDEN_HEADER = /^(accept-charset|accept-encoding|access-control-request-(headers|method)|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;

const settableHeaders = (headers: unknown): [string, string][] =>
  headers && typeof headers === "object" ? Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !FORBIDDEN_HEADER.test(entry[0])) : [];

/** Why storage refused a PUT: the API's JSON error (local disk) or S3's XML. */
const refusal = (xhr: XMLHttpRequest) => {
  const body = xhr.responseText;
  let reason = "";
  try {
    reason = (JSON.parse(body) as { error?: { message?: string } } | null)?.error?.message ?? "";
  } catch {
    reason = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? "";
  }
  if (/expired/i.test(reason)) return new Error("The upload link expired before the file was sent. Try again.");
  return new Error(reason ? `Storage refused the file: ${sentence(reason)}` : `Storage refused the file (HTTP ${xhr.status}).`);
};

/** XMLHttpRequest, because fetch can't report upload progress. */
const putFile = (url: string, file: File, headers: unknown, signal: AbortSignal | undefined, onProgress: (fraction: number) => void) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(canceled());
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", url);
    for (const [name, value] of settableHeaders(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(refusal(xhr)));
    // No response at all: the connection failed or, for a bucket on another origin, CORS blocked it.
    xhr.onerror = () =>
      reject(
        new Error(
          new URL(url, location.href).origin === location.origin
            ? "The file could not be sent. Check your connection."
            : "The file could not be sent to storage. Check your connection, and that the bucket's CORS rules allow PUT from this site.",
        ),
      );
    xhr.onabort = () => reject(canceled());
    xhr.onloadend = () => signal?.removeEventListener("abort", abort);
    xhr.send(file);
  });

/** Larger files go to Vercel Blob in parallel 8 MB parts, retried on failure. */
const BLOB_PART_BYTES = 8 * 1024 * 1024;

const putBlob = async (target: { pathname: string | null; clientToken: string | null }, file: File, contentType: string, signal: AbortSignal | undefined, onProgress: (fraction: number) => void) => {
  if (!target.pathname || !target.clientToken) throw new Error("The server returned no Vercel Blob upload token.");
  // Loaded on first use, so other storage never downloads the SDK.
  const { put } = await import("@vercel/blob/client");
  await put(target.pathname, file, {
    access: "public",
    token: target.clientToken,
    contentType,
    multipart: file.size > BLOB_PART_BYTES,
    abortSignal: signal,
    onUploadProgress: ({ loaded, total }) => onProgress(total ? loaded / total : 0),
  });
};

/** Read in the browser because the API measures only images; null when unreadable. */
const videoDimensions = (file: File) =>
  new Promise<{ width: number; height: number } | null>((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (size: { width: number; height: number } | null) => {
      clearTimeout(timer);
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(size);
    };
    const timer = setTimeout(() => done(null), 10_000);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => done(video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : null);
    video.onerror = () => done(null);
    video.src = url;
  });

export type UploadOptions = {
  /** Storage settings to check the file against first (useMediaStorage or mediaStorageQuery). */
  storage?: MediaStorage | null;
  /** Accept only images, or only videos. */
  kind?: MediaKind;
  /** Cancels until the bytes are stored; registration isn't canceled, so no file is orphaned. */
  signal?: AbortSignal;
  /** 0 to 1 while the bytes are sent. */
  onProgress?: (fraction: number) => void;
  /** The bytes are in storage and the API is registering them. */
  onSaving?: () => void;
};

/** Failures are sentences to show; a canceled upload rejects with an AbortError (isCanceled). */
export const uploadMediaFile = async (file: File, options: UploadOptions = {}): Promise<MediaAsset> => {
  const { storage, kind, signal, onProgress = () => {}, onSaving } = options;
  const problem = mediaFileProblem(file, storage, kind);
  if (problem) throw new Error(problem);
  const contentType = fileContentType(file);
  const filename = file.name.trim().slice(0, 255) || "upload";
  const dimensions = kindOf(contentType) === "VIDEO" ? videoDimensions(file) : Promise.resolve(null);
  let key: string;
  try {
    const { upload } = unwrap((await request(MediaUploadCreate, { input: { filename, contentType, size: file.size } }, { signal })).mediaUploadCreate);
    if (!upload?.key) throw new Error("The server returned no upload target.");
    signal?.throwIfAborted();
    if (upload.provider === "VERCEL_BLOB") await putBlob(upload, file, contentType, signal, onProgress);
    else if (upload.url) await putFile(upload.url, file, upload.headers, signal, onProgress);
    else throw new Error("The server returned no upload URL.");
    key = upload.key;
  } catch (error) {
    if (signal?.aborted || isCanceled(error)) throw canceled();
    throw failure(error);
  }
  onProgress(1);
  onSaving?.();
  try {
    const size = await dimensions;
    const { asset } = unwrap((await request(MediaAssetCreate, { input: { key, filename, width: size?.width, height: size?.height } })).mediaAssetCreate);
    if (!asset) throw new Error("The server returned no asset.");
    return asset;
  } catch (error) {
    throw failure(error);
  }
};

// ---------------------------------------------------------------- the queue

export type UploadStatus = "queued" | "uploading" | "saving" | "done" | "failed";

export type MediaUpload = {
  id: string;
  file: File;
  kind: MediaKind;
  /** An object URL showing an image while it uploads. */
  preview: string | null;
  status: UploadStatus;
  /** 0 to 1. */
  progress: number;
  error: string | null;
  /** False when the file itself is refused (type or size), so retrying won't help. */
  retryable: boolean;
  asset: MediaAsset | null;
};

export const isUploading = (upload: MediaUpload) => upload.status === "queued" || upload.status === "uploading" || upload.status === "saving";

/** Files sent at the same time; the rest wait their turn. */
const CONCURRENCY = 3;
let sequence = 0;

type Job = { controller: AbortController; settle: (upload: MediaUpload | null) => void };

/**
 * Uploads a few at a time. `add` resolves once every file has landed or failed, with entries in the
 * order given, minus canceled ones. Entries stay until dismissed; unmounting cancels what is still
 * being sent.
 */
export const useMediaUploads = (options: { kind?: MediaKind; onUploaded?: (asset: MediaAsset, upload: MediaUpload) => void } = {}) => {
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<MediaUpload[]>([]);
  const latest = useRef(options);
  latest.current = options;
  const alive = useRef(true);
  // The entries as of now, for the queue; `uploads` is their last render.
  const entries = useRef(new Map<string, MediaUpload>());
  const jobs = useRef(new Map<string, Job>());

  const actions = useMemo(() => {
    const queue: string[] = [];
    let running = 0;
    let landed = false;
    const commit = () => setUploads([...entries.current.values()]);
    const update = (id: string, patch: Partial<MediaUpload>) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      entries.current.set(id, { ...entry, ...patch });
      commit();
    };
    const remove = (ids: readonly string[]) => {
      for (const id of ids) {
        const entry = entries.current.get(id);
        if (entry?.preview) URL.revokeObjectURL(entry.preview);
        entries.current.delete(id);
      }
      commit();
    };
    const enqueue = (id: string, settle: Job["settle"]) => {
      jobs.current.set(id, { controller: new AbortController(), settle });
      queue.push(id);
    };

    const run = async (id: string) => {
      const job = jobs.current.get(id);
      const entry = entries.current.get(id);
      if (!job || !entry) return;
      update(id, { status: "uploading", progress: 0, error: null });
      try {
        const storage = await queryClient.ensureQueryData(mediaStorageQuery).catch(() => null);
        const problem = mediaFileProblem(entry.file, storage, latest.current.kind);
        if (problem) {
          update(id, { status: "failed", error: problem, retryable: false });
          return job.settle(entries.current.get(id) ?? null);
        }
        const asset = await uploadMediaFile(entry.file, {
          storage,
          kind: latest.current.kind,
          signal: job.controller.signal,
          // Whole percents only: progress events come faster than anyone reads them.
          onProgress: (progress) => {
            if (Math.floor(progress * 100) !== Math.floor((entries.current.get(id)?.progress ?? 0) * 100)) update(id, { progress });
          },
          onSaving: () => update(id, { status: "saving", progress: 1 }),
        });
        landed = true;
        update(id, { status: "done", progress: 1, asset });
        const done = entries.current.get(id) ?? null;
        if (done && alive.current) latest.current.onUploaded?.(asset, done);
        job.settle(done);
      } catch (error) {
        if (isCanceled(error)) {
          remove([id]);
          job.settle(null);
        } else {
          update(id, { status: "failed", error: error instanceof Error ? error.message : "The upload failed." });
          job.settle(entries.current.get(id) ?? null);
        }
      } finally {
        jobs.current.delete(id);
      }
    };

    const pump = () => {
      while (alive.current && running < CONCURRENCY && queue.length) {
        const id = queue.shift()!;
        if (!jobs.current.has(id)) continue;
        running++;
        void run(id).finally(() => {
          running--;
          pump();
          // The last upload in flight has landed: refresh the library's lists.
          if (!running && !queue.length && landed) {
            landed = false;
            void queryClient.invalidateQueries({ queryKey: MEDIA_KEYS.assets });
          }
        });
      }
    };

    return {
      add: (files: Iterable<File>) => {
        const added = [...files].map((file): MediaUpload => {
          const contentType = fileContentType(file);
          const kind = kindOf(contentType);
          // Only types browsers can show; a HEIC preview would be a broken image.
          const preview = kind === "IMAGE" && DEFAULT_TYPES.includes(contentType) ? URL.createObjectURL(file) : null;
          return { id: `upload-${++sequence}`, file, kind, preview, status: "queued", progress: 0, error: null, retryable: true, asset: null };
        });
        for (const entry of added) entries.current.set(entry.id, entry);
        commit();
        const settled = added.map((entry) => new Promise<MediaUpload | null>((settle) => enqueue(entry.id, settle)));
        pump();
        return Promise.all(settled).then((list) => list.filter((upload): upload is MediaUpload => upload !== null));
      },
      /** Stop sending a file and forget it. One being registered can't be stopped. */
      cancel: (id: string) => {
        const entry = entries.current.get(id);
        const job = jobs.current.get(id);
        if (!entry || entry.status === "saving") return;
        if (entry.status === "queued") {
          if (queue.includes(id)) queue.splice(queue.indexOf(id), 1);
          jobs.current.delete(id);
          job?.settle(null);
          remove([id]);
        } else job?.controller.abort();
      },
      retry: (id: string) => {
        const entry = entries.current.get(id);
        if (entry?.status !== "failed" || !entry.retryable) return;
        update(id, { status: "queued", progress: 0, error: null });
        enqueue(id, () => {});
        pump();
      },
      /** Forget entries that are no longer uploading (all of them by default). */
      dismiss: (ids?: readonly string[]) => remove((ids ?? [...entries.current.keys()]).filter((id) => !jobs.current.has(id))),
    };
  }, [queryClient]);

  useEffect(() => {
    alive.current = true;
    const current = entries.current;
    const running = jobs.current;
    return () => {
      alive.current = false;
      for (const job of running.values()) job.controller.abort();
      for (const entry of current.values()) if (entry.preview) URL.revokeObjectURL(entry.preview);
    };
  }, []);

  return { uploads, ...actions };
};
