import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGlobalId } from "../../src/lib/ids.ts";
import { signLocalUpload } from "../../src/modules/media/local.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { bytes, jpeg, mp4, png } from "../helpers/media.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

type Upload = { provider: string; key: string; publicUrl: string; method: string; url: string; headers: Record<string, string>; clientToken: string | null; pathname: string | null; maxBytes: number };

const ERR = `... on Error { __typename code message } ... on ValidationError { fieldErrors { path message } }`;
const ASSET = `fragment A on MediaAsset { id url filename contentType kind size width height alt alts { locale value } storage createdAt createdBy { email } usage { kind id title } }`;
const UPLOAD = `mutation($i: MediaUploadCreateInput!) { mediaUploadCreate(input: $i) { __typename ... on MediaUploadPayload { upload { provider key publicUrl method url headers clientToken pathname maxBytes expiresAt } } ${ERR} } }`;
const CREATE = `mutation($i: MediaAssetCreateInput!) { mediaAssetCreate(input: $i) { __typename ... on MediaAssetPayload { asset { ...A } } ${ERR} } } ${ASSET}`;
const UPDATE = `mutation($id: ID!, $i: MediaAssetUpdateInput!) { mediaAssetUpdate(id: $id, input: $i) { __typename ... on MediaAssetPayload { asset { ...A } } ${ERR} } } ${ASSET}`;
const DELETE = `mutation($id: ID!, $f: Boolean) { mediaAssetDelete(id: $id, force: $f) { __typename ... on DeletePayload { deletedId } ${ERR} } }`;
const LIST = `query($q: String, $k: MediaKind, $after: String) { mediaAssets(first: 10, query: $q, kind: $k, after: $after) { totalCount edges { cursor node { id filename } } pageInfo { hasNextPage endCursor } } }`;

/** In-process HTTP. Relative URLs, such as local upload links, resolve against the app. */
const http = (url: string, init?: RequestInit) => t.app.fetch(new Request(new URL(url, "http://ecom.test"), init));
const requestUpload = async (input: { filename: string; contentType: string; size: number }, headers = auth) => (await t.admin(UPLOAD, { i: input }, headers)).data.mediaUploadCreate;
const put = (target: Upload, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = target.headers) => http(target.url, { method: target.method, headers, body });
const createAsset = async (input: Record<string, unknown>) => (await t.admin(CREATE, { i: input }, auth)).data.mediaAssetCreate;
const list = async (q?: string, k?: string, after?: string) => (await t.admin(LIST, { q, k, after }, auth)).data.mediaAssets;
const ids = (connection: { edges: { node: { id: string } }[] }) => connection.edges.map((e) => e.node.id);

/** What the admin does: get a target, PUT the bytes straight to it, then register the asset. */
const upload = async (file: Uint8Array<ArrayBuffer>, filename: string, contentType: string, extra: Record<string, unknown> = {}) => {
  const target: Upload = (await requestUpload({ filename, contentType, size: file.byteLength })).upload;
  expect((await put(target, file)).status).toBe(201);
  return createAsset({ key: target.key, filename, ...extra });
};

