import type { Config } from "../../config.ts";
import { InvalidStateError } from "../../lib/errors.ts";
import type { Platform } from "../../platform.ts";
import { MediaConfigError, pathPrefix } from "./keys.ts";
import { createLocalDriver } from "./local.ts";
import { createS3Driver, s3Location, s3ObjectUrl, s3Settings } from "./s3.ts";
import type { MediaProvider } from "./tables.ts";
import { blobApiOrigins, createBlobDriver } from "./vercel-blob.ts";

export type { MediaProvider };
export type Env = Record<string, string | undefined>;

/** Where and how a client sends a file's bytes (the GraphQL MediaUpload type). */
export type UploadTarget = {
  provider: MediaProvider;
  key: string;
  publicUrl: string;
  method: "PUT";
  /** LOCAL: a path on the API with a signed token. S3: a presigned URL. Null for Vercel Blob. */
  url: string | null;
  headers: Record<string, string>;
  /** Vercel Blob: the client token for `put()` from `@vercel/blob/client`. */
  clientToken: string | null;
  /** Vercel Blob: the pathname to put to (the key). */
  pathname: string | null;
  expiresAt: Date;
};

/** `url` is the store's canonical URL, when it gives one. */
export type StoredObject = { size: number; contentType: string | null; url: string | null };

/**
 * Local disk, Vercel Blob or S3-compatible storage. Clients upload straight to the store, so files
 * never hit a serverless function's 4.5 MB body limit; `put` is for bytes the server already has.
 */
export type StorageDriver = {
  provider: MediaProvider;
  /** Keys this store issues start with `<prefix>/`. */
  prefix: string;
  createUpload(input: { key: string; contentType: string; size: number }): Promise<UploadTarget>;
  head(key: string): Promise<StoredObject | null>;
  /** For sniffing the type and image dimensions. Null if the object is missing. */
  readStart(key: string, length: number): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
};

const PROVIDERS: MediaProvider[] = ["local", "vercel-blob", "s3"];

/** MEDIA_STORAGE; else vercel-blob with BLOB_READ_WRITE_TOKEN, s3 with S3_BUCKET, or local. */
export const mediaProvider = (env: Env = process.env): MediaProvider => {
  const explicit = env.MEDIA_STORAGE?.trim().toLowerCase();
  if (explicit) {
    if ((PROVIDERS as string[]).includes(explicit)) return explicit as MediaProvider;
    throw new MediaConfigError(`MEDIA_STORAGE must be local, vercel-blob or s3 (got ${env.MEDIA_STORAGE})`);
  }
  if (env.BLOB_READ_WRITE_TOKEN?.trim()) return "vercel-blob";
  if (env.S3_BUCKET?.trim()) return "s3";
  return "local";
};

/** Direct-upload origins for the admin's CSP; local needs none ('self'). Never throws. */
export const mediaUploadOrigins = (env: Env = process.env): string[] => {
  try {
    const provider = mediaProvider(env);
    if (provider === "vercel-blob") return blobApiOrigins(env);
    if (provider === "s3") return [new URL(s3ObjectUrl(s3Location(env), "media")).origin];
    return [];
  } catch {
    return [];
  }
};

/** The API's URL as browsers reach it, for local files. */
export const localPublicBase = (env: Env, config: Pick<Config, "admin" | "port">, base: string): string => {
  const explicit = env.MEDIA_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const admin = config.admin.url.replace(/\/+$/, "");
  return admin.endsWith(`${base}/admin`) ? admin.slice(0, -"/admin".length) : `http://localhost:${config.port}${base}`;
};

/** On Vercel, with no persistent disk. VERCEL_ENV=development is a local run (vercel env pull). */
const onVercel = (env: Env) => env.VERCEL === "1" && env.VERCEL_ENV !== "development";

export const createStorageDriver = (options: { config: Pick<Config, "admin" | "port" | "media" | "jwtSecret">; env?: Env; base?: string; provider?: MediaProvider }): StorageDriver => {
  const env = options.env ?? process.env;
  const base = options.base ?? "";
  const provider = options.provider ?? mediaProvider(env);
  if (provider === "vercel-blob") {
    const token = env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!token) throw new MediaConfigError("BLOB_READ_WRITE_TOKEN is required for Vercel Blob storage");
    return createBlobDriver({ token, prefix: pathPrefix(env.MEDIA_PATH_PREFIX) });
  }
  if (provider === "s3") return createS3Driver(s3Settings(env));
  return createLocalDriver({
    dir: options.config.media.dir,
    publicBase: localPublicBase(env, options.config, base),
    basePath: base,
    secret: options.config.jwtSecret,
    ephemeral: onVercel(env),
  });
};

type Registration = { base: string; env: Env; current: StorageDriver | Error; others: Map<MediaProvider, StorageDriver | null> };
const registrations = new WeakMap<Platform, Registration>();

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Logs a configuration error rather than throwing it, so the rest of the API keeps serving. */
export const configureMediaStorage = (platform: Platform, options: { base?: string; env?: Env } = {}): StorageDriver | null => {
  const base = options.base ?? "";
  const env = options.env ?? process.env;
  let current: StorageDriver | Error;
  try {
    current = createStorageDriver({ config: platform.config, env, base });
  } catch (error) {
    current = error instanceof Error ? error : new Error(describe(error));
    platform.logger.error({ err: current }, `Media storage is misconfigured: ${current.message}`);
  }
  registrations.set(platform, { base, env, current, others: new Map() });
  return current instanceof Error ? null : current;
};

const registration = (platform: Platform): Registration => {
  if (!registrations.has(platform)) configureMediaStorage(platform);
  return registrations.get(platform)!;
};

/** Throws InvalidStateError while the storage configuration is broken. */
export const mediaStorage = (platform: Platform): StorageDriver => {
  const { current } = registration(platform);
  if (current instanceof Error) throw new InvalidStateError(`Media storage is not configured correctly: ${current.message}`);
  return current;
};

/** An asset's store, possibly from before a provider switch. Null if the env can't set it up. */
export const storageForProvider = (platform: Platform, provider: MediaProvider): StorageDriver | null => {
  const entry = registration(platform);
  if (!(entry.current instanceof Error) && entry.current.provider === provider) return entry.current;
  if (!entry.others.has(provider)) {
    let driver: StorageDriver | null = null;
    try {
      driver = createStorageDriver({ config: platform.config, env: entry.env, base: entry.base, provider });
    } catch (error) {
      platform.logger.warn({ err: error }, `Cannot reach ${provider} media storage: ${describe(error)}`);
    }
    entry.others.set(provider, driver);
  }
  return entry.others.get(provider)!;
};
