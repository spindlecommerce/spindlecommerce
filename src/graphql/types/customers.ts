import { AuthenticationError, InvalidStateError, ValidationError } from "../../lib/errors.ts";
import { issueSession, revokeRefreshToken, rotateRefreshToken } from "../../modules/auth/service.ts";
import { assignCartToCustomer, findActiveCustomerCart } from "../../modules/carts/service.ts";
import {
  authenticateCustomer,
  changeCustomerPassword,
  createAddress,
  createCustomerAsStaff,
  createCustomerGroup,
  deleteAddress,
  deleteCustomer,
  deleteCustomerGroup,
  getCustomer,
  listCustomerGroups,
  listCustomers,
  registerCustomer,
  requestCustomerPasswordReset,
  resetCustomerPassword,
  revokeCustomerSessions,
  sendCustomerPasswordReset,
  updateAddress,
  updateCustomerAsStaff,
  updateCustomerGroup,
  updateCustomerProfile,
  type Customer,
} from "../../modules/customers/service.ts";
import { listOrders } from "../../modules/orders/read.ts";
import { hasPermission } from "../../modules/staff/service.ts";
import { ADMIN, BOTH, builder, connectionComplexity, rawId, STOREFRONT } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { keysetConnection } from "../pagination.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { AddressRef, CartRef, CustomerAddressRef, CustomerGroupRef, CustomerRef, OrderRef, SessionRef, TaxClassRef } from "../refs.ts";
import { AcceptedPayload, AddressInput, compact, DeletePayload } from "./common.ts";
import { OrderStatusEnum } from "./order-enums.ts";

const canSeeCustomer = (ctx: GraphQLContext, customer: Customer | null) =>
  !!customer && (ctx.api === "admin" ? hasPermission(ctx.permissions, "customers:read") : ctx.customer?.id === customer.id);

// Resolvers also return customers directly (e.g. Order.customer and mutation payloads), without
// going through the Relay loader. Storefront auth payloads retain their resolver authorization.
const customerReadScopes = (_customer: unknown, ctx: GraphQLContext) => ctx.api === "admin" ? { permission: "customers:read" } : true;

builder.node(CustomerRef, {
  authScopes: customerReadScopes,
  id: { resolve: (c) => c.id },
  loadMany: async (ids, ctx) => (await ctx.loaders.customer.loadMany(ids)).map((c) => (c instanceof Error || !canSeeCustomer(ctx, c) ? null : c)),
  fields: (t) => ({
    email: t.field({ type: "EmailAddress", resolve: (c) => c.email }),
    firstName: t.exposeString("firstName"),
    lastName: t.exposeString("lastName"),
    phone: t.exposeString("phone", { nullable: true }),
    dateOfBirth: t.exposeString("dateOfBirth", { nullable: true, description: "YYYY-MM-DD." }),
    acceptsMarketing: t.exposeBoolean("acceptsMarketing"),
    createdAt: t.field({ type: "DateTime", resolve: (c) => c.createdAt }),
    addresses: t.field({ type: [CustomerAddressRef], resolve: (c, _a, ctx) => ctx.loaders.customerAddresses.load(c.id) }),
    defaultShippingAddress: t.field({ type: CustomerAddressRef, nullable: true, resolve: async (c, _a, ctx) => (await ctx.loaders.customerAddresses.load(c.id)).find((a) => a.isDefaultShipping) ?? null }),
    defaultBillingAddress: t.field({ type: CustomerAddressRef, nullable: true, resolve: async (c, _a, ctx) => (await ctx.loaders.customerAddresses.load(c.id)).find((a) => a.isDefaultBilling) ?? null }),
    orders: t.connection({
      type: OrderRef,
      authScopes: (_c, _a, ctx) => ctx.api === "admin" ? { permission: "orders:read" } : true,
      description: "Newest first.",
      args: { status: t.arg({ type: OrderStatusEnum }) },
      complexity: connectionComplexity,
      resolve: (c, args, ctx) => keysetConnection(args, (page) => listOrders(ctx.db, { customerId: c.id, status: args.status ?? null }, page)),
    }),
    activeCart: t.field({
      type: CartRef,
      nullable: true,
      subGraphs: STOREFRONT,
      description: "The customer's open cart in the current channel.",
      resolve: async (c, _a, ctx) => (await findActiveCustomerCart(ctx.db, c.id, ctx.scope.channel.id)) ?? null,
    }),
    group: t.field({ type: CustomerGroupRef, subGraphs: ADMIN, resolve: async (c, _a, ctx) => (await ctx.loaders.customerGroup.load(c.groupId))! }),
    isActive: t.exposeBoolean("isActive", { subGraphs: ADMIN }),
    note: t.exposeString("note", { nullable: true, subGraphs: ADMIN }),
    lastLoginAt: t.field({ type: "DateTime", nullable: true, subGraphs: ADMIN, resolve: (c) => c.lastLoginAt }),
    emailVerifiedAt: t.field({ type: "DateTime", nullable: true, subGraphs: ADMIN, resolve: (c) => c.emailVerifiedAt }),
    metadata: t.field({ type: "JSON", subGraphs: ADMIN, resolve: (c) => c.metadata }),
    updatedAt: t.field({ type: "DateTime", subGraphs: ADMIN, resolve: (c) => c.updatedAt }),
  }),
});

