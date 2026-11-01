import SchemaBuilder from "@pothos/core";
import ComplexityPlugin from "@pothos/plugin-complexity";
import ErrorsPlugin from "@pothos/plugin-errors";
import RelayPlugin from "@pothos/plugin-relay";
import ScopeAuthPlugin, { type AuthFailure } from "@pothos/plugin-scope-auth";
import SimpleObjectsPlugin from "@pothos/plugin-simple-objects";
import SubGraphPlugin from "@pothos/plugin-sub-graph";
import TracingPlugin from "@pothos/plugin-tracing";
import { AuthenticationError, NotFoundError, PermissionDeniedError, ValidationError } from "../lib/errors.ts";
import { parseGlobalId, toGlobalId } from "../lib/ids.ts";
import { hasPermission } from "../modules/staff/service.ts";
import { auditMutation } from "./audit.ts";
import type { GraphQLContext } from "./context.ts";

/** The permission a failed `{ permission: "…" }` scope asked for, searched through combined failures. */
const requiredPermission = (failure: AuthFailure): string | null => {
  if (failure.kind === "AuthScope" && failure.scope === "permission") return String(failure.parameter);
  if ("failures" in failure) {
    for (const nested of failure.failures) {
      const found = requiredPermission(nested);
      if (found) return found;
    }
  }
  return null;
};

export type SubGraph = "storefront" | "admin";
export const BOTH: SubGraph[] = ["storefront", "admin"];
export const ADMIN: SubGraph[] = ["admin"];
export const STOREFRONT: SubGraph[] = ["storefront"];

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  SubGraphs: SubGraph;
  AuthScopes: { customer: boolean; staff: boolean; permission: string };
  DefaultInputFieldRequiredness: false;
  Connection: { totalCount: number };
  Scalars: {
    DateTime: { Input: Date; Output: Date };
    Decimal: { Input: string; Output: string };
    JSON: { Input: unknown; Output: unknown };
    CurrencyCode: { Input: string; Output: string };
    CountryCode: { Input: string; Output: string };
    LocaleCode: { Input: string; Output: string };
    EmailAddress: { Input: string; Output: string };
  };
}>({
  // Tracing (the audit log) wraps everything, so it sees typed failures as results. Errors wraps
  // scope-auth so authorization failures become typed results on mutations.
  plugins: [TracingPlugin, SubGraphPlugin, ErrorsPlugin, ScopeAuthPlugin, RelayPlugin, ComplexityPlugin, SimpleObjectsPlugin],
  tracing: {
    default: (config) => config.parentType === "Mutation",
    wrap: (resolver, _options, config) => auditMutation(resolver as Parameters<typeof auditMutation>[0], config.name),
  },
  subGraphs: { defaultForTypes: BOTH, fieldsInheritFromTypes: true },
  scopeAuth: {
    authScopes: async (context) => ({
      customer: context.customer !== null,
      staff: context.staff !== null || context.apiKey !== null,
      permission: (permission: string) => hasPermission(context.permissions, permission),
    }),
    unauthorizedError: (_parent, context, _info, result) =>
      context.customer || context.staff || context.apiKey ? new PermissionDeniedError(requiredPermission(result.failure) ?? "this operation") : new AuthenticationError(),
  },
  errors: {
    defaultTypes: [ValidationError, AuthenticationError, PermissionDeniedError, NotFoundError],
    directResult: true,
    defaultUnionOptions: {
      name: ({ parentTypeName, fieldName }) => `${fieldName[0]!.toUpperCase()}${fieldName.slice(1)}${parentTypeName === "Mutation" ? "" : parentTypeName}Result`,
    },
  },
  relay: {
    clientMutationId: "omit",
    cursorType: "String",
    encodeGlobalID: (typename, id) => toGlobalId(typename, String(id)),
    decodeGlobalID: (globalID) => {
      const parsed = parseGlobalId(globalID);
      if (!parsed) throw new ValidationError("Malformed id", [{ path: ["id"], message: `Expected gid://ecom/<Type>/<uuid>, got ${globalID}` }]);
      return { typename: parsed.type, id: parsed.id };
    },
    nodeQueryOptions: {
      description: "Refetch any object by its global id.",
      resolve: (_root, { id }, _context, info, resolveNode) => (info.schema.getType(id.typename) ? resolveNode(id) : null),
    },
    nodesQueryOptions: {
      description: "Refetch several objects by global id, in order.",
      resolve: (_root, { ids }, _context, info, resolveNodes) => resolveNodes(ids.filter((id) => info.schema.getType(id.typename))),
    },
  },
  // Every field costs 1; connections multiply their children by `first`, and the few long plain
  // lists (variants, lines) declare their own multipliers.
  complexity: {
    defaultComplexity: 1,
    defaultListMultiplier: 1,
    limit: (context) => ({
      complexity: context.api === "admin" ? context.platform.config.graphql.adminMaxComplexity : context.platform.config.graphql.maxComplexity,
      depth: context.platform.config.graphql.maxDepth,
      breadth: 250,
    }),
  },
});

builder.queryType({ description: "Entry point for reads." });
builder.mutationType({ description: "Entry point for writes. Every mutation returns a result union: the payload or a typed error." });
builder.subscriptionType({ subGraphs: BOTH, description: "Live updates over Server-Sent Events." });

/** Clamps `first` to 1..max, so responses stay bounded. */
export const pageSize = (first: number | null | undefined, fallback = 20, max = 100) => Math.min(Math.max(first ?? fallback, 1), max);

/** A connection costs 2, plus its children times the page size. */
export const connectionComplexity = (args: { first?: number | null }) => ({ field: 2, multiplier: pageSize(args.first) });

export const rawId = (gid: { id: string } | string): string => (typeof gid === "string" ? (parseGlobalId(gid)?.id ?? gid) : gid.id);
