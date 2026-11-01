import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import type { LocalizedText } from "../../lib/i18n.ts";
import { parseInput } from "../../lib/validation.ts";
import type { Platform } from "../../platform.ts";
import { builderPages } from "../builder/tables.ts";
import { productMedia } from "../catalog/tables.ts";
import { prefixQuery } from "../search/service.ts";
import { ALLOWED_CONTENT_TYPES, ALLOWED_LABELS, imageDimensions, mediaType, mediaTypeByExtension, sniffMediaType, SNIFF_BYTES, type MediaType } from "./formats.ts";
import { isMediaKey, keyExtension, mediaKey } from "./keys.ts";
import { mediaStorage, storageForProvider, type MediaProvider, type UploadTarget } from "./storage.ts";
import { mediaAssets, mediaSearchDocument, type MediaKind } from "./tables.ts";

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type Actor = { staffId: string | null };

/** Sizes are GraphQL Ints and integer columns: 32-bit. */
const MAX_INT = 2_147_483_647;

export const mediaMaxBytes = (platform: Platform): number => Math.min(platform.config.media.maxBytes, MAX_INT);

/** "20 MB", "512 KB". */
export const formatBytes = (bytes: number): string => {
  const [unit, size] = bytes >= 1024 * 1024 ? ["MB", bytes / (1024 * 1024)] : bytes >= 1024 ? ["KB", bytes / 1024] : ["bytes", bytes];
  return `${Number.isInteger(size) ? size : size.toFixed(1)} ${unit}`;
};

export const mediaStorageInfo = (platform: Platform) => ({ provider: mediaStorage(platform).provider, maxBytes: mediaMaxBytes(platform), allowedContentTypes: ALLOWED_CONTENT_TYPES });

const LOCALE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** An empty value removes that locale. */
const altText = z
  .record(z.string().regex(LOCALE, "Expected a locale such as en-US"), z.string().max(1000, "At most 1000 characters"))
  .transform((alt) => Object.fromEntries(Object.entries(alt).filter(([, text]) => text.trim() !== "").map(([locale, text]) => [locale, text.trim()])) as LocalizedText);
const filename = z.string().trim().min(1, "Required").max(255, "At most 255 characters");
const dimension = z.number().int().positive().max(1_000_000);

// ---------------------------------------------------------------- uploads

const uploadSchema = z.object({ filename, contentType: z.string().trim().toLowerCase(), size: z.number().int().positive("Must be more than 0 bytes") });

/** Checks the client's declared type and size; createMediaAsset checks the bytes again. */
export const createMediaUpload = async (platform: Platform, input: unknown): Promise<UploadTarget & { maxBytes: number }> => {
  const data = parseInput(uploadSchema, input);
  const maxBytes = mediaMaxBytes(platform);
  const type = mediaType(data.contentType);
  const problems = [
    ...(type ? [] : [{ path: ["input", "contentType"], message: `Upload a ${ALLOWED_LABELS} file (${ALLOWED_CONTENT_TYPES.join(", ")})` }]),
    ...(data.size > maxBytes ? [{ path: ["input", "size"], message: `Files are limited to ${formatBytes(maxBytes)}` }] : []),
  ];
  if (!type || problems.length) throw new ValidationError("The file cannot be uploaded", problems);
  const storage = mediaStorage(platform);
  const key = mediaKey({ prefix: storage.prefix, filename: data.filename, contentType: type.contentType });
  return { ...(await storage.createUpload({ key, contentType: type.contentType, size: data.size })), maxBytes };
};

// ---------------------------------------------------------------- assets

export const getMediaAssetsByIds = async (db: Database, ids: readonly string[]) => (ids.length ? db.select().from(mediaAssets).where(inArray(mediaAssets.id, [...ids])) : []);

export const getMediaAsset = async (db: Database, id: string): Promise<MediaAsset> => {
  const [asset] = await getMediaAssetsByIds(db, [id]);
  if (!asset) throw new NotFoundError("MediaAsset", id);
  return asset;
};

const findByKey = async (db: Database, storage: MediaProvider, key: string) =>
  (await db.select().from(mediaAssets).where(and(eq(mediaAssets.storage, storage), eq(mediaAssets.key, key))))[0] ?? null;

