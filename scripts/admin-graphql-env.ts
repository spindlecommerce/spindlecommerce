/**
 * Write admin/src/graphql/graphql-env.d.ts, which gql.tada infers the admin's query types from.
 * Its CLI needs TypeScript's JavaScript compiler API, which TypeScript 7 no longer ships, so this
 * calls its output function directly. Run by `pnpm schema:print`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { minifyIntrospection, outputIntrospectionFile } from "@gql.tada/internal";
import { buildSchema, introspectionFromSchema } from "graphql";

const schema = buildSchema(readFileSync("schema/admin.graphql", "utf8"));
const introspection = minifyIntrospection(introspectionFromSchema(schema, { descriptions: false }));
const target = "admin/src/graphql/graphql-env.d.ts";
writeFileSync(target, outputIntrospectionFile(introspection, { fileType: ".d.ts", shouldPreprocess: true }));
console.log(`Wrote ${target}`);
