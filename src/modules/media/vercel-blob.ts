import { responsePrefix } from "./formats.ts";
import { IMMUTABLE_MAX_AGE, MediaConfigError, UPLOAD_TTL_SECONDS } from "./keys.ts";
import type { Env, StorageDriver } from "./storage.ts";

/**
 * Vercel Blob, public access. Browsers upload with `@vercel/blob/client`'s `put()` and a client
 * token limited to one pathname, type and size. The SDK loads lazily so other providers skip it.
 */

/** Where `@vercel/blob/client` uploads to, unless VERCEL_BLOB_API_URL overrides it. */
export const DEFAULT_BLOB_API_URL = "https://vercel.com/api/blob";

/** Origins the browser's Blob client may call. */
export const blobApiOrigins = (env: Env): string[] => {
  const origins = new Set<string>();
  for (const url of [env.VERCEL_BLOB_API_URL, env.NEXT_PUBLIC_VERCEL_BLOB_API_URL, DEFAULT_BLOB_API_URL]) {
    if (!url?.trim()) continue;
    try {
      origins.add(new URL(url.trim()).origin);
    } catch {
      // Not a URL; the SDK would fail on it too.
    }
  }
  return [...origins];
};

/** The store id in a read-write token, `vercel_blob_rw_<store id>_<secret>`. */
export const blobStoreId = (token: string): string => token.split("_")[3] ?? "";

export const blobClientTokenOptions = (input: { key: string; contentType: string; size: number; now?: number }) => ({
  pathname: input.key,
  allowedContentTypes: [input.contentType],
  maximumSizeInBytes: input.size,
  validUntil: (input.now ?? Date.now()) + UPLOAD_TTL_SECONDS * 1000,
  addRandomSuffix: false,
  allowOverwrite: false,
  cacheControlMaxAge: IMMUTABLE_MAX_AGE,
});

/** Server-side puts above this upload in parallel parts, with retries. */
const MULTIPART_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const createBlobDriver = (options: { token: string; prefix: string }): StorageDriver => {
  const { token, prefix } = options;
  const storeId = blobStoreId(token);
  if (!token.startsWith("vercel_blob_rw_") || !storeId) throw new MediaConfigError("BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token (vercel_blob_rw_…)");
  // new URL() lowercases the host, matching the URLs Vercel returns.
  const publicUrl = (key: string) => new URL(`https://${storeId}.public.blob.vercel-storage.com/${key}`).toString();
  return {
    provider: "vercel-blob",
    prefix,
    publicUrl,
    createUpload: async ({ key, contentType, size }) => {
      const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
      const constraints = blobClientTokenOptions({ key, contentType, size });
      return {
        provider: "vercel-blob",
        key,
        publicUrl: publicUrl(key),
        method: "PUT",
        url: null,
        headers: {},
        clientToken: await generateClientTokenFromReadWriteToken({ token, ...constraints }),
        pathname: key,
        expiresAt: new Date(constraints.validUntil),
      };
    },
    head: async (key) => {
      const { head, BlobNotFoundError } = await import("@vercel/blob");
      try {
        const blob = await head(key, { token, abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
        return { size: blob.size, contentType: blob.contentType, url: blob.url };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw error;
      }
    },
    readStart: async (key, length) => responsePrefix(await fetch(publicUrl(key), { headers: { range: `bytes=0-${length - 1}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }), length),
    put: async (key, bytes, contentType) => {
      const { put } = await import("@vercel/blob");
      const blob = await put(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: "public",
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: IMMUTABLE_MAX_AGE,
        multipart: bytes.byteLength > MULTIPART_BYTES,
      });
      return { url: blob.url };
    },
    delete: async (key) => {
      const { del } = await import("@vercel/blob");
      await del(key, { token, abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
    },
  };
};
