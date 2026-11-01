import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import { AuthenticationError, InvalidStateError, ValidationError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { ALLOWED_LABELS, MEDIA_EXTENSIONS, sniffMediaType, SNIFF_BYTES } from "./formats.ts";
import { isMediaKey, UPLOAD_TTL_SECONDS } from "./keys.ts";
import type { StorageDriver } from "./storage.ts";

/**
 * Files under MEDIA_DIR, served by the API at /media/*, for development and single-node servers.
 * Keys start with this prefix, also the route: media/2026/10/x.png is MEDIA_DIR/2026/10/x.png.
 */
export const LOCAL_PREFIX = "media";

/** Content-addressed files from before the media library (`ab/<sha-256>.png`), still served. */
const LEGACY_FILE = new RegExp(`^[0-9a-f]{2}/[0-9a-f]{64}\\.(?:${MEDIA_EXTENSIONS.join("|")})$`);

/** Null for any path this store did not write, including ones escaping MEDIA_DIR. */
export const localMediaFile = (dir: string, relative: string): string | null => {
  if (!LEGACY_FILE.test(relative) && !isMediaKey(`${LOCAL_PREFIX}/${relative}`, LOCAL_PREFIX)) return null;
  const root = resolve(dir);
  const file = join(root, relative);
  return file.startsWith(root + sep) ? file : null;
};

const AUDIENCE = "ecom:media-upload";

export type LocalUploadClaims = { key: string; contentType: string; size: number; expiresAt: Date };

/** Signs the key, type and size, so the upload link allows nothing else. */
export const signLocalUpload = async (secret: Uint8Array, input: { key: string; contentType: string; size: number; ttlSeconds?: number }) => {
  const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? UPLOAD_TTL_SECONDS) * 1000);
  const token = await new SignJWT({ typ: "media-upload", key: input.key, ct: input.contentType, size: input.size })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("ecom")
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(newId())
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);
  return { token, expiresAt };
};

export const verifyLocalUpload = async (secret: Uint8Array, token: string): Promise<LocalUploadClaims> => {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: "ecom", audience: AUDIENCE, algorithms: ["HS256"] });
    const { key, ct, size } = payload;
    if (payload.typ !== "media-upload" || typeof key !== "string" || typeof ct !== "string" || typeof size !== "number" || !payload.exp) throw new Error("wrong token type");
    return { key, contentType: ct, size, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    throw new AuthenticationError("The upload link has expired or is invalid; request a new one with mediaUploadCreate");
  }
};

const readFileStart = async (file: string, length: number): Promise<Uint8Array | null> => {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const createLocalDriver = (options: {
  dir: string;
  /** The API's URL as browsers reach it. */
  publicBase: string;
  /** The app's base path; upload links are paths on the API. */
  basePath: string;
  secret: Uint8Array;
  /** No persistent disk (Vercel), so writes are refused. */
  ephemeral: boolean;
}): StorageDriver => {
  const fileFor = (key: string) => {
    const file = key.startsWith(`${LOCAL_PREFIX}/`) ? localMediaFile(options.dir, key.slice(LOCAL_PREFIX.length + 1)) : null;
    if (!file) throw new ValidationError("Unknown media key", [{ path: ["key"], message: "Not a key this store issued" }]);
    return file;
  };
  const writable = () => {
    if (options.ephemeral) throw new InvalidStateError("Local media storage does not persist on Vercel; connect a Vercel Blob store (BLOB_READ_WRITE_TOKEN) or set the S3_* variables");
  };
  const publicUrl = (key: string) => `${options.publicBase}/${key}`;
  return {
    provider: "local",
    prefix: LOCAL_PREFIX,
    publicUrl,
    createUpload: async ({ key, contentType, size }) => {
      writable();
      fileFor(key);
      const { token, expiresAt } = await signLocalUpload(options.secret, { key, contentType, size });
      return {
        provider: "local",
        key,
        publicUrl: publicUrl(key),
        method: "PUT",
        url: `${options.basePath}/admin/media/uploads/${key}?token=${encodeURIComponent(token)}`,
        headers: { "Content-Type": contentType },
        clientToken: null,
        pathname: null,
        expiresAt,
      };
    },
    head: async (key) => {
      const file = fileFor(key);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return null;
      const start = await readFileStart(file, SNIFF_BYTES);
      // Files carry no content type; the bytes are the type.
      return { size: info.size, contentType: start ? (sniffMediaType(start)?.contentType ?? "application/octet-stream") : null, url: null };
    },
    readStart: async (key, length) => readFileStart(fileFor(key), length),
    put: async (key, bytes, contentType) => {
      writable();
      const file = fileFor(key);
      const type = sniffMediaType(bytes);
      if (!type) throw new ValidationError(`Upload a ${ALLOWED_LABELS} file`, [{ path: ["file"], message: "The file's content is not an accepted type" }]);
      if (type.contentType !== contentType) throw new ValidationError(`The file is a ${type.label}, not ${contentType}`, [{ path: ["file"], message: `The file's content is ${type.contentType}` }]);
      await mkdir(dirname(file), { recursive: true });
      // Write then rename, so a reader never sees half a file.
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { url: publicUrl(key) };
    },
    delete: async (key) => {
      await rm(fileFor(key), { force: true });
    },
  };
};
