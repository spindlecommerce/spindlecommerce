import { eq } from "drizzle-orm";
import { Kind, parse, type DocumentNode, type OperationDefinitionNode, type ValueNode } from "graphql";
import type { Database } from "../db/client.ts";
import { AuthenticationError } from "../lib/errors.ts";
import { verifyAccessToken, verifyApiKey, type ApiKey } from "../modules/auth/service.ts";
import { quoteProviders, resolveCustomerPricingGroup } from "../modules/carts/quote.ts";
import { verifyPreviewToken, type PreviewClaims } from "../modules/builder/preview.ts";
import { resolveScope, type ResolvedScope } from "../modules/channels/service.ts";
import type { Customer } from "../modules/customers/service.ts";
import { customers } from "../modules/customers/tables.ts";
import type { Actor } from "../modules/orders/service.ts";
import { getStaffPermissions, getStaffUser, type StaffUser } from "../modules/staff/service.ts";
import type { Platform } from "../platform.ts";
import type { SubGraph } from "./builder.ts";
import { createLoaders, type Loaders } from "./loaders.ts";

export type GraphQLContext = {
  api: SubGraph;
  platform: Platform;
  db: Database;
  scope: ResolvedScope;
  customer: Customer | null;
  /** Pricing group: the customer's group, or the guest group. */
  customerGroupId: string | null;
  staff: StaffUser | null;
  apiKey: ApiKey | null;
  permissions: Set<string>;
  actor: Actor;
  loaders: Loaders;
  /** Recorded in the audit log. */
  request: { ip: string | null; userAgent: string | null; operationName: string | null };
  /** Storefront requests with a valid `x-preview-token`: serve builder drafts. */
  preview: PreviewClaims | null;
};

export type InContext = { channel?: string | null; locale?: string | null; currency?: string | null };

const literal = (node: ValueNode, variables: Record<string, unknown>): string | null => {
  if (node.kind === Kind.STRING || node.kind === Kind.ENUM) return node.value;
  if (node.kind === Kind.VARIABLE) {
    const value = variables[node.name.value];
    return typeof value === "string" ? value : null;
  }
  return null;
};

const documents = new Map<string, DocumentNode | null>();

/**
 * Reads `@inContext(channel:, locale:, currency:)` from the operation. Unlike headers, it is visible
 * to tooling and part of a GET request's cache key.
 */
export const extractInContext = (query: string | undefined, operationName: string | null | undefined, variables: Record<string, unknown> = {}): InContext => {
  if (!query || !query.includes("@inContext")) return {};
  let document = documents.get(query);
  if (document === undefined) {
    try {
      document = parse(query, { noLocation: true });
    } catch {
      document = null;
    }
    if (documents.size > 500) documents.clear();
    documents.set(query, document);
  }
  if (!document) return {};
  const operations = document.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  const operation = operationName ? operations.find((o) => o.name?.value === operationName) : operations[0];
  const directive = operation?.directives?.find((d) => d.name.value === "inContext");
  if (!directive) return {};
  const out: InContext = {};
  for (const arg of directive.arguments ?? []) {
    const value = literal(arg.value, variables);
    if (arg.name.value === "channel") out.channel = value;
    if (arg.name.value === "locale") out.locale = value;
    if (arg.name.value === "currency") out.currency = value;
  }
  return out;
};

const bearer = (request: Request) => {
  const header = request.headers.get("authorization");
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
};

/**
 * Invalid credentials fail the request (401) rather than fall back to anonymous, so clients notice
 * expired tokens.
 */
export const createContext = async (
  platform: Platform,
  api: SubGraph,
  request: Request,
  params: { query?: string; operationName?: string | null; variables?: Record<string, unknown> | null },
  server: { clientIp?: string | null } = {},
): Promise<GraphQLContext> => {
  const { db, config } = platform;
  const inContext = extractInContext(params.query, params.operationName, params.variables ?? {});
  const scope = await resolveScope(
    db,
    {
      channel: inContext.channel ?? request.headers.get("x-channel"),
      locale: inContext.locale ?? request.headers.get("x-locale") ?? request.headers.get("accept-language"),
      currency: inContext.currency ?? request.headers.get("x-currency"),
    },
    config.defaultChannelCode,
  );
  const token = bearer(request);
  let customer: Customer | null = null;
  let staff: StaffUser | null = null;
  let apiKey: ApiKey | null = null;
  let permissions = new Set<string>();
  if (token && api === "storefront") {
    const id = await verifyAccessToken(config, token, "customer");
    customer = (await db.query.customers.findFirst({ where: eq(customers.id, id) })) ?? null;
    if (!customer?.isActive) throw new AuthenticationError("The customer account is not active");
  } else if (token && api === "admin") {
    if (token.startsWith("ek_")) {
      apiKey = await verifyApiKey(db, token);
      permissions = new Set(apiKey.permissions);
    } else {
      const id = await verifyAccessToken(config, token, "staff");
      staff = (await getStaffUser(db, id)) ?? null;
      if (!staff?.isActive) throw new AuthenticationError("The staff account is not active");
      permissions = await getStaffPermissions(db, staff.id);
    }
  }
  const previewToken = api === "storefront" ? request.headers.get("x-preview-token") : null;
  const preview = previewToken ? await verifyPreviewToken(config, previewToken) : null;
  const pricing = await resolveCustomerPricingGroup(db, customer?.id ?? null);
  const actor: Actor = customer ? { type: "customer", id: customer.id } : staff ? { type: "staff", id: staff.id } : apiKey ? { type: "api_key", id: apiKey.id } : { type: "system", id: null };
  return {
    api,
    platform,
    db,
    scope,
    customer,
    customerGroupId: pricing.groupId,
    staff,
    apiKey,
    permissions,
    actor,
    // Live carrier rates for shoppers only; admin reads (e.g. reports over old carts) use cached rates.
    loaders: createLoaders(db, scope, { customerGroupId: pricing.groupId }, quoteProviders(platform, { liveRates: api === "storefront" })),
    request: {
      ip: server.clientIp ?? null,
      userAgent: request.headers.get("user-agent"),
      operationName: params.operationName ?? null,
    },
    preview,
  };
};
