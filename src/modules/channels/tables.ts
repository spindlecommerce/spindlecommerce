import { bigint, boolean, numeric, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, textArray, updatedAt } from "../../db/columns.ts";
import { stocks } from "../inventory/tables.ts";
import { taxClasses } from "../tax/tables.ts";

/** A sales channel: the scope for locales, currencies, countries, stock and tax display. */
export const channels = pgTable("channels", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  defaultLocale: text("default_locale").notNull(),
  locales: textArray("locales"),
  defaultCurrency: text("default_currency").notNull(),
  currencies: textArray("currencies"),
  /** Countries this channel sells to (ISO 3166-1 alpha-2). */
  countries: textArray("countries"),
  stockId: uuid("stock_id").references(() => stocks.id),
  pricesIncludeTax: boolean("prices_include_tax").notNull().default(false),
  shippingTaxClassId: uuid("shipping_tax_class_id").references(() => taxClasses.id),
  orderNumberPrefix: text("order_number_prefix").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    baseCurrency: text("base_currency").notNull(),
    quoteCurrency: text("quote_currency").notNull(),
    rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.baseCurrency, t.quoteCurrency] })],
);

/** Gap-free counters for human-readable document numbers (orders, invoices, refunds). */
export const sequences = pgTable("sequences", {
  key: text("key").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
});
