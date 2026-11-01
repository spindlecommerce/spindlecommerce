import { sql } from "drizzle-orm";
import { boolean, date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "../../db/columns.ts";
import { taxClasses } from "../tax/tables.ts";

export const customerGroups = pgTable("customer_groups", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  taxClassId: uuid("tax_class_id").references(() => taxClasses.id),
  createdAt: createdAt(),
});

export const customers = pgTable(
  "customers",
  {
    id: id(),
    /** Stored lowercased; unique across the platform. */
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone"),
    dateOfBirth: date("date_of_birth"),
    groupId: uuid("group_id").notNull().references(() => customerGroups.id),
    isActive: boolean("is_active").notNull().default(true),
    acceptsMarketing: boolean("accepts_marketing").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Staff notes; exposed in the admin API only. */
    note: text("note"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("customers_email_uq").on(t.email), index("customers_group_idx").on(t.groupId)],
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: id(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    company: text("company"),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    region: text("region"),
    regionCode: text("region_code"),
    postalCode: text("postal_code").notNull(),
    countryCode: text("country_code").notNull(),
    phone: text("phone"),
    isDefaultShipping: boolean("is_default_shipping").notNull().default(false),
    isDefaultBilling: boolean("is_default_billing").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customer_addresses_customer_idx").on(t.customerId)],
);
