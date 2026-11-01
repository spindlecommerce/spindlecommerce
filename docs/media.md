# Media library

Products and pages use images and videos by URL. The media library keeps one record per uploaded file (`media_assets`) with its storage, URL, type, size, dimensions and alt text per locale, and shows where each file is used. Browsers upload straight to storage, not through the API, so uploads work on serverless hosts. Vercel functions, for example, cap request bodies at 4.5 MB and have no persistent disk.

Code: [`src/modules/media/`](../src/modules/media) (storage drivers, formats, the asset service), [`src/graphql/types/media.ts`](../src/graphql/types/media.ts) and [`src/http/media.ts`](../src/http/media.ts).

## Choosing storage

`MEDIA_STORAGE` picks the provider: `vercel-blob`, `s3` or `local`. When it is unset, the provider is Vercel Blob if `BLOB_READ_WRITE_TOKEN` is set, else S3-compatible storage if `S3_BUCKET` is set, else local disk. The admin API reports the choice with `mediaStorage { provider maxBytes allowedContentTypes }`.

A broken configuration, such as S3 without credentials, does not stop the API. The error is logged at startup, and until it is fixed, media operations fail with an `InvalidStateError` that names the problem.

### Vercel Blob

Connect a Blob store to the Vercel project (Storage › Blob), which sets `BLOB_READ_WRITE_TOKEN`.

| Variable | Default | Notes |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | none | The store's read-write token (`vercel_blob_rw_…`). |
| `MEDIA_PATH_PREFIX` | `media` | Object paths start with it, so the store can hold other files. |

- **Serving.** Files are public, at `https://<store id>.public.blob.vercel-storage.com/<key>`, and cached for a year.
- **Uploads.** The API issues a client token with `generateClientTokenFromReadWriteToken`, limited to one pathname and the declared content type and size.
- **The browser** uploads with `put()` from `@vercel/blob/client`, which calls `https://vercel.com/api/blob`. `VERCEL_BLOB_API_URL` overrides that address.

### S3-compatible storage

AWS S3, and the S3 APIs of Cloudflare R2, Supabase Storage and MinIO. Requests are signed with SigV4 (`aws4fetch`).

| Variable | Default | Notes |
|---|---|---|
| `S3_BUCKET` | none | Required. |
| `S3_REGION` | `auto` | R2: `auto`. AWS: the bucket's region (`auto` means `us-east-1` there). Supabase: the project's region. |
| `S3_ENDPOINT` | AWS | The S3 API URL of other providers (examples below). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | Required. |
| `S3_PUBLIC_URL` | the object's S3 URL | The base URL objects are served from: a CDN, a custom domain or a public bucket URL. Without it, URLs point at the S3 API itself, which only works for public-read AWS buckets. |
| `S3_FORCE_PATH_STYLE` | `true` with `S3_ENDPOINT`, `false` on AWS | Path style is `<endpoint>/<bucket>/<key>`, virtual-hosted style `<bucket>.<host>/<key>`. MinIO and Supabase need path style. R2 accepts both. |
| `MEDIA_PATH_PREFIX` | `media` | Keys start with it. |

**Cloudflare R2**

```sh
S3_BUCKET=shop-media
S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…            # an R2 API token with Object Read & Write on the bucket
S3_SECRET_ACCESS_KEY=…
S3_PUBLIC_URL=https://media.example.com   # the bucket's custom domain, or its https://pub-….r2.dev URL
```

**Supabase Storage**

Use a public bucket, and S3 access keys from the project's Storage settings (S3 Connection).

```sh
S3_BUCKET=media
S3_REGION=<project region, e.g. eu-central-1>
S3_ENDPOINT=https://<project ref>.supabase.co/storage/v1/s3
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_PUBLIC_URL=https://<project ref>.supabase.co/storage/v1/object/public/media
```

**AWS S3**

```sh
S3_BUCKET=shop-media
S3_REGION=eu-west-1
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_PUBLIC_URL=https://d1234.cloudfront.net   # or unset, for a public-read bucket
```

**MinIO (local S3)**

```sh
S3_BUCKET=shop                # with anonymous download allowed
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_PUBLIC_URL=http://localhost:9000/shop
```

**Credentials** must allow putting, getting and deleting objects. On AWS they also need `s3:ListBucket`, or S3 answers a request for a missing object with 403 rather than 404.

**CORS.** Browsers PUT straight to the bucket, so its CORS rules must allow the admin's origin. On S3 and R2 the rule is:

