CREATE TABLE IF NOT EXISTS "plugin_email_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template" text NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"order_id" uuid,
	"order_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_email_messages_created_idx" ON "plugin_email_messages" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_email_messages_order_idx" ON "plugin_email_messages" USING btree ("order_id", "template");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_email_messages_status_idx" ON "plugin_email_messages" USING btree ("status", "id");
