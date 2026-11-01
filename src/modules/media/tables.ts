import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createdAt, id, localized, updatedAt } from "../../db/columns.ts";

export type MediaProvider = "local" | "vercel-blob" | "s3";
export type MediaKind = "image" | "video";

/**
 * Filename words (split at `-`, `_` and `.`) and alt text in every locale, for prefix search. The
 * index and the query share this expression so the planner can use the index.
 */
export const mediaSearchDocument = (t: { filename: AnyPgColumn; alt: AnyPgColumn }) =>
  sql`(to_tsvector('simple', translate(lower(${t.filename}), '-_.', '   ')) || to_tsvector('simple', ${t.alt}))`;

/**
 * The media library. `storage` and `key` locate the object (keys are never reused); `url` is where
 * it is served from. Ids are time-ordered, so the indexes on `id` and `(kind, id)` list by age.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    storage: text("storage").$type<MediaProvider>().notNull(),
    key: text("key").notNull(),
    url: text("url").notNull(),
    /** For display and search; renaming does not move the object. */
    filename: text("filename").notNull(),
    /** Detected from the file's bytes, never taken from the client. */
    contentType: text("content_type").notNull(),
    kind: text("kind").$type<MediaKind>().notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    alt: localized("alt"),
    /** SHA-256 of the bytes, when they passed through the API (multipart uploads). */
    checksum: text("checksum"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("media_assets_storage_key_uq").on(t.storage, t.key),
    index("media_assets_kind_idx").on(t.kind, t.id),
    index("media_assets_search_idx").using("gin", mediaSearchDocument(t)),
  ],
);