```json
[{ "AllowedOrigins": ["https://admin.example.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```

**Uploads.** Each upload gets a presigned PUT URL. `Content-Type` and `Content-Length` are part of the signature, so the object gets exactly the declared type, and S3 refuses a body of any other size before storing anything. Browsers set `Content-Length` themselves.

### Local disk

For development, Docker and single servers. On Vercel it refuses uploads, since functions there have no persistent disk.

| Variable | Default | Notes |
|---|---|---|
| `MEDIA_DIR` | `.data/media` | Where files are written. |
| `MEDIA_PUBLIC_URL` | the API's URL | The base URL files are served from: `<MEDIA_PUBLIC_URL>/media/…`. Without it, `ADMIN_URL` without its `/admin`, else `http://localhost:<PORT>` plus the base path. Set it when the API is reached at another address, or through a CDN. |

- **Serving.** A key's file is the key under `MEDIA_DIR`, without the leading `media/`. The API serves it at `/media/<yyyy>/<mm>/<file>` with immutable caching, `nosniff` and byte ranges for video seeking.
- **Keys** always start with `media/`, the route they are served under. `MEDIA_PATH_PREFIX` does not apply.
- **Uploads.** The API itself takes the PUT, at `/admin/media/uploads/<key>?token=…`. The token is signed with `JWT_SECRET` and names the key, content type and size. The PUT must match all three, and the file's bytes must be of the declared type.
- **Older files** saved before the media library, by content hash (`/media/ab/<sha-256>.png`), are still served.

## Keys and URLs

A key is `<prefix>/<yyyy>/<mm>/<10 random characters>-<slugified filename>.<extension>`, for example `media/2026/10/k3j4h5g6f7-summer-shirt.jpg`.

- The extension follows the file's real type, not its name.
- Keys are never reused, so files are served with a one-year cache lifetime.
- Renaming an asset changes its display name, not its URL.

## Uploading

1. **Ask where to send the file** with `mediaUploadCreate(input: { filename, contentType, size })`. It checks the type and size, and returns a `MediaUpload`.
2. **Send the bytes** to storage, as `upload.provider` says.
3. **Register the file** with `mediaAssetCreate(input: { key: upload.key, filename, alts })`, which returns the `MediaAsset`.
4. **Use the URL.** Put `asset.url` in product media (`ProductMediaInput.url`) or in page content (image fields, SEO images, Markdown).

```ts
import { put } from "@vercel/blob/client";

const { upload } = await mediaUploadCreate({ filename: file.name, contentType: file.type, size: file.size });
if (upload.provider === "VERCEL_BLOB") {
  // Multipart sends 8 MB parts in parallel and retries failed ones.
  await put(upload.pathname, file, { access: "public", token: upload.clientToken, contentType: file.type, multipart: file.size > 8 * 1024 * 1024 });
} else {
  // LOCAL: url is a path on the API, so resolve it against the API's URL. S3: an absolute presigned URL.
  const response = await fetch(new URL(upload.url, apiUrl), { method: upload.method, headers: upload.headers, body: file });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}
const { asset } = await mediaAssetCreate({ key: upload.key, filename: file.name, alts: [{ locale: "en-US", value: altText }] });
```

### What `mediaAssetCreate` checks

`mediaAssetCreate` trusts storage, not the client:

- **The object exists.** It asks the store with `head()`.
- **The size** is within the limit, as the store reports it.
- **The type** comes from the file's first 64 KB and, for S3 and Vercel Blob, the stored `Content-Type`. It must be an accepted type, and match both the stored `Content-Type` and the key's extension.
- **A failed check** deletes the object and returns a `ValidationError` on `input.key`.
- **Image dimensions** come from the file's header: JPEG (with EXIF rotation applied), PNG, GIF, WebP and AVIF. The input's `width` and `height` are used only when the header cannot be read, as for videos.
- **Calling it again** with the same key returns the same asset.

### The multipart endpoint

`POST /admin/media` still takes a multipart `file` field, with a bearer access token or API key that has `catalog:write` or `content:write`. It stores the file with the configured provider, adds it to the library, and answers `{ id, url, contentType, size, sha256 }`, where `id` is the `MediaAsset`'s global id. The file passes through the API, which on Vercel limits it to 4.5 MB, so use direct uploads there.

## The library

