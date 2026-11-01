import { AwsClient, AwsV4Signer } from "aws4fetch";
import { responsePrefix } from "./formats.ts";
import { IMMUTABLE_CACHE_CONTROL, keyPath, MediaConfigError, pathPrefix, UPLOAD_TTL_SECONDS } from "./keys.ts";
import type { Env, StorageDriver } from "./storage.ts";

/**
 * S3-compatible storage (AWS S3, R2, Supabase Storage, MinIO). Browsers upload with presigned PUT
 * URLs, so the bucket needs a CORS rule allowing PUT with Content-Type from the admin's origin.
 */
export type S3Location = {
  bucket: string;
  /** S3_REGION; `auto` (for R2) becomes us-east-1 on AWS. */
  region: string;
  /** S3_ENDPOINT for S3-compatible services; null for AWS. */
  endpoint: URL | null;
  pathStyle: boolean;
};

export type S3Settings = S3Location & {
  accessKeyId: string;
  secretAccessKey: string;
  /** S3_PUBLIC_URL, a CDN or public bucket URL; null serves the object URL. */
  publicUrl: string | null;
  prefix: string;
};

const truthy = (value: string) => ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

/**
 * Path style is the default with S3_ENDPOINT (MinIO and Supabase need it, R2 accepts it), virtual
 * hosted on AWS. S3_FORCE_PATH_STYLE overrides either.
 */
export const s3Location = (env: Env): S3Location => {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) throw new MediaConfigError("S3_BUCKET is required for S3 storage");
  let endpoint: URL | null = null;
  if (env.S3_ENDPOINT?.trim()) {
    try {
      endpoint = new URL(env.S3_ENDPOINT.trim());
    } catch {
      throw new MediaConfigError(`S3_ENDPOINT must be a URL such as https://<account id>.r2.cloudflarestorage.com (got ${env.S3_ENDPOINT})`);
    }
  }
  const region = env.S3_REGION?.trim() || "auto";
  const forced = env.S3_FORCE_PATH_STYLE?.trim();
  return { bucket, region: !endpoint && region === "auto" ? "us-east-1" : region, endpoint, pathStyle: forced ? truthy(forced) : endpoint !== null };
};

export const s3Settings = (env: Env): S3Settings => {
  const location = s3Location(env);
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new MediaConfigError("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for S3 storage");
  const publicUrl = env.S3_PUBLIC_URL?.trim().replace(/\/+$/, "") || null;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new MediaConfigError(`S3_PUBLIC_URL must be an http(s) URL (got ${env.S3_PUBLIC_URL})`);
  return { ...location, accessKeyId, secretAccessKey, publicUrl, prefix: pathPrefix(env.MEDIA_PATH_PREFIX) };
};

export const s3ObjectUrl = (s: S3Location, key: string): string => {
  const path = keyPath(key);
  if (s.endpoint) {
    const basePath = s.endpoint.pathname.replace(/\/+$/, "");
    return s.pathStyle ? `${s.endpoint.origin}${basePath}/${encodeURIComponent(s.bucket)}/${path}` : `${s.endpoint.protocol}//${s.bucket}.${s.endpoint.host}${basePath}/${path}`;
  }
  const host = `s3.${s.region}.amazonaws.com`;
  return s.pathStyle ? `https://${host}/${encodeURIComponent(s.bucket)}/${path}` : `https://${s.bucket}.${host}/${path}`;
};

/** SigV4's timestamp format, e.g. 20261026T120000Z. */
export const amzDate = (at: Date) => at.toISOString().replace(/[:-]|\.\d{3}/g, "");

/** Every header given is signed, so the request must send each with exactly that value. */
export const presignS3 = async (
  s: S3Settings,
  input: { method: string; key: string; headers?: Record<string, string>; expiresIn: number; at?: Date },
): Promise<string> => {
  const url = new URL(s3ObjectUrl(s, input.key));
  url.searchParams.set("X-Amz-Expires", String(input.expiresIn));
  const signer = new AwsV4Signer({
    method: input.method,
    url: url.toString(),
    headers: input.headers ?? {},
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    service: "s3",
    region: s.region,
    signQuery: true,
    allHeaders: true,
    datetime: amzDate(input.at ?? new Date()),
  });
  return (await signer.sign()).url.toString();
};

/** Signs type and size, so S3 refuses any other; browsers set Content-Length themselves. */
export const presignS3Upload = (s: S3Settings, input: { key: string; contentType: string; size: number; at?: Date }) =>
  presignS3(s, { method: "PUT", key: input.key, headers: { "content-type": input.contentType, "content-length": String(input.size) }, expiresIn: UPLOAD_TTL_SECONDS, at: input.at });

const TIMEOUT_MS = 30_000;

/** A short reason from an S3 error response, e.g. "403 AccessDenied". */
const failure = async (response: Response, action: string) => {
  const body = await response.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  return new Error(`S3 ${action} failed: ${response.status}${code ? ` ${code}` : ""}`);
};

export const createS3Driver = (s: S3Settings): StorageDriver => {
  const client = new AwsClient({ accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, service: "s3", region: s.region, retries: 2 });
  const send = (key: string, init: RequestInit) => client.fetch(s3ObjectUrl(s, key), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const publicUrl = (key: string) => (s.publicUrl ? `${s.publicUrl}/${keyPath(key)}` : s3ObjectUrl(s, key));
  return {
    provider: "s3",
    prefix: s.prefix,
    publicUrl,
    createUpload: async ({ key, contentType, size }) => {
      const at = new Date();
      return {
        provider: "s3",
        key,
        publicUrl: publicUrl(key),
        method: "PUT",
        url: await presignS3Upload(s, { key, contentType, size, at }),
        headers: { "Content-Type": contentType },
        clientToken: null,
        pathname: null,
        expiresAt: new Date(at.getTime() + UPLOAD_TTL_SECONDS * 1000),
      };
    },
    head: async (key) => {
      const response = await send(key, { method: "HEAD" });
      // Without s3:ListBucket, S3 answers 403 rather than 404 for a missing object.
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(response, `HEAD ${key}`);
      return { size: Number(response.headers.get("content-length") ?? 0), contentType: response.headers.get("content-type"), url: null };
    },
    readStart: async (key, length) => responsePrefix(await send(key, { method: "GET", headers: { range: `bytes=0-${length - 1}` } }), length),
    put: async (key, bytes, contentType) => {
      // A copy on a plain ArrayBuffer, which fetch's body type requires.
      const response = await send(key, { method: "PUT", headers: { "content-type": contentType, "cache-control": IMMUTABLE_CACHE_CONTROL }, body: new Uint8Array(bytes) });
      if (!response.ok) throw await failure(response, `PUT ${key}`);
      await response.body?.cancel().catch(() => {});
      return { url: publicUrl(key) };
    },
    delete: async (key) => {
      const response = await send(key, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw await failure(response, `DELETE ${key}`);
      await response.body?.cancel().catch(() => {});
    },
  };
};
