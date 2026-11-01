import { DirectiveLocation, GraphQLDirective, GraphQLString, lexicographicSortSchema, specifiedDirectives, type GraphQLSchema } from "graphql";
import { toGlobalId } from "../lib/ids.ts";
import { validatePluginDefinitions } from "../modules/plugins/registry.ts";
import type { AnyPluginDefinition, GraphQLExtensionApi } from "../plugins/sdk.ts";
import { ADMIN, BOTH, builder, rawId, STOREFRONT, type SubGraph } from "./builder.ts";
import * as refs from "./refs.ts";
import "./types/common.ts";
import "./types/channels.ts";
import "./types/catalog.ts";
import "./types/catalog-admin.ts";
import "./types/inventory.ts";
import "./types/settings.ts";
import "./types/shipping.ts";
import "./types/payments.ts";
import "./types/builder.ts";
import "./types/media.ts";
import "./types/customers.ts";
import "./types/carts.ts";
import "./types/orders.ts";
import "./types/promotions.ts";
import "./types/staff.ts";
import "./types/integrations.ts";
import "./types/reports.ts";
import "./types/audit.ts";
import "./types/plugins.ts";

/**
 * Operation-level context, e.g. `query Home @inContext(channel: "eu", locale: "de-DE", currency: "EUR") { … }`.
 * Read in the context factory before execution; declared here so documents validate.
 */
export const InContextDirective = new GraphQLDirective({
  name: "inContext",
  description: "Run the operation in a channel, locale and currency. Overrides the X-Channel, Accept-Language and X-Currency headers.",
  locations: [DirectiveLocation.QUERY, DirectiveLocation.MUTATION, DirectiveLocation.SUBSCRIPTION],
  args: {
    channel: { type: GraphQLString, description: "Channel code, e.g. eu." },
    locale: { type: GraphQLString, description: "BCP 47 locale, e.g. de-DE." },
    currency: { type: GraphQLString, description: "ISO 4217 code, e.g. GBP." },
  },
});

const cache = new Map<SubGraph, GraphQLSchema>();

/** Plugins whose graphql() ran in this process, by name. */
const registered = new Set<string>();

/**
 * Adds each plugin's types and fields once per process: the builder is a module singleton and
 * Pothos refuses a type defined twice. A schema built earlier is dropped and rebuilt. The fields
 * stay for the process's life; on a platform without the plugin, `api.context` fails with
 * InvalidStateError.
 */
export const registerPluginGraphQL = (definitions: readonly AnyPluginDefinition[]) => {
  validatePluginDefinitions(definitions);
  let added = false;
  for (const definition of definitions) {
    if (!definition.graphql || registered.has(definition.name)) continue;
    registered.add(definition.name);
    const name = definition.name;
    const api: GraphQLExtensionApi<any> = {
      builder,
      ADMIN,
      STOREFRONT,
      BOTH,
      refs,
      context: (ctx) => ctx.platform.plugins.context(name),
      toGlobalId,
      rawId,
    };
    try {
      definition.graphql(api);
    } catch (error) {
      throw new Error(`Plugin ${name}: graphql() failed: ${(error as Error).message}`, { cause: error });
    }
    added = true;
  }
  if (added) cache.clear();
};

/** The storefront and admin schemas are filtered views of one definition (Pothos sub-graphs). */
export const getSchema = (subGraph: SubGraph): GraphQLSchema => {
  let schema = cache.get(subGraph);
  if (!schema) {
    schema = lexicographicSortSchema(builder.toSchema({ subGraph, directives: [...specifiedDirectives, InContextDirective] }));
    cache.set(subGraph, schema);
  }
  return schema;
};
