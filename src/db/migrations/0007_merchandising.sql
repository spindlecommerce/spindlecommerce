CREATE TABLE "category_merchandising" (
	"category_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"pin_position" integer,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "category_merchandising_category_id_product_id_pk" PRIMARY KEY("category_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "product_search" ADD COLUMN "pin_positions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_search" ADD COLUMN "hidden_in_category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "category_merchandising" ADD CONSTRAINT "category_merchandising_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_merchandising" ADD CONSTRAINT "category_merchandising_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_merchandising_product_idx" ON "category_merchandising" USING btree ("product_id");