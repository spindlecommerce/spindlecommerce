CREATE TABLE "plugin_event_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plugin" text NOT NULL,
	"handler" text NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_kv" (
	"plugin" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_kv_plugin_key_pk" PRIMARY KEY("plugin","key")
);
--> statement-breakpoint
CREATE TABLE "plugin_migrations" (
	"plugin" text NOT NULL,
	"name" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_migrations_plugin_name_pk" PRIMARY KEY("plugin","name")
);
--> statement-breakpoint
CREATE TABLE "plugin_settings" (
	"plugin" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_task_runs" (
	"plugin" text NOT NULL,
	"task" text NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	CONSTRAINT "plugin_task_runs_plugin_task_pk" PRIMARY KEY("plugin","task")
);
--> statement-breakpoint
CREATE TABLE "shipping_rate_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"rates" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "payment_session" jsonb;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD COLUMN "shipment" jsonb;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "reference_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_event_deliveries_uq" ON "plugin_event_deliveries" USING btree ("plugin","handler","event_id");--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_due_idx" ON "plugin_event_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "plugin_kv_expires_idx" ON "plugin_kv" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "shipping_rate_cache_expires_idx" ON "shipping_rate_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_reference_uq" ON "payment_transactions" USING btree ("reference_key");