const assetCreateSchema = z.object({
  key: z.string().trim().min(1, "Required").max(1024),
  filename,
  width: dimension.nullish(),
  height: dimension.nullish(),
  alt: altText.default({}),
});

/**
 * Register an uploaded file. Size and type come from the stored object, never the client; a file of
 * the wrong type or size is deleted. The client's width and height are a fallback for unreadable
 * headers. Idempotent per key.
 */
export const createMediaAsset = async (platform: Platform, input: unknown, actor: Actor): Promise<MediaAsset> => {
  const data = parseInput(assetCreateSchema, input);
  const storage = mediaStorage(platform);
  if (!isMediaKey(data.key, storage.prefix)) throw new ValidationError("Unknown key", [{ path: ["input", "key"], message: "Pass the key mediaUploadCreate returned" }]);
  const existing = await findByKey(platform.db, storage.provider, data.key);
  if (existing) return existing;

  const object = await storage.head(data.key);
  if (!object) throw new ValidationError("Nothing has been uploaded to this key", [{ path: ["input", "key"], message: "Upload the file to the target mediaUploadCreate returned first" }]);
  const refuse = async (message: string): Promise<never> => {
    await storage.delete(data.key).catch((err: unknown) => platform.logger.error({ err, key: data.key }, "could not delete a refused media upload"));
    throw new ValidationError(message, [{ path: ["input", "key"], message: `${message}; the upload was deleted` }]);
  };
  const maxBytes = mediaMaxBytes(platform);
  if (object.size > maxBytes) await refuse(`Files are limited to ${formatBytes(maxBytes)}`);
  if (object.size === 0) await refuse("The file is empty");

  const start = await storage.readStart(data.key, SNIFF_BYTES).catch((err: unknown) => {
    platform.logger.warn({ err, key: data.key }, "could not read the start of a media upload; trusting its stored content type");
    return null;
  });
  const stored = object.contentType ? mediaType(object.contentType.split(";")[0]!) : null;
  if (object.contentType && !stored) await refuse(`Upload a ${ALLOWED_LABELS} file, not ${object.contentType}`);
  const type: MediaType | null = start?.length ? sniffMediaType(start) : stored;
  if (!type) return refuse(`Upload a ${ALLOWED_LABELS} file`);
  if ((stored && stored !== type) || mediaTypeByExtension(keyExtension(data.key)) !== type) await refuse(`The file is a ${type.label}, which does not match the type it was uploaded as`);

  const measured = type.kind === "image" && start ? imageDimensions(start) : null;
  const [row] = await platform.db
    .insert(mediaAssets)
    .values({
      storage: storage.provider,
      key: data.key,
      url: object.url ?? storage.publicUrl(data.key),
      filename: data.filename,
      contentType: type.contentType,
      kind: type.kind,
      size: object.size,
      width: measured?.width ?? data.width ?? null,
      height: measured?.height ?? data.height ?? null,
      alt: data.alt,
      createdBy: actor.staffId,
    })
    .onConflictDoNothing({ target: [mediaAssets.storage, mediaAssets.key] })
    .returning();
  // A concurrent create of the same key won the race.
  return row ?? (await findByKey(platform.db, storage.provider, data.key))!;
};

/** For the multipart endpoint. The caller checks the size; the type comes from the bytes. */
export const storeMedia = async (platform: Platform, input: { bytes: Uint8Array; filename: string; alt?: LocalizedText }, actor: Actor) => {
  const type = sniffMediaType(input.bytes);
  if (!type) throw new ValidationError(`Upload a ${ALLOWED_LABELS} file`, [{ path: ["file"], message: "The file's content is not an accepted type" }]);
  const storage = mediaStorage(platform);
  const name = input.filename.trim().slice(0, 255) || `upload.${type.extension}`;
  const key = mediaKey({ prefix: storage.prefix, filename: name, contentType: type.contentType });
  const { url } = await storage.put(key, input.bytes, type.contentType);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const measured = type.kind === "image" ? imageDimensions(input.bytes) : null;
  const [asset] = await platform.db
    .insert(mediaAssets)
    .values({
      storage: storage.provider,
      key,
      url,
      filename: name,
      contentType: type.contentType,
      kind: type.kind,
      size: input.bytes.byteLength,
      width: measured?.width ?? null,
      height: measured?.height ?? null,
      alt: input.alt ?? {},
      checksum: sha256,
      createdBy: actor.staffId,
    })
    .returning();
  return { asset: asset!, sha256 };
};