builder.node(CustomerAddressRef, {
  authScopes: customerReadScopes,
  id: { resolve: (a) => a.id },
  loadMany: async (ids, ctx) => {
    if (ctx.api === "admin" && !hasPermission(ctx.permissions, "customers:read")) return ids.map(() => null);
    if (ctx.api === "storefront" && !ctx.customer) return ids.map(() => null);
    const rows = await ctx.db.query.customerAddresses.findMany({ where: (a, { inArray }) => inArray(a.id, ids) });
    return ids.map((id) => rows.find((r) => r.id === id && (ctx.api === "admin" || r.customerId === ctx.customer?.id)) ?? null);
  },
  fields: (t) => ({
    address: t.field({ type: AddressRef, resolve: (a) => a }),
    isDefaultShipping: t.exposeBoolean("isDefaultShipping"),
    isDefaultBilling: t.exposeBoolean("isDefaultBilling"),
  }),
});

builder.node(CustomerGroupRef, {
  subGraphs: ADMIN,
  id: { resolve: (g) => g.id },
  loadMany: async (ids, ctx) => (await ctx.loaders.customerGroup.loadMany(ids)).map((g) => (g instanceof Error ? null : g)),
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.exposeString("name"),
    taxClass: t.field({ type: TaxClassRef, nullable: true, resolve: (g, _a, ctx) => (g.taxClassId ? ctx.db.query.taxClasses.findFirst({ where: (x, { eq }) => eq(x.id, g.taxClassId!) }).then((x) => x ?? null) : null) }),
  }),
});

// ---------------------------------------------------------------- queries

builder.queryFields((t) => ({
  me: t.field({
    type: CustomerRef,
    nullable: true,
    subGraphs: STOREFRONT,
    description: "The signed-in customer, or null for anonymous requests.",
    resolve: (_r, _a, ctx) => ctx.customer,
  }),
  customers: t.connection({
    type: CustomerRef,
    subGraphs: ADMIN,
    authScopes: { permission: "customers:read" },
    args: { query: t.arg.string({ description: "Matches email or name." }), groupId: t.arg.globalID({ for: [CustomerGroupRef] }) },
    complexity: connectionComplexity,
    resolve: (_r, args, ctx) => keysetConnection(args, (page) => listCustomers(ctx.db, { query: args.query, groupId: args.groupId ? rawId(args.groupId) : null }, page)),
  }),
  customerGroups: t.field({ type: [CustomerGroupRef], subGraphs: ADMIN, authScopes: { permission: "customers:read" }, resolve: (_r, _a, ctx) => listCustomerGroups(ctx.db) }),
}));

// ---------------------------------------------------------------- payloads and inputs

const CustomerAuthPayload = builder.simpleObject("CustomerAuthPayload", {
  subGraphs: STOREFRONT,
  fields: (t) => ({
    customer: t.field({ type: CustomerRef }),
    session: t.field({ type: SessionRef }),
    cart: t.field({ type: CartRef, nullable: true, description: "Set when a guest cartId was passed: the merged customer cart." }),
  }),
});
const SessionPayload = builder.simpleObject("SessionPayload", { fields: (t) => ({ session: t.field({ type: SessionRef }) }) });
const CustomerPayload = builder.simpleObject("CustomerPayload", { fields: (t) => ({ customer: t.field({ type: CustomerRef }) }) });
const CustomerAddressPayload = builder.simpleObject("CustomerAddressPayload", {
  subGraphs: BOTH,
  fields: (t) => ({ address: t.field({ type: CustomerAddressRef }), customer: t.field({ type: CustomerRef }) }),
});
const CustomerGroupPayload = builder.simpleObject("CustomerGroupPayload", { subGraphs: ADMIN, fields: (t) => ({ customerGroup: t.field({ type: CustomerGroupRef }) }) });