describe("media library", () => {
  it("uploads straight to storage, then lists, renames, finds usage and deletes", async () => {
    const storage = await t.admin(`{ mediaStorage { provider maxBytes allowedContentTypes } }`, {}, auth);
    expect(storage.data.mediaStorage).toEqual({ provider: "LOCAL", maxBytes: 20 * 1024 * 1024, allowedContentTypes: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "video/mp4"] });

    const file = png(3, 2);
    const requested = await requestUpload({ filename: "Summer Shirt.PNG", contentType: "image/png", size: file.byteLength });
    expect(requested.__typename).toBe("MediaUploadPayload");
    const target: Upload = requested.upload;
    expect(target).toMatchObject({ provider: "LOCAL", method: "PUT", headers: { "Content-Type": "image/png" }, clientToken: null, pathname: null, maxBytes: 20 * 1024 * 1024 });
    expect(target.key).toMatch(/^media\/\d{4}\/\d{2}\/[a-z0-9]{10}-summer-shirt\.png$/);
    expect(target.url.startsWith(`/admin/media/uploads/${target.key}?token=`)).toBe(true);
    expect(target.publicUrl).toBe(`http://localhost:4000/${target.key}`);

    // Nothing to register until the bytes have arrived.
    expect(await createAsset({ key: target.key, filename: "Summer Shirt.PNG" })).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "key"] }] });
    expect((await put(target, file)).status).toBe(201);

    // Dimensions come from the file, not the client.
    const created = await createAsset({ key: target.key, filename: "Summer Shirt.PNG", width: 999, height: 999, alts: [{ locale: "en-US", value: "A blue shirt" }] });
    expect(created.__typename).toBe("MediaAssetPayload");
    const asset = created.asset;
    expect(asset).toMatchObject({
      id: expect.stringMatching(/^gid:\/\/ecom\/MediaAsset\//),
      url: target.publicUrl,
      filename: "Summer Shirt.PNG",
      contentType: "image/png",
      kind: "IMAGE",
      size: file.byteLength,
      width: 3,
      height: 2,
      alt: "A blue shirt",
      storage: "LOCAL",
      createdBy: { email: TEST_CREDENTIALS.adminEmail },
      usage: [],
    });
    // Registering the same key again returns the same asset.
    expect((await createAsset({ key: target.key, filename: "Another name" })).asset).toMatchObject({ id: asset.id, filename: "Summer Shirt.PNG" });

    // Served by the API with immutable caching, and in ranges for video players.
    const served = await http(asset.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(file);
    const partial = await http(asset.url, { headers: { range: "bytes=0-7" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-7/${file.byteLength}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(file.subarray(0, 8));

    // Videos take the client's dimensions, which their headers do not give.
    const video = (await upload(mp4(), "Runway clip.mp4", "video/mp4", { width: 1920, height: 1080 })).asset;
    expect(video).toMatchObject({ kind: "VIDEO", contentType: "video/mp4", width: 1920, height: 1080 });

    // Newest first, with keyset paging, word-prefix search over filename and alt text, and a kind filter.
    const all = await list();
    expect(ids(all)).toEqual([video.id, asset.id]);
    expect(ids(await list(undefined, undefined, all.edges[0].cursor))).toEqual([asset.id]);
    expect(ids(await list("summ"))).toEqual([asset.id]);
    expect(ids(await list("shirt PNG"))).toEqual([asset.id]);
    expect(ids(await list("blue"))).toEqual([asset.id]);
    expect(ids(await list("runway cl"))).toEqual([video.id]);
    expect(ids(await list(undefined, "VIDEO"))).toEqual([video.id]);
    expect(ids(await list("shirt", "VIDEO"))).toEqual([]);
    expect((await list("nothing")).totalCount).toBe(0);

    // Renaming keeps the URL; alt text is replaced in every locale.
    const updated = await t.admin(UPDATE, { id: asset.id, i: { filename: "Shirt front.png", alts: [{ locale: "en-US", value: "Front view" }, { locale: "de-DE", value: "Vorderansicht" }] } }, auth);
    expect(updated.data.mediaAssetUpdate.asset).toMatchObject({ filename: "Shirt front.png", url: asset.url, alt: "Front view" });
    expect(updated.data.mediaAssetUpdate.asset.alts).toEqual(expect.arrayContaining([{ locale: "en-US", value: "Front view" }, { locale: "de-DE", value: "Vorderansicht" }]));
    expect(ids(await list("vorder"))).toEqual([asset.id]);
    expect(ids(await list("summer"))).toEqual([]);

    // Usage: a product's media and a page's content.
    const oxford = toGlobalId("Product", t.seed.products.oxford.id);
    const product = await t.admin(`mutation($id: ID!, $i: ProductUpdateInput!) { productUpdate(id: $id, input: $i) { __typename } }`, { id: oxford, i: { media: [{ url: asset.url, alt: [{ locale: "en-US", value: "Front view" }] }] } }, auth);
    expect(product.data.productUpdate.__typename).toBe("ProductPayload");
    const pageCreated = await t.admin(
      `mutation($i: PageCreateInput!) { pageCreate(input: $i) { ... on PagePayload { page { id version document } } } }`,
      { i: { type: "landing_page", titles: [{ locale: "en-US", value: "Lookbook" }], path: "/lookbook" } },
      auth,
    );
    const pageDraft = pageCreated.data.pageCreate.page;
    const saved = await t.admin(
      `mutation($id: ID!, $v: Int!, $d: JSON!) { pageSaveDraft(id: $id, baseVersion: $v, document: $d) { __typename ${ERR} } }`,
      { id: pageDraft.id, v: pageDraft.version, d: { ...pageDraft.document, seo: { image: { url: asset.url } } } },
      auth,
    );
    expect(saved.data.pageSaveDraft.__typename).toBe("PagePayload");
    const usage = await t.admin(`query($id: ID!) { mediaAsset(id: $id) { usage { kind id title } } }`, { id: asset.id }, auth);
    expect(usage.data.mediaAsset.usage).toEqual([
      { kind: "PRODUCT", id: oxford, title: "Oxford Shirt" },
      { kind: "PAGE", id: pageDraft.id, title: "Lookbook" },
    ]);

    // Deleting is refused while it is used, unless forced; forcing deletes the file too.
    const refused = await t.admin(DELETE, { id: asset.id }, auth);
    expect(refused.data.mediaAssetDelete).toMatchObject({ __typename: "InvalidStateError", message: expect.stringMatching(/used on 1 product and 1 page/) });
    expect((await http(asset.url)).status).toBe(200);
    const forced = await t.admin(DELETE, { id: asset.id, f: true }, auth);
    expect(forced.data.mediaAssetDelete).toEqual({ __typename: "DeletePayload", deletedId: asset.id });
    expect((await http(asset.url)).status).toBe(404);
    expect((await t.admin(`query($id: ID!) { mediaAsset(id: $id) { id } }`, { id: asset.id }, auth)).data.mediaAsset).toBeNull();
    // An unused asset needs no force.
    expect((await t.admin(DELETE, { id: video.id }, auth)).data.mediaAssetDelete.__typename).toBe("DeletePayload");
    expect((await t.admin(DELETE, { id: video.id }, auth)).data.mediaAssetDelete.__typename).toBe("NotFoundError");
  });

  it("refuses files of the wrong type or size, whatever the client claims", async () => {
    const svg = await requestUpload({ filename: "logo.svg", contentType: "image/svg+xml", size: 100 });
    expect(svg).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "contentType"], message: expect.stringMatching(/JPEG, PNG, GIF, WebP, AVIF or MP4/) }] });
    const huge = await requestUpload({ filename: "big.png", contentType: "image/png", size: 21 * 1024 * 1024 });
    expect(huge).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "size"], message: "Files are limited to 20 MB" }] });

    // Bytes that are not what was declared are refused on arrival.
    const markup = bytes(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
    const disguised: Upload = (await requestUpload({ filename: "logo.png", contentType: "image/png", size: markup.byteLength })).upload;
    expect((await put(disguised, markup)).status).toBe(415);
    const photo = jpeg(10, 10);
    const mislabeled: Upload = (await requestUpload({ filename: "photo.png", contentType: "image/png", size: photo.byteLength })).upload;
    expect((await put(mislabeled, photo)).status).toBe(415);
    expect((await createAsset({ key: disguised.key, filename: "logo.png" })).__typename).toBe("ValidationError");

    // A file that reached storage some other way is still checked: refused and deleted.
    const sneaky: Upload = (await requestUpload({ filename: "sneaky.png", contentType: "image/png", size: markup.byteLength })).upload;
    const file = join(t.platform.config.media.dir, sneaky.key.slice("media/".length));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, markup);
    expect(await createAsset({ key: sneaky.key, filename: "sneaky.png" })).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "key"], message: expect.stringMatching(/the upload was deleted/) }] });
    expect(existsSync(file)).toBe(false);

    // Only keys of the shape mediaUploadCreate issues are accepted.
    for (const key of ["media/../../etc/passwd", "elsewhere/2026/01/abcdefghij-x.png", "media/2026/01/abcdefghij-x.svg"]) {
      expect((await createAsset({ key, filename: "x" })).fieldErrors, key).toEqual([{ path: ["input", "key"], message: "Pass the key mediaUploadCreate returned" }]);
    }
  });

  it("refuses missing, forged, expired and mismatched upload links", async () => {
    const file = png(2, 2);
    const target: Upload = (await requestUpload({ filename: "link.png", contentType: "image/png", size: file.byteLength })).upload;
    const path = target.url.split("?")[0]!;
    const putWith = (token: string | null) => http(token === null ? path : `${path}?token=${encodeURIComponent(token)}`, { method: "PUT", headers: target.headers, body: file });

    expect((await putWith(null)).status).toBe(401);
    expect((await putWith("forged")).status).toBe(401);
    const claims = { key: target.key, contentType: "image/png", size: file.byteLength };
    expect((await putWith((await signLocalUpload(t.platform.config.jwtSecret, { ...claims, ttlSeconds: -60 })).token)).status).toBe(401);
    expect((await putWith((await signLocalUpload(new TextEncoder().encode("some-other-secret-some-other-secret"), claims)).token)).status).toBe(401);
    // A link names one key, type and size.
    const other: Upload = (await requestUpload({ filename: "other.png", contentType: "image/png", size: file.byteLength })).upload;
    const mismatched = await putWith(new URL(other.url, "http://ecom.test").searchParams.get("token"));
    expect(mismatched.status).toBe(401);
    expect(await mismatched.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "This upload link is for another file" } });
    expect((await put(target, file, { "Content-Type": "image/jpeg" })).status).toBe(415);
    expect((await put(target, bytes(file, [0, 0, 0]))).status).toBe(400);
    expect((await put(target, file.subarray(0, file.byteLength - 1))).status).toBe(400);
    expect((await put(target, file)).status).toBe(201);
  });

  it("lets catalog or content staff upload, and refuses everyone else", async () => {
    const key = async (permissions: string[]) => {
      const created = await t.admin(`mutation($p: [String!]!) { apiKeyCreate(name: "Media test", permissions: $p) { ... on ApiKeyCreatePayload { secret } } }`, { p: permissions }, auth);
      return bearer(created.data.apiKeyCreate.secret);
    };
    const file = png(1, 1);
    const content = await key(["content:write"]);
    expect((await requestUpload({ filename: "c.png", contentType: "image/png", size: file.byteLength }, content)).__typename).toBe("MediaUploadPayload");
    expect((await t.admin(`{ mediaAssets(first: 1) { totalCount } }`, {}, await key(["content:read"]))).data.mediaAssets).not.toBeNull();
    const reader = await key(["catalog:read"]);
    expect(await requestUpload({ filename: "r.png", contentType: "image/png", size: file.byteLength }, reader)).toMatchObject({ __typename: "PermissionDeniedError" });
    const outsider = await key(["orders:read"]);
    const denied = await t.admin(`{ mediaAssets(first: 1) { totalCount } }`, {}, outsider);
    expect(denied.data?.mediaAssets ?? null).toBeNull();
    expect(denied.errors?.[0]?.extensions?.code).toBe("PERMISSION_DENIED");
  });

  it("keeps the multipart endpoint working, now through the configured storage", async () => {
    const post = (body: Uint8Array<ArrayBuffer>, name: string, headers: Record<string, string>) => {
      const form = new FormData();
      form.set("file", new Blob([body]), name);
      return http("/admin/media", { method: "POST", headers, body: form });
    };
    const file = png(4, 3);
    expect((await post(file, "dot.png", {})).status).toBe(401);
    const response = await post(file, "Dot.png", auth);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; url: string; contentType: string; size: number; sha256: string };
    expect(body).toMatchObject({ id: expect.stringMatching(/^gid:\/\/ecom\/MediaAsset\//), contentType: "image/png", size: file.byteLength, sha256: createHash("sha256").update(file).digest("hex") });
    expect(body.url).toMatch(/^http:\/\/localhost:4000\/media\/\d{4}\/\d{2}\/[a-z0-9]{10}-dot\.png$/);
    expect(new Uint8Array(await (await http(body.url)).arrayBuffer())).toEqual(file);
    const asset = await t.admin(`query($id: ID!) { mediaAsset(id: $id) { url filename width height storage kind } }`, { id: body.id }, auth);
    expect(asset.data.mediaAsset).toEqual({ url: body.url, filename: "Dot.png", width: 4, height: 3, storage: "LOCAL", kind: "IMAGE" });
    expect((await post(bytes(`<svg xmlns="http://www.w3.org/2000/svg"/>`), "x.svg", auth)).status).toBe(415);

    // Files stored by content hash before the media library are still served.
    const sha = createHash("sha256").update(file).digest("hex");
    const legacy = join(t.platform.config.media.dir, sha.slice(0, 2), `${sha}.png`);
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, file);
    const old = await http(`/media/${sha.slice(0, 2)}/${sha}.png`);
    expect(old.status).toBe(200);
    expect(old.headers.get("content-type")).toBe("image/png");
    expect((await http("/media/..%2f..%2fpackage.json")).status).toBe(404);
  });
});
