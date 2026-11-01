import { InvalidStateError } from "../../lib/errors.ts";
import { pickLocalized } from "../../lib/i18n.ts";
import { toGlobalId } from "../../lib/ids.ts";
import {
  createMediaAsset,
  createMediaUpload,
  deleteMediaAsset,
  getMediaAssetsByIds,
  listMediaAssets,
  mediaStorageInfo,
  mediaUsage,
  updateMediaAsset,
} from "../../modules/media/service.ts";
import type { UploadTarget } from "../../modules/media/storage.ts";
import { getStaffUser, hasPermission, type StaffUser } from "../../modules/staff/service.ts";
import { ADMIN, builder, connectionComplexity, rawId } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { keysetConnection } from "../pagination.ts";
import { MediaAssetRef, StaffUserRef } from "../refs.ts";
import { MediaKindEnum, productTranslation } from "./catalog.ts";
import { DeletePayload, fromLocalizedList, LocalizedStringInput, LocalizedStringRef, toLocalizedList } from "./common.ts";

// ---------------------------------------------------------------- permissions

/** The library serves both the catalog and the page builder: either area's permission is enough. */
const mediaScopes = (level: "read" | "write") => (_parent: unknown, _args: unknown, ctx: GraphQLContext) =>
  hasPermission(ctx.permissions, `content:${level}`) ? true : { permission: `catalog:${level}` };
const canRead = (ctx: GraphQLContext) => hasPermission(ctx.permissions, "catalog:read") || hasPermission(ctx.permissions, "content:read");

/** Per request, so a page of assets uploaded by one person looks them up once. */
const uploaders = new WeakMap<GraphQLContext, Map<string, Promise<StaffUser | null>>>();
const uploader = (ctx: GraphQLContext, id: string) => {
  let cache = uploaders.get(ctx);
  if (!cache) uploaders.set(ctx, (cache = new Map()));
  let user = cache.get(id);
  if (!user) cache.set(id, (user = getStaffUser(ctx.db, id).then((u) => u ?? null)));
  return user;
};

// ---------------------------------------------------------------- types

const MediaStorageProviderEnum = builder.enumType("MediaStorageProvider", {
  subGraphs: ADMIN,
  description: "Where media files are stored.",
  values: {
    LOCAL: { value: "local", description: "Files on the API server's disk, served at /media/. For development, Docker and single servers." },
    VERCEL_BLOB: { value: "vercel-blob", description: "A Vercel Blob store." },
    S3: { value: "s3", description: "S3-compatible object storage: AWS S3, Cloudflare R2, Supabase Storage, MinIO." },
  } as const,
});

const MediaUsageKindEnum = builder.enumType("MediaUsageKind", {
  subGraphs: ADMIN,
  values: { PRODUCT: { value: "product", description: "In the product's media." }, PAGE: { value: "page", description: "In a builder page's draft or published content." } } as const,
});

type MediaUsageShape = { kind: "product" | "page"; id: string; title: string | null };
const MediaUsageRef = builder.objectRef<MediaUsageShape>("MediaUsage").implement({
  subGraphs: ADMIN,
  description: "Somewhere an asset's URL is used.",
  fields: (t) => ({
    kind: t.field({ type: MediaUsageKindEnum, resolve: (u) => u.kind }),
    id: t.id({ description: "Global id of the product or page.", resolve: (u) => u.id }),
    title: t.exposeString("title", { nullable: true, description: "The product's name or the page's title, in the request locale." }),
  }),
});

builder.node(MediaAssetRef, {
  subGraphs: ADMIN,
  description: "An image or video in the media library. Use its url in product media and page content; usage shows where it is used.",
  id: { resolve: (a) => a.id },
  loadMany: async (ids, ctx) => {
    if (!canRead(ctx)) return ids.map(() => null);
    const rows = await getMediaAssetsByIds(ctx.db, ids);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    url: t.exposeString("url", { description: "Where the file is served from. Stable: keys are never reused, so it can be cached for a year." }),
    filename: t.exposeString("filename", { description: "The name it was uploaded with, or renamed to." }),
    contentType: t.exposeString("contentType", { description: "Detected from the file's bytes." }),
    kind: t.field({ type: MediaKindEnum, resolve: (a) => a.kind }),
    size: t.exposeInt("size", { description: "In bytes." }),
    width: t.exposeInt("width", { nullable: true, description: "In pixels, as displayed (EXIF rotation applied). Read from the file for images." }),
    height: t.exposeInt("height", { nullable: true }),
    alt: t.string({ nullable: true, description: "Alt text in the request locale.", resolve: (a, _args, ctx) => pickLocalized(a.alt, ctx.scope.locale, ctx.scope.channel.defaultLocale) }),
    alts: t.field({ type: [LocalizedStringRef], description: "Alt text in every locale.", resolve: (a) => toLocalizedList(a.alt) }),
    storage: t.field({ type: MediaStorageProviderEnum, description: "The store the file was uploaded to.", resolve: (a) => a.storage }),
    createdAt: t.field({ type: "DateTime", resolve: (a) => a.createdAt }),
    createdBy: t.field({ type: StaffUserRef, nullable: true, resolve: (a, _args, ctx) => (a.createdBy ? uploader(ctx, a.createdBy) : null) }),
    usage: t.field({
      type: [MediaUsageRef],
      description: "Products whose media list has this URL, and pages whose draft or published content mentions it. Deleting is refused while this is not empty.",
      resolve: async (a, _args, ctx) => {
        const usage = await mediaUsage(ctx.db, a.url);
        const products = await Promise.all(
          usage.products.map(async (id) => ({ kind: "product" as const, id: toGlobalId("Product", id), title: (await productTranslation(ctx, id))?.name ?? null })),
        );
        const pages = usage.pages.map((p) => ({ kind: "page" as const, id: toGlobalId("Page", p.id), title: pickLocalized(p.title, ctx.scope.locale, ctx.scope.channel.defaultLocale) }));
        return [...products, ...pages];
      },
    }),
  }),
});

