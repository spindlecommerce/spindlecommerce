import { integer, numeric, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt, uuidArray } from "../../db/columns.ts";

export const taxClasses = pgTable("tax_classes", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").$type<"product" | "customer">().notNull(),
  createdAt: createdAt(),
});

export const taxRates = pgTable("tax_rates", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  countryCode: text("country_code").notNull(),
  /** Null matches every region of the country. */
  regionCode: text("region_code"),
  /** Glob on the postal code (`9*`, `10115`); null matches all. */
  postalCodePattern: text("postal_code_pattern"),
  /** Percent, e.g. 19.0000. */
  rate: numeric("rate", { precision: 7, scale: 4 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Rates of rules with equal priority add up; higher priorities compound on top. */
export const taxRules = pgTable("tax_rules", {
  id: id(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(0),
  productTaxClassIds: uuidArray("product_tax_class_ids"),
  customerTaxClassIds: uuidArray("customer_tax_class_ids"),
  taxRateIds: uuidArray("tax_rate_ids"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
