import { readFileSync } from "node:fs";
import { usePersistedOperations } from "@graphql-yoga/plugin-persisted-operations";
import { useResponseCache, type Cache } from "@graphql-yoga/plugin-response-cache";
import { getOperationAST, GraphQLError, NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga, type Plugin, type YogaServerInstance } from "graphql-yoga";
import { DomainError } from "../lib/errors.ts";
import { requestOutboxDrain } from "../modules/integrations/outbox.ts";
import type { Platform } from "../platform.ts";
import type { SubGraph } from "./builder.ts";
import { createContext, type GraphQLContext } from "./context.ts";
import { TTL_PER_SCHEMA_COORDINATE } from "./response-cache.ts";
import { getSchema } from "./schema.ts";

const UNAUTHENTICATED_STATUS = 401;

/**
 * Domain errors outside a result union keep their code. Anything else goes to plugins' onError
 * hooks and is masked in production.
 */
const maskError = (production: boolean, report: (error: unknown) => void) => (error: unknown, message: string) => {
  const original = error instanceof GraphQLError ? error.originalError : error;
  if (original instanceof DomainError) {
    return new GraphQLError(original.message, {
      extensions: { code: original.code, ...(original.code === "UNAUTHENTICATED" ? { http: { status: UNAUTHENTICATED_STATUS } } : {}) },
    });
  }
  if (error instanceof GraphQLError && !error.originalError) return error;
  report(original);
  return production ? new GraphQLError(message, { extensions: { code: "INTERNAL_SERVER_ERROR" } }) : (error as GraphQLError);
};

const disableIntrospection = (): Plugin => ({
  onValidate: ({ addValidationRule }) => addValidationRule(NoSchemaIntrospectionCustomRule),
});

/**
 * Admin mutations can queue outbox work without writing an event (retrying a webhook delivery), so
 * ask for a drain after the request. On Vercel nothing else would drain promptly.
 */
const drainAfterMutations = (): Plugin => ({
  onExecute: ({ args }) => {
    if (getOperationAST(args.document, args.operationName)?.operation === "mutation") requestOutboxDrain();
  },
});

export type GraphQLHandler = { yoga: YogaServerInstance<Record<string, unknown>, GraphQLContext>; cache: Cache | null };

/**
 * One Yoga instance per API. The storefront caches public results per channel, locale, currency
 * and credentials; carts, customers and orders are never cached.
 */
export const createGraphQLHandler = (platform: Platform, api: SubGraph, endpoint = api === "admin" ? "/admin/graphql" : "/graphql"): GraphQLHandler => {
  const { graphql, production } = platform.config;
  const cache = api === "storefront" ? (platform.responseCache?.cache ?? null) : null;
  const persisted = process.env.PERSISTED_OPERATIONS_FILE
    ? (JSON.parse(readFileSync(process.env.PERSISTED_OPERATIONS_FILE, "utf8")) as Record<string, string>)
    : null;

  const plugins: Plugin[] = [];
  if (!graphql.introspection) plugins.push(disableIntrospection());
  if (api === "admin") plugins.push(drainAfterMutations());
  if (persisted) {
    plugins.push(usePersistedOperations({ getPersistedOperation: (key) => persisted[key] ?? null, allowArbitraryOperations: false }) as Plugin);
  }
  if (cache) {
    plugins.push(
      useResponseCache({
        cache,
        ttl: graphql.responseCacheTtlMs,
        // The cache key already covers the document (including @inContext) and variables;
        // add header-provided scope and credentials so nothing leaks across them.
        session: (request) =>
          [request.headers.get("x-channel"), request.headers.get("x-locale") ?? request.headers.get("accept-language"), request.headers.get("x-currency"), request.headers.get("authorization")]
            .map((v) => v ?? "")
            .join("|"),
        // Never cache draft previews. Called with the HTTP request and, during execution, with our
        // context (whose `request` is not a Request), so check both.
        enabled: (request, context) => !request?.headers?.get?.("x-preview-token") && !(context as { preview?: unknown } | undefined)?.preview,
        // "Nothing here" is not cached: entity invalidation cannot reach a response without the
        // entity, so a page or product published later at that path would stay invisible.
        shouldCacheResult: ({ result }) => !result.errors?.length && !Object.values(result.data ?? {}).some((value) => value === null),
        ttlPerSchemaCoordinate: { ...TTL_PER_SCHEMA_COORDINATE },
        // Responses containing private data are never cached.
        ignoredTypes: ["Cart", "CartLine", "Customer", "CustomerAddress", "Order", "OrderUpdate", "Session", "CustomerAuthPayload"],
        includeExtensionMetadata: !production,
      }) as Plugin,
    );
  }

  const yoga = createYoga<Record<string, unknown>, GraphQLContext>({
    schema: getSchema(api),
    graphqlEndpoint: endpoint,
    context: async ({ request, params, clientIp }) => {
      try {
        return await createContext(platform, api, request, params as { query?: string; operationName?: string | null; variables?: Record<string, unknown> | null }, { clientIp: clientIp as string | undefined });
      } catch (error) {
        if (error instanceof DomainError) {
          throw new GraphQLError(error.message, { extensions: { code: error.code, http: { status: error.code === "UNAUTHENTICATED" ? UNAUTHENTICATED_STATUS : 400 } } });
        }
        throw error;
      }
    },
    maskedErrors: { maskError: maskError(production, (error) => void platform.plugins.reportError(error, { source: "graphql", details: { api } })) },
    graphiql: production ? false : { title: api === "admin" ? "Ecom Admin API" : "Ecom Storefront API" },
    landingPage: false,
    logging: process.env.NODE_ENV === "test" ? false : "warn",
    plugins,
  });
  return { yoga, cache };
};