type MediaUploadShape = UploadTarget & { maxBytes: number };
const MediaUploadRef = builder.objectRef<MediaUploadShape>("MediaUpload").implement({
  subGraphs: ADMIN,
  description:
    "Where to upload a file, straight to storage. LOCAL and S3: send `method` to `url` with `headers` and the file as the body. " +
    "VERCEL_BLOB: `put(pathname, file, { access: \"public\", token: clientToken, contentType, multipart })` from @vercel/blob/client. " +
    "Then call mediaAssetCreate with `key`.",
  fields: (t) => ({
    provider: t.field({ type: MediaStorageProviderEnum, resolve: (u) => u.provider }),
    key: t.exposeString("key", { description: "Pass to mediaAssetCreate once the upload has finished." }),
    publicUrl: t.exposeString("publicUrl", { description: "Where the file will be served from." }),
    method: t.exposeString("method", { description: "PUT." }),
    url: t.exposeString("url", {
      nullable: true,
      description: "LOCAL: a path on this API, with a signed token (resolve it against the API's URL). S3: a presigned URL. Null for VERCEL_BLOB.",
    }),
    headers: t.field({
      type: "JSON",
      description: "Headers to send with the PUT, e.g. { \"Content-Type\": \"image/png\" }; they are part of the signature. The body must be exactly the declared size.",
      resolve: (u) => u.headers,
    }),
    clientToken: t.exposeString("clientToken", { nullable: true, description: "VERCEL_BLOB: the token for put() from @vercel/blob/client, limited to this pathname, type and size." }),
    pathname: t.exposeString("pathname", { nullable: true, description: "VERCEL_BLOB: the pathname to put to." }),
    maxBytes: t.exposeInt("maxBytes", { description: "The largest file accepted." }),
    expiresAt: t.field({ type: "DateTime", description: "When the url or clientToken stops working.", resolve: (u) => u.expiresAt }),
  }),
});

type MediaStorageInfoShape = ReturnType<typeof mediaStorageInfo>;
const MediaStorageInfoRef = builder.objectRef<MediaStorageInfoShape>("MediaStorageInfo").implement({
  subGraphs: ADMIN,
  description: "How uploads work on this server.",
  fields: (t) => ({
    provider: t.field({ type: MediaStorageProviderEnum, resolve: (s) => s.provider }),
    maxBytes: t.exposeInt("maxBytes", { description: "The largest file accepted, in bytes." }),
    allowedContentTypes: t.exposeStringList("allowedContentTypes", { description: "JPEG, PNG, GIF, WebP, AVIF and MP4. Never SVG, which can carry script." }),
  }),
});

// ---------------------------------------------------------------- queries

builder.queryFields((t) => ({
  mediaAssets: t.connection(
    {
      type: MediaAssetRef,
      subGraphs: ADMIN,
      description: "The media library, newest first.",
      args: {
        query: t.arg.string({ description: "Words in the filename or alt text; each word matches as a prefix (\"sum shi\" finds summer-shirt.jpg)." }),
        kind: t.arg({ type: MediaKindEnum }),
      },
      authScopes: mediaScopes("read"),
      complexity: connectionComplexity,
      resolve: (_root, args, ctx) => keysetConnection(args, (page) => listMediaAssets(ctx.db, { query: args.query, kind: args.kind }, page)),
    },
    { name: "MediaAssetConnection" },
    { name: "MediaAssetEdge" },
  ),
  mediaAsset: t.field({
    type: MediaAssetRef,
    nullable: true,
    subGraphs: ADMIN,
    args: { id: t.arg.globalID({ for: [MediaAssetRef], required: true }) },
    authScopes: mediaScopes("read"),
    resolve: async (_root, { id }, ctx) => (await getMediaAssetsByIds(ctx.db, [rawId(id)]))[0] ?? null,
  }),
  mediaStorage: t.field({
    type: MediaStorageInfoRef,
    subGraphs: ADMIN,
    description: "The configured storage and upload limits.",
    authScopes: mediaScopes("read"),
    resolve: (_root, _args, ctx) => mediaStorageInfo(ctx.platform),
  }),
}));

