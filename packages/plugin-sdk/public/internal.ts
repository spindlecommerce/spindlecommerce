/**
 * Stand-ins for platform types in the npm build of the SDK (scripts/plugin-sdk-package.ts). Only
 * `Database` and `Address` are covered by `apiVersion`; the rest is internal, so typed loosely.
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** The platform's PostgreSQL database (Drizzle), for the plugin's own tables. */
export type Database = PgDatabase<PgQueryResultHKT>;

/** `countryCode` is ISO 3166-1 alpha-2. Must match the platform's type; a unit test checks it. */
export type Address = {
  firstName: string;
  lastName: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  regionCode?: string | null;
  postalCode: string;
  countryCode: string;
  phone?: string | null;
};

/** `ctx.platform`: the rest of the platform, outside the plugin API. */
export type Platform = unknown;

/** What a GraphQL resolver receives as its context. */
export type GraphQLContext = unknown;

export type SubGraph = "storefront" | "admin";

/** The platform's Pothos schema builder. */
export declare const builder: any;
