import { sql } from "drizzle-orm";
import { bigint, customType, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "../lib/ids.ts";
import type { LocalizedText } from "../lib/i18n.ts";

export const id = () => uuid("id").primaryKey().$defaultFn(newId);

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Integer minor units (cents). */
export const money = (name: string) => bigint(name, { mode: "number" });

export const localized = (name: string) => jsonb(name).$type<LocalizedText>().notNull().default(sql`'{}'::jsonb`);

export const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const uuidArray = (name: string) => uuid(name).array().notNull().default(sql`'{}'::uuid[]`);

export const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