// ---------------------------------------------------------------- mutations

const write = { subGraphs: ADMIN, authScopes: mediaScopes("write"), errors: {} } as const;
/** Storage that is misconfigured, or local storage on Vercel, fails with InvalidStateError. */
const writeOrInvalid = { ...write, errors: { types: [InvalidStateError] } };
const actorOf = (ctx: GraphQLContext) => ({ staffId: ctx.staff?.id ?? null });

const MediaUploadPayload = builder.simpleObject("MediaUploadPayload", { subGraphs: ADMIN, fields: (t) => ({ upload: t.field({ type: MediaUploadRef }) }) });
const MediaAssetPayload = builder.simpleObject("MediaAssetPayload", { subGraphs: ADMIN, fields: (t) => ({ asset: t.field({ type: MediaAssetRef }) }) });

const MediaUploadCreateInput = builder.inputType("MediaUploadCreateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    filename: t.string({ required: true, description: "The file's name; it becomes part of the URL, slugified." }),
    contentType: t.string({ required: true, description: "One of MediaStorageInfo.allowedContentTypes, e.g. File.type in a browser." }),
    size: t.int({ required: true, description: "In bytes; the upload must be exactly this size." }),
  }),
});
const MediaAssetCreateInput = builder.inputType("MediaAssetCreateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    key: t.string({ required: true, description: "MediaUpload.key, after the file has been uploaded." }),
    filename: t.string({ required: true }),
    width: t.int({ description: "Used only when the file's own dimensions cannot be read (e.g. videos)." }),
    height: t.int({ description: "Used only when the file's own dimensions cannot be read (e.g. videos)." }),
    alts: t.field({ type: [LocalizedStringInput], description: "Alt text per locale." }),
  }),
});
const MediaAssetUpdateInput = builder.inputType("MediaAssetUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    filename: t.string({ description: "Renames it in the library; the URL stays the same." }),
    alts: t.field({ type: [LocalizedStringInput], description: "Replaces the alt text in every locale; an empty value removes a locale." }),
  }),
});

builder.mutationFields((t) => ({
  mediaUploadCreate: t.field({
    ...writeOrInvalid,
    type: MediaUploadPayload,
    description: "Check a file's type and size and get a short-lived target to upload it to, straight to storage (not through this API). Then call mediaAssetCreate.",
    args: { input: t.arg({ type: MediaUploadCreateInput, required: true }) },
    resolve: async (_root, { input }, ctx) => ({ upload: await createMediaUpload(ctx.platform, input) }),
  }),
  mediaAssetCreate: t.field({
    ...writeOrInvalid,
    type: MediaAssetPayload,
    description:
      "Add an uploaded file to the library, reading its size and type from storage. A file that is too large, not an accepted type or not as declared is deleted and refused. " +
      "Repeating a key returns the same asset.",
    args: { input: t.arg({ type: MediaAssetCreateInput, required: true }) },
    resolve: async (_root, { input }, ctx) => ({
      asset: await createMediaAsset(
        ctx.platform,
        { key: input.key, filename: input.filename, width: input.width, height: input.height, alt: input.alts ? fromLocalizedList(input.alts) : undefined },
        actorOf(ctx),
      ),
    }),
  }),
  mediaAssetUpdate: t.field({
    ...write,
    type: MediaAssetPayload,
    args: { id: t.arg.globalID({ for: [MediaAssetRef], required: true }), input: t.arg({ type: MediaAssetUpdateInput, required: true }) },
    resolve: async (_root, { id, input }, ctx) => ({
      asset: await updateMediaAsset(ctx.db, rawId(id), { filename: input.filename ?? undefined, alt: input.alts ? fromLocalizedList(input.alts) : undefined }),
    }),
  }),
  mediaAssetDelete: t.field({
    ...writeOrInvalid,
    type: DeletePayload,
    description: "Delete the asset and its stored file. Refused while products or pages use it (see usage), unless force: true, which leaves them pointing at a missing file.",
    args: { id: t.arg.globalID({ for: [MediaAssetRef], required: true }), force: t.arg.boolean() },
    resolve: async (_root, { id, force }, ctx) => ({ deletedId: toGlobalId("MediaAsset", await deleteMediaAsset(ctx.platform, rawId(id), { force: force ?? false })) }),
  }),
}));
