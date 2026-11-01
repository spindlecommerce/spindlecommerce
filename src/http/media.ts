import { open, stat } from "node:fs/promises";
import type { Context, Hono } from "hono";
import { DomainError } from "../lib/errors.ts";
import { toGlobalId } from "../lib/ids.ts";
import { verifyAccessToken, verifyApiKey } from "../modules/auth/service.ts";
import { ALLOWED_LABELS, mediaTypeByExtension, readStream, sniffMediaType } from "../modules/media/formats.ts";
import { IMMUTABLE_CACHE_CONTROL } from "../modules/media/keys.ts";
import { LOCAL_PREFIX, localMediaFile, verifyLocalUpload } from "../modules/media/local.ts";
import { formatBytes, mediaMaxBytes, storeMedia, type Actor } from "../modules/media/service.ts";
import { configureMediaStorage, mediaStorage } from "../modules/media/storage.ts";
import { getStaffPermissions, getStaffUser, hasPermission } from "../modules/staff/service.ts";
import type { Platform } from "../platform.ts";

/**
 * Media over plain HTTP:
 * - POST /admin/media: a multipart upload into the library. Serverless hosts cap request bodies
 *   (4.5 MB on Vercel), so clients there upload straight to storage with mediaUploadCreate.
 * - PUT /admin/media/uploads/<key>?token=…: the local driver's direct uploads, authorized by the
 *   signed link from mediaUploadCreate.
 * - GET /media/*: files on local disk, cached immutably. Types are sniffed from the bytes on write;
 *   SVG is never accepted, as it can carry script.
 */

const WRITE_PERMISSIONS = ["catalog:write", "content:write"];

type ErrorCode = "UNAUTHENTICATED" | "PERMISSION_DENIED" | "VALIDATION_FAILED" | "NOT_FOUND" | "INVALID_STATE";
const failure = (code: ErrorCode, message: string, status: number) => Response.json({ error: { code, message } }, { status });
const unauthorized = (message: string) => failure("UNAUTHENTICATED", message, 401);

/** Misconfigured storage (INVALID_STATE) is a 503; any other domain error a 400. */
const errorResponse = (error: unknown) => {
  if (!(error instanceof DomainError)) throw error;
  if (error.code === "UNAUTHENTICATED") return unauthorized(error.message);
  return failure(error.code === "INVALID_STATE" ? "INVALID_STATE" : "VALIDATION_FAILED", error.message, error.code === "INVALID_STATE" ? 503 : 400);
};

/** Bearer staff access token or API key with catalog:write or content:write. */
const authorize = async (platform: Platform, request: Request): Promise<Actor | Response> => {
  const header = request.headers.get("authorization");
  const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  if (!token) return unauthorized("Send Authorization: Bearer <access token or API key>");
  try {
    let granted: Set<string>;
    let staffId: string | null = null;
    if (token.startsWith("ek_")) granted = new Set((await verifyApiKey(platform.db, token)).permissions);
    else {
      const user = await getStaffUser(platform.db, await verifyAccessToken(platform.config, token, "staff"));
      if (!user?.isActive) return unauthorized("The staff account is not active");
      granted = await getStaffPermissions(platform.db, user.id);
      staffId = user.id;
    }
    if (!WRITE_PERMISSIONS.some((permission) => hasPermission(granted, permission))) return failure("PERMISSION_DENIED", `Missing permission ${WRITE_PERMISSIONS.join(" or ")}`, 403);
    return { staffId };
  } catch (error) {
    if (error instanceof DomainError) return unauthorized(error.message);
    throw error;
  }
};