const CustomerRegisterInput = builder.inputType("CustomerRegisterInput", {
  subGraphs: STOREFRONT,
  fields: (t) => ({
    email: t.field({ type: "EmailAddress", required: true }),
    password: t.string({ required: true }),
    firstName: t.string({ required: true }),
    lastName: t.string({ required: true }),
    phone: t.string(),
    dateOfBirth: t.string(),
    acceptsMarketing: t.boolean(),
  }),
});

const CustomerUpdateInput = builder.inputType("CustomerUpdateInput", {
  fields: (t) => ({
    firstName: t.string(),
    lastName: t.string(),
    phone: t.string(),
    dateOfBirth: t.string(),
    acceptsMarketing: t.boolean(),
    email: t.field({ type: "EmailAddress", subGraphs: ADMIN }),
    groupId: t.globalID({ for: [CustomerGroupRef], subGraphs: ADMIN }),
    note: t.string({ subGraphs: ADMIN }),
    isActive: t.boolean({ subGraphs: ADMIN }),
  }),
});

const CustomerCreateInput = builder.inputType("CustomerCreateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    email: t.field({ type: "EmailAddress", required: true }),
    firstName: t.string({ required: true }),
    lastName: t.string({ required: true }),
    password: t.string({ description: "Omit to let the customer set one via password reset." }),
    phone: t.string(),
    groupId: t.globalID({ for: [CustomerGroupRef] }),
    note: t.string(),
    acceptsMarketing: t.boolean(),
  }),
});

const CustomerAddressInput = builder.inputType("CustomerAddressInput", {
  subGraphs: BOTH,
  fields: (t) => ({
    address: t.field({ type: AddressInput, required: true }),
    isDefaultShipping: t.boolean(),
    isDefaultBilling: t.boolean(),
  }),
});


const signIn = async (ctx: GraphQLContext, customer: Customer, cartId: { id: string } | null | undefined) => {
  const { session } = await issueSession(ctx.db, ctx.platform.config, "customer", customer.id);
  const cart = cartId ? await assignCartToCustomer(ctx.db, rawId(cartId), customer.id) : null;
  return { customer, session, cart };
};

const requireCustomer = (ctx: GraphQLContext) => {
  if (!ctx.customer) throw new AuthenticationError();
  return ctx.customer;
};

/** Storefront callers manage their own addresses; admin callers name the customer. */
const addressScopes = (_r: unknown, _a: unknown, ctx: GraphQLContext) => (ctx.api === "admin" ? { permission: "customers:write" } : { customer: true });
const addressOwner = async (ctx: GraphQLContext, customerId: { id: string } | null | undefined) => {
  if (ctx.api !== "admin") return requireCustomer(ctx);
  if (!customerId) throw new ValidationError("customerId is required", [{ path: ["customerId"], message: "Required in the admin API" }]);
  return getCustomer(ctx.db, rawId(customerId));
};

// ---------------------------------------------------------------- mutations

