CREATE TABLE "builder_components" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"group_name" text,
	"icon" text,
	"preview_image_url" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"routable" boolean DEFAULT true NOT NULL,
	"singleton" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'admin' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_frontends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"preview_path" text DEFAULT '/api/draft' NOT NULL,
	"revalidate_path" text,
	"webhook_subscription_id" uuid,
	"deploy_hook_url" text,
	"default_channel_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_deploy_at" timestamp with time zone,
	"last_deploy_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_page_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"document" jsonb NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"path" text,
	"published_path" text,
	"title" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"draft_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"draft_updated_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"first_published_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"schedule_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_release_pages" (
	"release_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_release_pages_release_id_page_id_pk" PRIMARY KEY("release_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "builder_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builder_page_versions" ADD CONSTRAINT "builder_page_versions_page_id_builder_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."builder_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_release_pages" ADD CONSTRAINT "builder_release_pages_release_id_builder_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."builder_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_release_pages" ADD CONSTRAINT "builder_release_pages_page_id_builder_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."builder_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_components_code_uq" ON "builder_components" USING btree ("code");--> statement-breakpoint
CREATE INDEX "builder_page_versions_page_idx" ON "builder_page_versions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_pages_path_uq" ON "builder_pages" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_pages_published_path_uq" ON "builder_pages" USING btree ("published_path");--> statement-breakpoint
CREATE INDEX "builder_pages_type_idx" ON "builder_pages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "builder_pages_scheduled_idx" ON "builder_pages" USING btree ("scheduled_at");