/** A single `bytes=` range of a file of `size` bytes, or null to send it whole. */
const byteRange = (header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null => {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start > end || start >= size ? "unsatisfiable" : { start, end };
};

const readRange = async (file: string, start: number, length: number) => {
  const handle = await open(file, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const mountMedia = (app: Hono, options: { platform: Platform; base: string }) => {
  const { platform, base } = options;
  configureMediaStorage(platform, { base });
  const tooLarge = (c: Context) => c.json({ error: { code: "VALIDATION_FAILED", message: `Files are limited to ${formatBytes(mediaMaxBytes(platform))}` } }, 413);

  /** multipart/form-data with one `file` field. Returns `{ id, url, contentType, size, sha256 }`; `id` is the MediaAsset's. */
  app.post(`${base}/admin/media`, async (c) => {
    const actor = await authorize(platform, c.req.raw);
    if (actor instanceof Response) return actor;
    const maxBytes = mediaMaxBytes(platform);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > maxBytes + 64 * 1024) return tooLarge(c);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return c.json({ error: { code: "VALIDATION_FAILED", message: "Send the file in a multipart `file` field" } }, 400);
    if (file.size > maxBytes) return tooLarge(c);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!sniffMediaType(bytes)) return c.json({ error: { code: "VALIDATION_FAILED", message: `Upload a ${ALLOWED_LABELS} file` } }, 415);
    try {
      const { asset, sha256 } = await storeMedia(platform, { bytes, filename: file.name }, actor);
      return c.json({ id: toGlobalId("MediaAsset", asset.id), url: asset.url, contentType: asset.contentType, size: asset.size, sha256 }, 201);
    } catch (error) {
      return errorResponse(error);
    }
  });

  /** The local driver's direct upload: the raw file as the body, with the Content-Type and size the link was issued for. */
  app.put(`${base}/admin/media/uploads/*`, async (c) => {
    const key = c.req.path.slice(`${base}/admin/media/uploads/`.length);
    let claims;
    try {
      claims = await verifyLocalUpload(platform.config.jwtSecret, c.req.query("token") ?? "");
    } catch (error) {
      return errorResponse(error);
    }
    if (claims.key !== key) return unauthorized("This upload link is for another file");
    let storage;
    try {
      storage = mediaStorage(platform);
    } catch (error) {
      return errorResponse(error);
    }
    if (storage.provider !== "local") return failure("NOT_FOUND", `Uploads go straight to ${storage.provider} storage; request a new target with mediaUploadCreate`, 404);
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== claims.contentType) return failure("VALIDATION_FAILED", `Send Content-Type: ${claims.contentType}`, 415);
    const length = c.req.header("content-length");
    if (length !== undefined && Number(length) !== claims.size) return failure("VALIDATION_FAILED", `Send exactly ${claims.size} bytes, the size this link was issued for`, 400);
    const bytes = await readStream(c.req.raw.body, claims.size, { exact: true });
    if (!bytes || bytes.byteLength !== claims.size) return failure("VALIDATION_FAILED", `Send exactly ${claims.size} bytes, the size this link was issued for`, 400);
    try {
      const { url } = await storage.put(key, bytes, claims.contentType);
      return c.json({ key, url, contentType: claims.contentType, size: bytes.byteLength }, 201);
    } catch (error) {
      if (error instanceof DomainError && error.code === "VALIDATION_FAILED") return failure("VALIDATION_FAILED", error.message, 415);
      return errorResponse(error);
    }
  });

  /** Local files, whatever the configured provider: assets stored before a switch keep working. */
  app.get(`${base}/media/*`, async (c) => {
    const relative = c.req.path.slice(`${base}/${LOCAL_PREFIX}/`.length);
    const file = localMediaFile(platform.config.media.dir, relative);
    const type = file ? mediaTypeByExtension(relative.slice(relative.lastIndexOf(".") + 1)) : null;
    if (!file || !type) return c.notFound();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return c.notFound();
    const headers = {
      "content-type": type.contentType,
      "cache-control": IMMUTABLE_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
    };
    const range = byteRange(c.req.header("range"), info.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${info.size}` } });
    const start = range?.start ?? 0;
    const length = range ? range.end - start + 1 : info.size;
    const body = await readRange(file, start, length);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...headers, "content-length": String(body.byteLength), ...(range ? { "content-range": `bytes ${start}-${start + body.byteLength - 1}/${info.size}` } : {}) },
    });
  });
};
