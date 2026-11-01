ALTER TABLE "builder_components" ADD COLUMN "sections_for" text;--> statement-breakpoint
ALTER TABLE "builder_pages" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "builder_pages" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "builder_pages" ADD CONSTRAINT "builder_pages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_pages" ADD CONSTRAINT "builder_pages_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_pages_product_uq" ON "builder_pages" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_pages_category_uq" ON "builder_pages" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "builder_pages" ADD CONSTRAINT "builder_pages_one_owner" CHECK ("builder_pages"."product_id" is null or "builder_pages"."category_id" is null);