/** Write the storefront and admin SDL to schema/ (checked in, diffed in review) with design statistics. */
import { mkdirSync, writeFileSync } from "node:fs";
import { getNamedType, isInputObjectType, isInterfaceType, isObjectType, isUnionType, printSchema, type GraphQLSchema } from "graphql";
import ecom from "../ecom.config.ts";
import { getSchema, registerPluginGraphQL } from "../src/graphql/schema.ts";

// Include the configured plugins' types and fields.
registerPluginGraphQL(ecom.plugins);

const stats = (schema: GraphQLSchema) => {
  const types = Object.values(schema.getTypeMap()).filter((t) => !t.name.startsWith("__"));
  const fields = types.flatMap((t) => (isObjectType(t) || isInterfaceType(t) ? Object.values(t.getFields()).map((f) => ({ type: t.name, f })) : []));
  const mutations = Object.values(schema.getMutationType()?.getFields() ?? {});
  const errorTypes = types.filter((t) => isObjectType(t) && t.getInterfaces().some((i) => i.name === "Error"));
  return {
    queries: Object.keys(schema.getQueryType()?.getFields() ?? {}).length,
    mutations: mutations.length,
    subscriptions: Object.keys(schema.getSubscriptionType()?.getFields() ?? {}).length,
    types: types.length,
    cursorConnections: fields.filter(({ f }) => getNamedType(f.type).name.endsWith("Connection")).length,
    pageNumberPaginatedFields: fields.filter(({ f }) => f.args.some((a) => a.name === "currentPage" || a.name === "pageSize")).length,
    mutationsReturningResultUnions: mutations.filter((m) => isUnionType(getNamedType(m.type))).length,
    mutationsReturningBareScalars: mutations.filter((m) => !isUnionType(getNamedType(m.type)) && !isObjectType(getNamedType(m.type))).length,
    typedErrorTypes: errorTypes.length,
    oneOfInputs: types.filter((t) => isInputObjectType(t) && t.isOneOf).length,
    floatMoneyFields: fields.filter(({ f }) => getNamedType(f.type).name === "Float" && /(price|amount|total|discount|subtotal|tax(?!Rate)|fee)/i.test(f.name)).length,
    nodeTypes: types.filter((t) => isObjectType(t) && t.getInterfaces().some((i) => i.name === "Node")).length,
    deprecatedFields: fields.filter(({ f }) => f.deprecationReason).length,
  };
};

mkdirSync("schema", { recursive: true });
const all: Record<string, ReturnType<typeof stats>> = {};
for (const api of ["storefront", "admin"] as const) {
  const schema = getSchema(api);
  writeFileSync(`schema/${api}.graphql`, `${printSchema(schema)}\n`);
  all[api] = stats(schema);
  console.log(`${api}: ${all[api].queries} queries, ${all[api].mutations} mutations, ${all[api].subscriptions} subscriptions, ${all[api].types} types → schema/${api}.graphql`);
}
writeFileSync("schema/stats.json", `${JSON.stringify(all, null, 2)}\n`);
console.log(JSON.stringify(all, null, 2));
