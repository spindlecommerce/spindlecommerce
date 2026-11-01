import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, localized, updatedAt, uuidArray } from "../../db/columns.ts";
import { categories, products } from "../catalog/tables.ts";
import type { ComponentKind, FieldDefinition, PageDocument, TemplateFor, Variation } from "./model.ts";

/** The component library. Definitions synced from a frontend's code have `source = 'code'`. */
export const builderComponents = pgTable(
  "builder_components",
  {
    id: id(),
    code: text("code").notNull(),
    kind: text("kind").$type<ComponentKind>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Picker section, e.g. "Sections", "Commerce", "Media". */
    groupName: text("group_name"),
    icon: text("icon"),
    previewImageUrl: text("preview_image_url"),
    fields: jsonb("fields").$type<FieldDefinition[]>().notNull().default([]),
    variations: jsonb("variations").$type<Variation[]>().notNull().default([]),
    /** Content types only: pages of this type have a URL path. */
    routable: boolean("routable").notNull().default(true),
    /** Content types only: at most one page of this type (site header, footer, settings). */
    singleton: boolean("singleton").notNull().default(false),
    /** Content types: a product or category template. Components: show that object's data. */
    templateFor: text("template_for").$type<TemplateFor>(),
    /** Content types: pages of this type are one product's or category's own sections. */
    sectionsFor: text("sections_for").$type<TemplateFor>(),
    source: text("source").$type<"admin" | "code">().notNull().default("admin"),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("builder_components_code_uq").on(t.code)],
);

/**
 * Draft and published versions are whole documents; publishing copies the draft. `version` goes
 * up on every draft save and guards against overwriting someone else's edit.
 */
export const builderPages = pgTable(
  "builder_pages",
  {
    id: id(),
    type: text("type").notNull(),
    /** The draft's path, as a column for uniqueness checks and search. */
    path: text("path"),
    /** The path the published version is served at. */
    publishedPath: text("published_path"),
    title: localized("title"),
    channelIds: uuidArray("channel_ids"),
    draft: jsonb("draft").$type<PageDocument>().notNull(),
    published: jsonb("published").$type<PageDocument>(),
    version: integer("version").notNull().default(1),
    publishedVersion: integer("published_version"),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }).notNull().defaultNow(),
    draftUpdatedBy: uuid("draft_updated_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    firstPublishedAt: timestamp("first_published_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /** Why the last scheduled publish failed. */
    scheduleError: text("schedule_error"),
    /** Sections pages only: the product or category whose sections these are. */
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("builder_pages_path_uq").on(t.path),
    uniqueIndex("builder_pages_published_path_uq").on(t.publishedPath),
    index("builder_pages_type_idx").on(t.type),
    index("builder_pages_scheduled_idx").on(t.scheduledAt),
    uniqueIndex("builder_pages_product_uq").on(t.productId),
    uniqueIndex("builder_pages_category_uq").on(t.categoryId),
    check("builder_pages_one_owner", sql`${t.productId} is null or ${t.categoryId} is null`),
  ],
);

/** Snapshots for history and restore: every publish, restore and explicit or periodic save. */
export const builderPageVersions = pgTable(
  "builder_page_versions",
  {
    id: id(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => builderPages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    kind: text("kind").$type<"publish" | "save" | "restore" | "autosave">().notNull(),
    document: jsonb("document").$type<PageDocument>().notNull(),
    label: text("label"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("builder_page_versions_page_idx").on(t.pageId, t.createdAt)],
);

/**
 * Which template renders which product or category page. A row names a product, a category (for a
 * product template, every product in it or its subcategories), or neither: the default.
 */
export const builderTemplateTargets = pgTable(
  "builder_template_targets",
  {
    id: id(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => builderPages.id, { onDelete: "cascade" }),
    /** Copied from the template, for lookups by product or category. */
    templateFor: text("template_for").$type<TemplateFor>().notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    /** Of two templates assigned the same target, the newer one is waiting to take it over. */
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("builder_template_targets_page_product_uq").on(t.pageId, t.productId),
    uniqueIndex("builder_template_targets_page_category_uq").on(t.pageId, t.categoryId),
    uniqueIndex("builder_template_targets_page_default_uq").on(t.pageId).where(sql`${t.productId} is null and ${t.categoryId} is null`),
    index("builder_template_targets_product_idx").on(t.templateFor, t.productId),
    index("builder_template_targets_category_idx").on(t.templateFor, t.categoryId),
    check("builder_template_targets_one_target", sql`${t.productId} is null or ${t.categoryId} is null`),
  ],
);

/** Pages to publish together, now or at a scheduled time. */
export const builderReleases = pgTable("builder_releases", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").$type<"open" | "scheduled" | "published" | "failed">().notNull().default("open"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: uuid("published_by"),
  error: text("error"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const builderReleasePages = pgTable(
  "builder_release_pages",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => builderReleases.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => builderPages.id, { onDelete: "cascade" }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.pageId] })],
);

/**
 * A storefront app the builder previews in and deploys to. Preview opens `url + previewPath` with
 * a short-lived token; publishes reach it by webhook (`revalidatePath`) and optional deploy hook.
 */
export const builderFrontends = pgTable("builder_frontends", {
  id: id(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  previewPath: text("preview_path").notNull().default("/api/draft"),
  revalidatePath: text("revalidate_path"),
  webhookSubscriptionId: uuid("webhook_subscription_id"),
  deployHookUrl: text("deploy_hook_url"),
  defaultChannelId: uuid("default_channel_id"),
  isDefault: boolean("is_default").notNull().default(false),
  lastDeployAt: timestamp("last_deploy_at", { withTimezone: true }),
  lastDeployStatus: text("last_deploy_status"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
