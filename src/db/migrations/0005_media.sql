CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"url" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"kind" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_key_uq" ON "media_assets" USING btree ("storage","key");--> statement-breakpoint
CREATE INDEX "media_assets_kind_idx" ON "media_assets" USING btree ("kind","id");--> statement-breakpoint
CREATE INDEX "media_assets_search_idx" ON "media_assets" USING gin ((to_tsvector('simple', translate(lower("filename"), '-_.', '   ')) || to_tsvector('simple', "alt")));