builder.mutationFields((t) => ({
  customerRegister: t.field({
    type: CustomerAuthPayload,
    subGraphs: STOREFRONT,
    description: "Create an account and sign in. Pass a guest cartId to keep the cart.",
    errors: {},
    args: { input: t.arg({ type: CustomerRegisterInput, required: true }), cartId: t.arg.globalID({ for: [CartRef] }) },
    resolve: async (_r, { input, cartId }, ctx) => signIn(ctx, await registerCustomer(ctx.db, compact(input)), cartId),
  }),
  customerLogin: t.field({
    type: CustomerAuthPayload,
    subGraphs: STOREFRONT,
    description: "Sign in. A guest cartId is merged into the customer's open cart.",
    errors: {},
    args: { email: t.arg({ type: "EmailAddress", required: true }), password: t.arg.string({ required: true }), cartId: t.arg.globalID({ for: [CartRef] }) },
    resolve: async (_r, args, ctx) => signIn(ctx, await authenticateCustomer(ctx.db, args.email, args.password), args.cartId),
  }),
  tokenRefresh: t.field({
    type: SessionPayload,
    subGraphs: BOTH,
    description: "Exchange a refresh token for a new session. Refresh tokens are single use; replaying one revokes the whole session family.",
    errors: {},
    args: { refreshToken: t.arg.string({ required: true }) },
    resolve: async (_r, { refreshToken }, ctx) => ({
      session: (await rotateRefreshToken(ctx.db, ctx.platform.config, refreshToken, ctx.api === "admin" ? "staff" : "customer")).session,
    }),
  }),
  logout: t.field({
    type: AcceptedPayload,
    subGraphs: BOTH,
    description: "Revoke the refresh token and every token rotated from it.",
    errors: {},
    args: { refreshToken: t.arg.string({ required: true }) },
    resolve: async (_r, { refreshToken }, ctx) => ({ accepted: await revokeRefreshToken(ctx.db, refreshToken) }),
  }),
  customerPasswordResetRequest: t.field({
    type: AcceptedPayload,
    subGraphs: STOREFRONT,
    description: "Always accepted, never revealing whether the account exists. Emits customer.password_reset_requested to plugins (the email plugin sends the link), not webhooks.",
    errors: {},
    args: { email: t.arg({ type: "EmailAddress", required: true }) },
    resolve: async (_r, { email }, ctx) => {
      await requestCustomerPasswordReset(ctx.db, ctx.platform.config, email, { channelId: ctx.scope.channel.id });
      return { accepted: true };
    },
  }),
  customerPasswordReset: t.field({
    type: CustomerPayload,
    subGraphs: STOREFRONT,
    description: "Set a new password with a reset token. Signs the customer out everywhere.",
    errors: {},
    args: { token: t.arg.string({ required: true }), newPassword: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => ({ customer: await resetCustomerPassword(ctx.db, args.token, args.newPassword) }),
  }),
  customerPasswordChange: t.field({
    type: CustomerPayload,
    subGraphs: STOREFRONT,
    authScopes: { customer: true },
    errors: {},
    args: { currentPassword: t.arg.string({ required: true }), newPassword: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => ({ customer: await changeCustomerPassword(ctx.db, requireCustomer(ctx).id, args.currentPassword, args.newPassword) }),
  }),
  customerUpdate: t.field({
    type: CustomerPayload,
    description: "Storefront: update the signed-in customer. Admin: update any customer by id.",
    authScopes: (_r, _a, ctx) => (ctx.api === "admin" ? { permission: "customers:write" } : { customer: true }),
    errors: {},
    args: { id: t.arg.globalID({ for: [CustomerRef], subGraphs: ADMIN }), input: t.arg({ type: CustomerUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      if (ctx.api === "admin") {
        if (!id) throw new ValidationError("id is required", [{ path: ["id"], message: "Required in the admin API" }]);
        const { groupId, ...rest } = input;
        // An explicit null clears the optional fields; for required ones it means "unchanged".
        const clearable = Object.fromEntries((["phone", "dateOfBirth", "note"] as const).filter((k) => rest[k] === null).map((k) => [k, null]));
        return { customer: await updateCustomerAsStaff(ctx.db, rawId(id), { ...compact({ ...rest, groupId: groupId ? rawId(groupId) : undefined }), ...clearable }) };
      }
      const { firstName, lastName, phone, dateOfBirth, acceptsMarketing } = input;
      return { customer: await updateCustomerProfile(ctx.db, requireCustomer(ctx).id, compact({ firstName, lastName, phone, dateOfBirth, acceptsMarketing })) };
    },
  }),
  customerAddressCreate: t.field({
    type: CustomerAddressPayload,
    subGraphs: BOTH,
    description: "Storefront: the signed-in customer's address book. Admin: any customer's, by customerId.",
    authScopes: addressScopes,
    errors: {},
    args: { customerId: t.arg.globalID({ for: [CustomerRef], subGraphs: ADMIN }), input: t.arg({ type: CustomerAddressInput, required: true }) },
    resolve: async (_r, { customerId, input }, ctx) => {
      const customer = await addressOwner(ctx, customerId);
      return { address: await createAddress(ctx.db, customer.id, { ...input.address, isDefaultShipping: input.isDefaultShipping ?? undefined, isDefaultBilling: input.isDefaultBilling ?? undefined }), customer };
    },
  }),
  customerAddressUpdate: t.field({
    type: CustomerAddressPayload,
    subGraphs: BOTH,
    authScopes: addressScopes,
    errors: {},
    args: { customerId: t.arg.globalID({ for: [CustomerRef], subGraphs: ADMIN }), id: t.arg.globalID({ for: [CustomerAddressRef], required: true }), input: t.arg({ type: CustomerAddressInput, required: true }) },
    resolve: async (_r, { customerId, id, input }, ctx) => {
      const customer = await addressOwner(ctx, customerId);
      return { address: await updateAddress(ctx.db, customer.id, rawId(id), { ...input.address, isDefaultShipping: input.isDefaultShipping ?? undefined, isDefaultBilling: input.isDefaultBilling ?? undefined }), customer };
    },
  }),
  customerAddressDelete: t.field({
    type: DeletePayload,
    subGraphs: BOTH,
    authScopes: addressScopes,
    errors: {},
    args: { customerId: t.arg.globalID({ for: [CustomerRef], subGraphs: ADMIN }), id: t.arg.globalID({ for: [CustomerAddressRef], required: true }) },
    resolve: async (_r, { customerId, id }, ctx) => ({ deletedId: toGlobalId("CustomerAddress", await deleteAddress(ctx.db, (await addressOwner(ctx, customerId)).id, rawId(id))) }),
  }),
  customerDelete: t.field({
    type: DeletePayload,
    subGraphs: ADMIN,
    description: "Delete the account. Its orders are kept, detached from it; carts and sessions are removed.",
    authScopes: { permission: "customers:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [CustomerRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Customer", await deleteCustomer(ctx.db, rawId(id))) }),
  }),
  customerPasswordResetSend: t.field({
    type: CustomerPayload,
    subGraphs: ADMIN,
    description: "Email the customer a reset link (emits customer.password_reset_requested, which only plugins receive).",
    authScopes: { permission: "customers:write" },
    errors: { types: [InvalidStateError] },
    args: { id: t.arg.globalID({ for: [CustomerRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ customer: await sendCustomerPasswordReset(ctx.db, ctx.platform.config, rawId(id)) }),
  }),
  customerSessionsRevoke: t.field({
    type: CustomerPayload,
    subGraphs: ADMIN,
    description: "Sign the customer out on every device.",
    authScopes: { permission: "customers:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [CustomerRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ customer: await revokeCustomerSessions(ctx.db, rawId(id)) }),
  }),
  customerGroupUpdate: t.field({
    type: CustomerGroupPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "customers:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [CustomerGroupRef], required: true }), name: t.arg.string(), taxClassId: t.arg.globalID({ for: [TaxClassRef] }) },
    resolve: async (_r, args, ctx) => ({
      customerGroup: await updateCustomerGroup(ctx.db, rawId(args.id), { name: args.name ?? undefined, taxClassId: args.taxClassId === undefined ? undefined : args.taxClassId ? rawId(args.taxClassId) : null }),
    }),
  }),
  customerGroupDelete: t.field({
    type: DeletePayload,
    subGraphs: ADMIN,
    description: "Members move to the default group; the group's prices are deleted.",
    authScopes: { permission: "customers:write" },
    errors: { types: [InvalidStateError] },
    args: { id: t.arg.globalID({ for: [CustomerGroupRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("CustomerGroup", await deleteCustomerGroup(ctx.db, rawId(id))) }),
  }),
  customerCreate: t.field({
    type: CustomerPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "customers:write" },
    errors: {},
    args: { input: t.arg({ type: CustomerCreateInput, required: true }) },
    resolve: async (_r, { input }, ctx) => {
      const { groupId, ...rest } = input;
      return { customer: await createCustomerAsStaff(ctx.db, compact({ ...rest, groupId: groupId ? rawId(groupId) : undefined })) };
    },
  }),
  customerGroupCreate: t.field({
    type: CustomerGroupPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "customers:write" },
    errors: {},
    args: { code: t.arg.string({ required: true }), name: t.arg.string({ required: true }), taxClassId: t.arg.globalID({ for: [TaxClassRef] }) },
    resolve: async (_r, args, ctx) => ({ customerGroup: await createCustomerGroup(ctx.db, { code: args.code, name: args.name, taxClassId: args.taxClassId ? rawId(args.taxClassId) : null }) }),
  }),
}));