- **`mediaAssets(first, after, query, kind)`** lists assets newest first. `query` matches the start of words in the filename and in the alt text of every locale, so "sum shi" finds `Summer-Shirt.jpg`. It uses a GIN index.
- **`mediaAsset(id)`** returns one asset. `node(id)` works too.
- **`mediaAssetUpdate(id, input: { filename, alts })`** renames an asset or replaces its alt text in every locale. An empty value removes that locale.
- **`MediaAsset.usage`** lists products whose media list has the asset's URL, and builder pages whose draft or published document contains it anywhere, rich text included.
- **`mediaAssetDelete(id, force)`** deletes the asset and its stored file. It returns `InvalidStateError` while `usage` is not empty. `force: true` deletes the asset anyway and leaves products and pages pointing at a missing file. The record is deleted first. If deleting the file then fails, the error is logged and the unreferenced file stays in storage.

Reading needs `catalog:read` or `content:read`. Uploading and editing need `catalog:write` or `content:write`.

## In the admin

Content › Media (`/admin/media`) is the library screen. The admin uploads directly, as described above, not through `POST /admin/media`.

- **Uploading.** Use Upload, drop files anywhere on the screen, or paste them. Each file is checked against `mediaStorage` (type and size) before anything is sent. Files go up three at a time, each with its progress and Cancel: an `XMLHttpRequest` PUT for local disk and S3, and `put()` from `@vercel/blob/client`, loaded only when needed, for Vercel Blob. The browser reads a video's dimensions and passes them to `mediaAssetCreate`.
- **Finding files.** The search, the All, Images and Videos filter, and the open file (`?asset=`) live in the URL. The grid loads 48 files at a time as you scroll.
- **A file's panel** shows a preview, the URL (copy, open), the name and alt text per language, the type, size, dimensions and storage, who uploaded it and when, and the products and pages that use it. Deleting a file in use says what will break and asks for Delete anyway (`force: true`). Bulk delete skips files in use unless you include them.
- **Elsewhere.** Product media, page builder image fields and the rich text image tool upload the same way and open the library in a picker. A library image brings its alt text to a field that has none. The text is copied, so editing it in the library later does not change products or pages.
- **Code.** [`admin/src/lib/media-upload.ts`](../admin/src/lib/media-upload.ts) is the upload pipeline. The picker is [`admin/src/components/media-picker.tsx`](../admin/src/components/media-picker.tsx), and the screen is in [`admin/src/routes/media/`](../admin/src/routes/media).

## Storefronts

`next/image` only optimizes images from hosts listed in `images.remotePatterns`, so add the media host:

| Provider | Pattern |
|---|---|
| Vercel Blob | `{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }` |
| S3, R2, Supabase, CDN | the host of `S3_PUBLIC_URL`, e.g. `{ protocol: "https", hostname: "media.example.com" }` |
| Local | the API's host with `pathname: "/media/**"` |

The sample storefront ([`storefront/lib/images.ts`](../storefront/lib/images.ts)) already allows Vercel Blob and `<SPINDLE_API_URL>/media/**`. For other hosts, set `SPINDLE_MEDIA_HOSTS` to the `S3_PUBLIC_URL` host.

## The admin's Content Security Policy

`mediaUploadOrigins()` in `src/modules/media/storage.ts` lists the origins browsers upload to, for `connect-src`:

- **Local:** none. Uploads go to the API itself, which `'self'` covers.
- **Vercel Blob:** `https://vercel.com`, plus the origin of `VERCEL_BLOB_API_URL` when it is set.
- **S3:** the bucket's endpoint. That is the `S3_ENDPOINT` origin with path style, the bucket's subdomain of it with virtual-hosted style, and `https://<bucket>.s3.<region>.amazonaws.com` on AWS.

## Limits

- **Size.** `MEDIA_MAX_BYTES` (default 20 MB) applies to every provider. It is checked when the upload is requested and again when the asset is created. The store enforces it during the upload: S3 signs `Content-Length`, the Vercel Blob token carries `maximumSizeInBytes`, and the local upload link carries the size. Sizes are 32-bit integers, so files are at most 2 GB.
- **Types.** JPEG, PNG, GIF, WebP, AVIF and MP4 are accepted, detected from the bytes. SVG is never accepted, because it can carry script.
- **Expiry.** Upload targets (presigned URLs, client tokens, local links) expire after 15 minutes.
- **Usage scope.** Usage covers product media and builder pages. Product descriptions (HTML) and component preview images are not searched.
- **Switching providers.** Existing assets keep their URLs and the `storage` they were saved in, and new uploads go to the new provider. Deleting an older asset deletes its file only while its provider is still configured. Otherwise the file is kept and a warning is logged.
