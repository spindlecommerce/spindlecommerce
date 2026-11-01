ALTER TABLE "kitchen_sink_notes" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "kitchen_sink_notes_pinned_idx" ON "kitchen_sink_notes" USING btree ("pinned");
