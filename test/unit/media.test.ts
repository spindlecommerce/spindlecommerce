import { getPayloadFromClientToken } from "@vercel/blob/client";
import { describe, expect, it } from "vitest";
import { imageDimensions, sniffMediaType } from "../../src/modules/media/formats.ts";
import { isMediaKey, mediaKey, pathPrefix, randomKeyPart } from "../../src/modules/media/keys.ts";
import { presignS3, presignS3Upload, s3Location, s3Settings, createS3Driver } from "../../src/modules/media/s3.ts";
import { createStorageDriver, localPublicBase, mediaProvider, mediaUploadOrigins } from "../../src/modules/media/storage.ts";
import { createBlobDriver } from "../../src/modules/media/vercel-blob.ts";
import { avif, box, bytes, gif, jpeg, mp4, png, u32, webpExtended, webpLossless, webpLossy } from "../helpers/media.ts";

// ---------------------------------------------------------------- formats

describe("media types", () => {
  it("recognizes accepted files by their bytes, never SVG or other look-alikes", () => {
    expect(sniffMediaType(png(3, 2))?.contentType).toBe("image/png");
    expect(sniffMediaType(jpeg(3, 2))?.contentType).toBe("image/jpeg");
    expect(sniffMediaType(gif(3, 2))?.contentType).toBe("image/gif");
    expect(sniffMediaType(webpLossy(3, 2))?.contentType).toBe("image/webp");
    expect(sniffMediaType(avif(false))?.contentType).toBe("image/avif");
    expect(sniffMediaType(mp4())?.contentType).toBe("video/mp4");
    // AVIF with a generic major brand is still AVIF, not MP4.
    expect(sniffMediaType(bytes(box("ftyp", bytes("mif1", u32(0), "mif1", "avif"))))?.contentType).toBe("image/avif");
    expect(sniffMediaType(bytes(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))).toBeNull();
    expect(sniffMediaType(bytes("<!doctype html><img src=x onerror=alert(1)>"))).toBeNull();
    expect(sniffMediaType(bytes(box("ftyp", bytes("heic", u32(0), "mif1", "heic"))))).toBeNull();
    expect(sniffMediaType(bytes(box("ftyp", bytes("qt  ", u32(0), "qt  "))))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });

  it("reads image dimensions from headers", () => {
    expect(imageDimensions(png(3, 2))).toEqual({ width: 3, height: 2 });
    expect(imageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(webpLossy(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpLossless(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(webpExtended(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(jpeg(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(imageDimensions(jpeg(1200, 800, 3))).toEqual({ width: 1200, height: 800 });
    // EXIF orientations 5–8 turn the picture a quarter: a phone's portrait photo stored landscape.
    expect(imageDimensions(jpeg(4032, 3024, 6))).toEqual({ width: 3024, height: 4032 });
    expect(imageDimensions(avif(false))).toEqual({ width: 3, height: 2 });
    expect(imageDimensions(avif(true))).toEqual({ width: 2, height: 3 });
  });

  it("gives up on videos and cut-off or damaged headers instead of guessing", () => {
    expect(imageDimensions(mp4())).toBeNull();
    expect(imageDimensions(png(3, 2).subarray(0, 20))).toBeNull();
    expect(imageDimensions(jpeg(1200, 800).subarray(0, 26))).toBeNull();
    expect(imageDimensions(webpLossy(640, 480).subarray(0, 27))).toBeNull();
    expect(imageDimensions(avif(false).subarray(0, 60))).toBeNull();
    // A damaged EXIF block loses only the orientation.
    const broken = jpeg(1200, 800, 6);
    broken[2 + 18 + 4 + 6 + 7] = 0x7f; // IFD offset far past the segment
    expect(imageDimensions(broken)).toEqual({ width: 1200, height: 800 });
  });
});

// ---------------------------------------------------------------- keys

describe("media keys", () => {
  const at = new Date("2026-10-26T12:00:00Z");

  it("names objects <prefix>/<yyyy>/<mm>/<random>-<slug>.<extension of the real type>", () => {
    expect(mediaKey({ prefix: "media", filename: "Summer Shirt (Front).JPG", contentType: "image/jpeg", at, random: "abcdefghij" })).toBe("media/2026/10/abcdefghij-summer-shirt-front.jpg");
    expect(mediaKey({ prefix: "shop/media", filename: "photo.png", contentType: "image/webp", at, random: "0123456789" })).toBe("shop/media/2026/10/0123456789-photo.webp");
    expect(mediaKey({ prefix: "media", filename: "Crème brûlée.avif", contentType: "image/avif", at, random: "abcdefghij" })).toBe("media/2026/10/abcdefghij-creme-brulee.avif");
    expect(mediaKey({ prefix: "media", filename: "日本.png", contentType: "image/png", at, random: "abcdefghij" })).toBe("media/2026/10/abcdefghij-file.png");
    const long = mediaKey({ prefix: "media", filename: `${"very-long-name-".repeat(10)}.mp4`, contentType: "video/mp4", at, random: "abcdefghij" });
    expect(long.split("/").at(-1)!.length).toBeLessThanOrEqual(10 + 1 + 60 + 4);
    expect(isMediaKey(long, "media")).toBe(true);
  });

  it("makes keys unique and only accepts keys of that shape", () => {
    const parts = new Set(Array.from({ length: 2000 }, () => randomKeyPart()));
    expect(parts.size).toBe(2000);
    for (const part of parts) expect(part).toMatch(/^[a-z0-9]{10}$/);
    const key = mediaKey({ prefix: "media", filename: "a.png", contentType: "image/png" });
    expect(key).toMatch(/^media\/\d{4}\/\d{2}\/[a-z0-9]{10}-a\.png$/);
    expect(isMediaKey(key, "media")).toBe(true);
    expect(isMediaKey(key, "other")).toBe(false);
    for (const bad of ["media/../../etc/passwd", "media/2026/10/abcdefghij-x.svg", "media/2026/10/short-x.png", "media/2026/10/abcdefghij-x.png/../y.png", "/media/2026/10/abcdefghij-x.png"]) {
      expect(isMediaKey(bad, "media"), bad).toBe(false);
    }
  });

  it("reads MEDIA_PATH_PREFIX", () => {
    expect(pathPrefix(undefined)).toBe("media");
    expect(pathPrefix(" /shop/media/ ")).toBe("shop/media");
    expect(() => pathPrefix("a/../b")).toThrow(/MEDIA_PATH_PREFIX/);
    expect(() => pathPrefix("has space")).toThrow(/MEDIA_PATH_PREFIX/);
  });
});

// ---------------------------------------------------------------- providers

describe("storage configuration", () => {
  it("picks a provider: MEDIA_STORAGE, else a Blob token, else an S3 bucket, else local disk", () => {
    expect(mediaProvider({})).toBe("local");
    expect(mediaProvider({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret", S3_BUCKET: "b" })).toBe("vercel-blob");
    expect(mediaProvider({ S3_BUCKET: "b" })).toBe("s3");
    expect(mediaProvider({ MEDIA_STORAGE: "LOCAL", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret" })).toBe("local");
    expect(() => mediaProvider({ MEDIA_STORAGE: "ftp" })).toThrow(/MEDIA_STORAGE/);
  });

  it("lists the origins browsers upload to, for the admin's CSP, without throwing", () => {
    expect(mediaUploadOrigins({})).toEqual([]);
    expect(mediaUploadOrigins({ MEDIA_STORAGE: "local", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret" })).toEqual([]);
    expect(mediaUploadOrigins({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret" })).toEqual(["https://vercel.com"]);
    expect(mediaUploadOrigins({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store_secret", VERCEL_BLOB_API_URL: "https://blob-proxy.example.com/api/blob" })).toEqual([
      "https://blob-proxy.example.com",
      "https://vercel.com",
    ]);
    expect(mediaUploadOrigins({ S3_BUCKET: "shop-media", S3_REGION: "eu-west-1" })).toEqual(["https://shop-media.s3.eu-west-1.amazonaws.com"]);
    expect(mediaUploadOrigins({ S3_BUCKET: "shop-media" })).toEqual(["https://shop-media.s3.us-east-1.amazonaws.com"]);
    expect(mediaUploadOrigins({ S3_BUCKET: "shop-media", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" })).toEqual(["https://acct.r2.cloudflarestorage.com"]);
    expect(mediaUploadOrigins({ S3_BUCKET: "shop-media", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", S3_FORCE_PATH_STYLE: "false" })).toEqual(["https://shop-media.acct.r2.cloudflarestorage.com"]);
    expect(mediaUploadOrigins({ S3_BUCKET: "shop-media", S3_ENDPOINT: "http://localhost:9000" })).toEqual(["http://localhost:9000"]);
    expect(mediaUploadOrigins({ MEDIA_STORAGE: "ftp" })).toEqual([]);
    expect(mediaUploadOrigins({ MEDIA_STORAGE: "s3" })).toEqual([]);
  });

  it("serves local files from MEDIA_PUBLIC_URL, else the API that serves the admin", () => {
    const config = { admin: { url: "http://localhost:4000/admin" }, port: 4000 } as Parameters<typeof localPublicBase>[1];
    expect(localPublicBase({}, config, "")).toBe("http://localhost:4000");
    expect(localPublicBase({ MEDIA_PUBLIC_URL: "https://cdn.example.com/" }, config, "")).toBe("https://cdn.example.com");
    expect(localPublicBase({}, { ...config, admin: { ...config.admin, url: "https://shop.example.com/api/admin" } }, "/api")).toBe("https://shop.example.com/api");
    expect(localPublicBase({}, config, "/api")).toBe("http://localhost:4000/api");
  });

  const config = { admin: { url: "http://localhost:4000/admin" }, port: 4000, media: { dir: ".data/media", maxBytes: 1000 }, jwtSecret: new Uint8Array(32) } as Parameters<typeof createStorageDriver>[0]["config"];

  it("refuses local storage on a Vercel deployment, which has no persistent disk", async () => {
    const upload = { key: "media/2026/10/abcdefghij-x.png", contentType: "image/png", size: 1 };
    await expect(createStorageDriver({ config, env: { VERCEL: "1", VERCEL_ENV: "preview" } }).createUpload(upload)).rejects.toThrow(/does not persist on Vercel/);
    // `vercel env pull` writes VERCEL=1 into local env files: still a local run.
    await expect(createStorageDriver({ config, env: { VERCEL: "1", VERCEL_ENV: "development" } }).createUpload(upload)).resolves.toMatchObject({ provider: "local" });
  });

  it("explains configuration mistakes", () => {
    expect(() => createStorageDriver({ config, env: { MEDIA_STORAGE: "s3" } })).toThrow(/S3_BUCKET is required/);
    expect(() => createStorageDriver({ config, env: { S3_BUCKET: "b" } })).toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    expect(() => createStorageDriver({ config, env: { S3_BUCKET: "b", S3_ENDPOINT: "not a url", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" } })).toThrow(/S3_ENDPOINT/);
    expect(() => createStorageDriver({ config, env: { MEDIA_STORAGE: "vercel-blob" } })).toThrow(/BLOB_READ_WRITE_TOKEN is required/);
    expect(() => createStorageDriver({ config, env: { BLOB_READ_WRITE_TOKEN: "not-a-token" } })).toThrow(/read-write token/);
    expect(createStorageDriver({ config, env: {} }).provider).toBe("local");
  });
});

// ---------------------------------------------------------------- S3

describe("S3 presigned uploads", () => {
  const r2 = { S3_BUCKET: "shop-media", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", S3_ACCESS_KEY_ID: "AKIDEXAMPLE", S3_SECRET_ACCESS_KEY: "secret" };

  it("signs like AWS's documented example (query-string SigV4)", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const settings = s3Settings({
      S3_BUCKET: "examplebucket",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "https://s3.amazonaws.com",
      S3_FORCE_PATH_STYLE: "false",
      S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    const url = new URL(await presignS3(settings, { method: "GET", key: "test.txt", expiresIn: 86400, at: new Date("2013-05-24T00:00:00Z") }));
    expect(`${url.origin}${url.pathname}`).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("presigns a PUT for 15 minutes that requires the declared Content-Type and size", async () => {
    const settings = s3Settings(r2);
    const at = new Date("2026-10-26T12:00:00Z");
    const url = new URL(await presignS3Upload(settings, { key: "media/2026/10/abcdefghij-shirt.png", contentType: "image/png", size: 1234, at }));
    expect(`${url.origin}${url.pathname}`).toBe("https://acct.r2.cloudflarestorage.com/shop-media/media/2026/10/abcdefghij-shirt.png");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AKIDEXAMPLE/20261026/auto/s3/aws4_request",
      "X-Amz-Date": "20261026T120000Z",
      "X-Amz-Expires": "900",
      "X-Amz-SignedHeaders": "content-length;content-type;host",
      "X-Amz-Signature": expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const other = new URL(await presignS3Upload(settings, { key: "media/2026/10/abcdefghij-shirt.png", contentType: "image/jpeg", size: 1234, at }));
    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(url.searchParams.get("X-Amz-Signature"));
  });

  it("addresses AWS, R2, Supabase and MinIO buckets", () => {
    const at = (env: Record<string, string>) => new URL(createS3Driver(s3Settings({ ...r2, ...env })).publicUrl("media/x.png")).toString();
    expect(s3Location({ S3_BUCKET: "b", S3_REGION: "eu-west-1" })).toMatchObject({ region: "eu-west-1", pathStyle: false, endpoint: null });
    expect(at({ S3_ENDPOINT: "", S3_REGION: "eu-west-1" })).toBe("https://shop-media.s3.eu-west-1.amazonaws.com/media/x.png");
    expect(at({ S3_ENDPOINT: "", S3_REGION: "eu-west-1", S3_FORCE_PATH_STYLE: "true" })).toBe("https://s3.eu-west-1.amazonaws.com/shop-media/media/x.png");
    expect(at({ S3_ENDPOINT: "https://abc.supabase.co/storage/v1/s3", S3_REGION: "us-east-1" })).toBe("https://abc.supabase.co/storage/v1/s3/shop-media/media/x.png");
    expect(at({ S3_ENDPOINT: "http://localhost:9000" })).toBe("http://localhost:9000/shop-media/media/x.png");
    // Objects are served from S3_PUBLIC_URL (a CDN or public bucket URL) when set.
    expect(at({ S3_PUBLIC_URL: "https://media.example.com/" })).toBe("https://media.example.com/media/x.png");
  });

  it("returns the upload target without contacting S3", async () => {
    const driver = createS3Driver(s3Settings({ ...r2, S3_PUBLIC_URL: "https://pub-123.r2.dev", MEDIA_PATH_PREFIX: "shop" }));
    const before = Date.now();
    const upload = await driver.createUpload({ key: "shop/2026/10/abcdefghij-shirt.png", contentType: "image/png", size: 99 });
    expect(upload).toMatchObject({ provider: "s3", method: "PUT", headers: { "Content-Type": "image/png" }, clientToken: null, pathname: null, publicUrl: "https://pub-123.r2.dev/shop/2026/10/abcdefghij-shirt.png" });
    expect(upload.url).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/shop-media\/shop\/2026\/10\/abcdefghij-shirt\.png\?/);
    expect(upload.expiresAt.getTime() - before).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(driver.prefix).toBe("shop");
  });
});

// ---------------------------------------------------------------- Vercel Blob

describe("Vercel Blob client tokens", () => {
  it("limits the token to one pathname, the declared type and size, for 15 minutes, without contacting Vercel", async () => {
    const driver = createBlobDriver({ token: "vercel_blob_rw_StoreAbc123_secretsecret", prefix: "media" });
    const key = "media/2026/10/abcdefghij-shirt.png";
    const before = Date.now();
    const upload = await driver.createUpload({ key, contentType: "image/png", size: 1234 });
    expect(upload).toMatchObject({ provider: "vercel-blob", key, pathname: key, url: null, method: "PUT", headers: {}, publicUrl: `https://storeabc123.public.blob.vercel-storage.com/${key}` });
    expect(upload.clientToken).toMatch(/^vercel_blob_client_StoreAbc123_/);
    const payload = getPayloadFromClientToken(upload.clientToken!);
    expect(payload).toMatchObject({ pathname: key, allowedContentTypes: ["image/png"], maximumSizeInBytes: 1234, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 });
    expect(payload.validUntil - before).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(payload.validUntil - before).toBeLessThanOrEqual(15 * 60_000 + 5000);
    expect(upload.expiresAt.getTime()).toBe(payload.validUntil);
  });
});
