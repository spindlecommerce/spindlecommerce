import { randomBytes } from "node:crypto";
import { slugify } from "../../lib/i18n.ts";
import { MEDIA_EXTENSIONS, mediaType } from "./formats.ts";

/** How long a direct upload's URL or token stays valid. */
export const UPLOAD_TTL_SECONDS = 15 * 60;
/** Keys are never reused, so stored objects can be cached for a year. */
export const IMMUTABLE_MAX_AGE = 365 * 24 * 60 * 60;
export const IMMUTABLE_CACHE_CONTROL = `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`;

export const DEFAULT_PATH_PREFIX = "media";

export class MediaConfigError extends Error {}

/** MEDIA_PATH_PREFIX without surrounding slashes; `media` when unset. */
export const pathPrefix = (value: string | undefined): string => {
  const prefix = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) return DEFAULT_PATH_PREFIX;
  const segments = prefix.split("/");
  if (segments.some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..")) {
    throw new MediaConfigError(`MEDIA_PATH_PREFIX must be path segments of letters, digits, ".", "_" and "-", e.g. media or shop/media (got ${value})`);
  }
  return prefix;
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Lowercase letters and digits. Bytes of 252 and up are skipped to avoid modulo bias. */
export const randomKeyPart = (length = 10): string => {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 252) out += ALPHABET[byte % 36];
      if (out.length === length) break;
    }
  }
  return out;
};

const SLUG_LENGTH = 60;

/**
 * `<prefix>/<yyyy>/<mm>/<10 random chars>-<filename slug>.<extension>`, never changed afterwards.
 * The extension follows the content type, not the filename.
 */
export const mediaKey = (input: { prefix: string; filename: string; contentType: string; at?: Date; random?: string }): string => {
  const type = mediaType(input.contentType);
  if (!type) throw new Error(`Not a media type: ${input.contentType}`);
  const stem = input.filename.trim().replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const slug = slugify(stem).slice(0, SLUG_LENGTH).replace(/-+$/, "") || "file";
  const at = input.at ?? new Date();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${input.prefix}/${at.getUTCFullYear()}/${month}/${input.random ?? randomKeyPart()}-${slug}.${type.extension}`;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<string, RegExp>();

/** Accepts only mediaKey's shape under this prefix, so clients cannot name arbitrary objects. */
export const isMediaKey = (key: string, prefix: string): boolean => {
  let pattern = patterns.get(prefix);
  if (!pattern) {
    pattern = new RegExp(`^${escapeRegExp(prefix)}/\\d{4}/\\d{2}/[a-z0-9]{10}-[a-z0-9-]{1,${SLUG_LENGTH}}\\.(?:${MEDIA_EXTENSIONS.join("|")})$`);
    patterns.set(prefix, pattern);
  }
  return pattern.test(key);
};

export const keyExtension = (key: string): string => key.slice(key.lastIndexOf(".") + 1);

/** Defensive: keys from mediaKey need no encoding. */
export const keyPath = (key: string): string => key.split("/").map(encodeURIComponent).join("/");