const assetUpdateSchema = z.object({ filename: filename.optional(), alt: altText.optional() });

/** Renaming keeps the URL. `alt` replaces the alt text in every locale. */
export const updateMediaAsset = async (db: Database, id: string, input: unknown): Promise<MediaAsset> => {
  const data = parseInput(assetUpdateSchema, input);
  const changes = { ...(data.filename !== undefined ? { filename: data.filename } : {}), ...(data.alt !== undefined ? { alt: data.alt } : {}) };
  const [row] = await db
    .update(mediaAssets)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(mediaAssets.id, id))
    .returning();
  if (!row) throw new NotFoundError("MediaAsset", id);
  return row;
};

export type MediaUsage = { products: string[]; pages: { id: string; title: LocalizedText }[] };

/**
 * Products and builder pages that use an asset's URL. Pages are searched as jsonb text, where a URL
 * appears verbatim, so one anywhere in the draft or published document counts.
 */
export const mediaUsage = async (db: Database, url: string): Promise<MediaUsage> => {
  const products = await db.selectDistinct({ id: productMedia.productId }).from(productMedia).where(eq(productMedia.url, url)).orderBy(asc(productMedia.productId));
  const pages = await db
    .select({ id: builderPages.id, title: builderPages.title })
    .from(builderPages)
    .where(sql`strpos(${builderPages.draft}::text, ${url}) > 0 or strpos(coalesce(${builderPages.published}::text, ''), ${url}) > 0`)
    .orderBy(sql`${builderPages.path} asc nulls last`, asc(builderPages.id));
  return { products: products.map((p) => p.id), pages };
};

const usageSummary = (usage: MediaUsage) =>
  [usage.products.length ? `${usage.products.length} product${usage.products.length === 1 ? "" : "s"}` : null, usage.pages.length ? `${usage.pages.length} page${usage.pages.length === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(" and ");

/**
 * Refused while products or pages use the asset, unless `force`. The row goes first: a store
 * failure then leaves an orphaned file (logged), never an asset without its file.
 */
export const deleteMediaAsset = async (platform: Platform, id: string, options: { force?: boolean } = {}): Promise<string> => {
  const asset = await getMediaAsset(platform.db, id);
  if (!options.force) {
    const usage = await mediaUsage(platform.db, asset.url);
    if (usage.products.length || usage.pages.length) throw new InvalidStateError(`${asset.filename} is used on ${usageSummary(usage)}; remove it there first, or delete with force`);
  }
  const [deleted] = await platform.db.delete(mediaAssets).where(eq(mediaAssets.id, id)).returning({ id: mediaAssets.id });
  if (!deleted) throw new NotFoundError("MediaAsset", id);
  const storage = storageForProvider(platform, asset.storage);
  if (!storage) platform.logger.warn({ key: asset.key, storage: asset.storage }, "media asset deleted; its file is in storage that is not configured and was kept");
  else await storage.delete(asset.key).catch((err: unknown) => platform.logger.error({ err, key: asset.key, storage: asset.storage }, "media asset deleted, but deleting its file failed"));
  return id;
};

export type MediaFilter = { query?: string | null; kind?: MediaKind | null };

/** Newest first. `query` matches word prefixes in the filename and alt text. */
export const listMediaAssets = async (db: Database, filter: MediaFilter, page: { limit: number; afterId?: string | null }) => {
  const conditions: SQL[] = [];
  if (filter.kind) conditions.push(eq(mediaAssets.kind, filter.kind));
  const tsquery = filter.query ? prefixQuery(filter.query) : null;
  if (tsquery) conditions.push(sql`${mediaSearchDocument(mediaAssets)} @@ to_tsquery('simple', ${tsquery})`);
  const where = conditions.length ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(page.afterId ? and(where, lt(mediaAssets.id, page.afterId)) : where)
    .orderBy(desc(mediaAssets.id))
    .limit(page.limit);
  return { rows, total: await db.$count(mediaAssets, where) };
};
