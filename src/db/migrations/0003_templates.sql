CREATE TABLE "builder_template_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"template_for" text NOT NULL,
	"product_id" uuid,
	"category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_template_targets_one_target" CHECK ("builder_template_targets"."product_id" is null or "builder_template_targets"."category_id" is null)
);
--> statement-breakpoint
ALTER TABLE "builder_components" ADD COLUMN "template_for" text;--> statement-breakpoint
ALTER TABLE "builder_template_targets" ADD CONSTRAINT "builder_template_targets_page_id_builder_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."builder_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_template_targets" ADD CONSTRAINT "builder_template_targets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_template_targets" ADD CONSTRAINT "builder_template_targets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_template_targets_page_product_uq" ON "builder_template_targets" USING btree ("page_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_template_targets_page_category_uq" ON "builder_template_targets" USING btree ("page_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_template_targets_page_default_uq" ON "builder_template_targets" USING btree ("page_id") WHERE "builder_template_targets"."product_id" is null and "builder_template_targets"."category_id" is null;--> statement-breakpoint
CREATE INDEX "builder_template_targets_product_idx" ON "builder_template_targets" USING btree ("template_for","product_id");--> statement-breakpoint
CREATE INDEX "builder_template_targets_category_idx" ON "builder_template_targets" USING btree ("template_for","category_id");