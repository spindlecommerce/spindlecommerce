import { createApiKey, listApiKeys, revokeApiKey } from "../../modules/auth/service.ts";
import { InvalidStateError, NotFoundError, PermissionDeniedError } from "../../lib/errors.ts";
import {
  beginStaffSignIn,
  beginTwoFactorSetup,
  changeStaffPassword,
  completeStaffSignIn,
  createRole,
  createStaffUser,
  deleteRole,
  disableTwoFactor,
  enableTwoFactor,
  getStaffPermissions,
  getStaffPreferences,
  getStaffRoles,
  grantablePermissions,
  hasPermission,
  hasTwoFactor,
  isGrantablePermission,
  isLocked,
  listRoles,
  listStaffUsers,
  PERMISSION_AREAS,
  requestStaffPasswordReset,
  resetStaffPassword,
  resetTwoFactor,
  setStaffPassword,
  setStaffPreference,
  unlockStaffUser,
  updateRole,
  updateStaffProfile,
  updateStaffUser,
  type StaffSignIn,
} from "../../modules/staff/service.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";
import { ApiKeyRef, RoleRef, SessionRef, StaffUserRef } from "../refs.ts";
import { AcceptedPayload, DeletePayload } from "./common.ts";

builder.node(StaffUserRef, {
  subGraphs: ADMIN,
  id: { resolve: (u) => u.id },
  loadMany: async (ids, ctx) => {
    const rows = await listStaffUsers(ctx.db);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    email: t.field({ type: "EmailAddress", resolve: (u) => u.email }),
    name: t.exposeString("name"),
    isActive: t.exposeBoolean("isActive"),
    roles: t.field({ type: [RoleRef], resolve: (u, _a, ctx) => getStaffRoles(ctx.db, u.id) }),
    lastLoginAt: t.field({ type: "DateTime", nullable: true, resolve: (u) => u.lastLoginAt }),
    passwordChangedAt: t.field({ type: "DateTime", nullable: true, resolve: (u) => u.passwordChangedAt }),
    lockedUntil: t.field({
      type: "DateTime",
      nullable: true,
      description: "Set after repeated failed sign-ins; cleared by staffUserUnlock or when it passes.",
      resolve: (u) => (isLocked(u) ? u.lockedUntil : null),
    }),
    twoFactorEnabled: t.boolean({ resolve: (u) => hasTwoFactor(u) }),
    recoveryCodesRemaining: t.int({ nullable: true, resolve: (u) => (hasTwoFactor(u) ? u.recoveryCodeHashes.length : null) }),
    createdAt: t.field({ type: "DateTime", resolve: (u) => u.createdAt }),
  }),
});

builder.node(RoleRef, {
  subGraphs: ADMIN,
  id: { resolve: (r) => r.id },
  loadMany: async (ids, ctx) => {
    const rows = await listRoles(ctx.db);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({ code: t.exposeString("code"), name: t.exposeString("name"), permissions: t.exposeStringList("permissions") }),
});

builder.node(ApiKeyRef, {
  subGraphs: ADMIN,
  id: { resolve: (k) => k.id },
  loadMany: async (ids, ctx) => {
    const rows = await listApiKeys(ctx.db);
    return ids.map((id) => rows.find((r) => r.id === id) ?? null);
  },
  fields: (t) => ({
    name: t.exposeString("name"),
    prefix: t.exposeString("prefix", { description: "Identifies the key in logs; the secret is never shown again." }),
    permissions: t.exposeStringList("permissions"),
    lastUsedAt: t.field({ type: "DateTime", nullable: true, resolve: (k) => k.lastUsedAt }),
    expiresAt: t.field({ type: "DateTime", nullable: true, resolve: (k) => k.expiresAt }),
    revokedAt: t.field({ type: "DateTime", nullable: true, resolve: (k) => k.revokedAt }),
    createdAt: t.field({ type: "DateTime", resolve: (k) => k.createdAt }),
  }),
});

const StaffPreferenceRef = builder.objectRef<{ key: string; value: unknown; updatedAt: Date }>("StaffPreference").implement({
  subGraphs: ADMIN,
  description: "A per-user admin setting such as a saved grid view.",
  fields: (t) => ({
    key: t.exposeString("key"),
    value: t.field({ type: "JSON", nullable: true, resolve: (p) => p.value }),
    updatedAt: t.field({ type: "DateTime", resolve: (p) => p.updatedAt }),
  }),
});

const ViewerRef = builder.objectRef<{ ok: true }>("Viewer").implement({
  subGraphs: ADMIN,
  description: "Who is calling the admin API.",
  fields: (t) => ({
    staffUser: t.field({ type: StaffUserRef, nullable: true, resolve: (_v, _a, ctx) => ctx.staff }),
    apiKey: t.field({ type: ApiKeyRef, nullable: true, resolve: (_v, _a, ctx) => ctx.apiKey }),
    permissions: t.stringList({ resolve: (_v, _a, ctx) => [...ctx.permissions].sort() }),
    preferences: t.field({
      type: [StaffPreferenceRef],
      description: "The signed-in staff user's preferences, all or by key.",
      args: { keys: t.arg.stringList() },
      resolve: (_v, { keys }, ctx) => (ctx.staff ? getStaffPreferences(ctx.db, ctx.staff.id, keys) : []),
    }),
  }),
});

const PERMISSION_AREA_INFO: Record<(typeof PERMISSION_AREAS)[number], { name: string; description: string }> = {
  catalog: { name: "Catalog", description: "Products, variants, prices, categories, attributes, product types, media and redirects" },
  inventory: { name: "Inventory", description: "Stock levels, stock locations and stocks" },
  orders: { name: "Orders", description: "Orders, payments, fulfillment, refunds, cancellations and admin-created orders" },
  customers: { name: "Customers", description: "Customer accounts, addresses and customer groups" },
  promotions: { name: "Promotions", description: "Cart promotions and coupons" },
  reports: { name: "Reports", description: "Dashboard figures and sales, product, customer and promotion reports" },
  settings: { name: "Settings", description: "Channels, currencies, tax, shipping and payment methods" },
  content: { name: "Content", description: "Pages, templates, components and releases in the page builder" },
  staff: { name: "Staff", description: "Staff users, roles and the audit log" },
  integrations: { name: "Integrations", description: "API keys and webhooks" },
};

const PermissionAreaRef = builder.objectRef<{ code: (typeof PERMISSION_AREAS)[number] }>("PermissionArea").implement({
  subGraphs: ADMIN,
  description: "A group of permissions: `<code>:read` and `<code>:write` (which implies read).",
  fields: (t) => ({
    code: t.exposeString("code"),
    name: t.string({ resolve: (a) => PERMISSION_AREA_INFO[a.code].name }),
    description: t.string({ resolve: (a) => PERMISSION_AREA_INFO[a.code].description }),
  }),
});

const requireStaff = (ctx: GraphQLContext) => {
  if (!ctx.staff) throw new InvalidStateError("Only staff users have an account; API keys do not");
  return ctx.staff;
};

/**
 * staff:write stops at the caller's own permissions: it grants none they lack and changes no role or
 * user holding one, so it can neither gain `*` nor take over an administrator.
 */
const requireHeld = (ctx: GraphQLContext, permissions: Iterable<string>) => {
  for (const permission of permissions) if (!hasPermission(ctx.permissions, permission)) throw new PermissionDeniedError(permission);
};
const rolePermissions = async (ctx: GraphQLContext, roleIds: readonly string[]) => (await listRoles(ctx.db)).filter((r) => roleIds.includes(r.id)).flatMap((r) => r.permissions);
const requireManageable = async (ctx: GraphQLContext, staffUserId: string) => requireHeld(ctx, await getStaffPermissions(ctx.db, staffUserId));

builder.queryFields((t) => ({
  viewer: t.field({ type: ViewerRef, subGraphs: ADMIN, authScopes: { staff: true }, resolve: () => ({ ok: true as const }) }),
  staffUsers: t.field({ type: [StaffUserRef], subGraphs: ADMIN, authScopes: { permission: "staff:read" }, resolve: (_r, _a, ctx) => listStaffUsers(ctx.db) }),
  roles: t.field({ type: [RoleRef], subGraphs: ADMIN, authScopes: { permission: "staff:read" }, resolve: (_r, _a, ctx) => listRoles(ctx.db) }),
  permissions: t.stringList({
    subGraphs: ADMIN,
    description: "Every grantable permission, the installed plugins' included (see pluginPermissions); write implies read.",
    authScopes: { staff: true },
    resolve: () => grantablePermissions(),
  }),
  permissionAreas: t.field({ type: [PermissionAreaRef], subGraphs: ADMIN, authScopes: { staff: true }, resolve: () => PERMISSION_AREAS.map((code) => ({ code })) }),
  apiKeys: t.field({ type: [ApiKeyRef], subGraphs: ADMIN, authScopes: { permission: "integrations:read" }, resolve: (_r, _a, ctx) => listApiKeys(ctx.db) }),
}));

const TwoFactorChallengeRef = builder.objectRef<{ token: string; expiresAt: Date }>("StaffTwoFactorChallenge").implement({
  subGraphs: ADMIN,
  description: "Pass `token` with a code from the authenticator app (or a recovery code) to staffLoginVerify.",
  fields: (t) => ({ token: t.exposeString("token"), expiresAt: t.field({ type: "DateTime", resolve: (c) => c.expiresAt }) }),
});

const StaffAuthPayload = builder.objectRef<StaffSignIn>("StaffAuthPayload").implement({
  subGraphs: ADMIN,
  description: "Either a session, or a two-factor challenge to complete with staffLoginVerify.",
  fields: (t) => ({
    staffUser: t.field({ type: StaffUserRef, resolve: (p) => p.staffUser }),
    session: t.field({ type: SessionRef, nullable: true, resolve: (p) => (p.kind === "session" ? p.session : null) }),
    twoFactorChallenge: t.field({ type: TwoFactorChallengeRef, nullable: true, resolve: (p) => (p.kind === "challenge" ? { token: p.challengeToken, expiresAt: p.expiresAt } : null) }),
  }),
});
const StaffUserPayload = builder.simpleObject("StaffUserPayload", { subGraphs: ADMIN, fields: (t) => ({ staffUser: t.field({ type: StaffUserRef }) }) });
const RolePayload = builder.simpleObject("RolePayload", { subGraphs: ADMIN, fields: (t) => ({ role: t.field({ type: RoleRef }) }) });
const ApiKeyPayload = builder.simpleObject("ApiKeyPayload", { subGraphs: ADMIN, fields: (t) => ({ apiKey: t.field({ type: ApiKeyRef }) }) });
const ApiKeyCreatePayload = builder.simpleObject("ApiKeyCreatePayload", {
  subGraphs: ADMIN,
  fields: (t) => ({ apiKey: t.field({ type: ApiKeyRef }), secret: t.string({ description: "Shown once. Send as `Authorization: Bearer <secret>`." }) }),
});
const StaffSessionPayload = builder.simpleObject("StaffSessionPayload", {
  subGraphs: ADMIN,
  description: "Every other session was signed out; continue with this one.",
  fields: (t) => ({ session: t.field({ type: SessionRef }) }),
});
const TwoFactorSetupPayload = builder.simpleObject("StaffTwoFactorSetupPayload", {
  subGraphs: ADMIN,
  fields: (t) => ({
    secret: t.string({ description: "Base32 seed for manual entry." }),
    uri: t.string({ description: "otpauth:// URI to render as a QR code." }),
  }),
});
const TwoFactorEnablePayload = builder.simpleObject("StaffTwoFactorEnablePayload", {
  subGraphs: ADMIN,
  fields: (t) => ({
    staffUser: t.field({ type: StaffUserRef }),
    recoveryCodes: t.stringList({ description: "Single-use codes for a lost device. Shown once." }),
  }),
});
const StaffPreferencePayload = builder.simpleObject("StaffPreferencePayload", { subGraphs: ADMIN, fields: (t) => ({ preference: t.field({ type: StaffPreferenceRef }) }) });

const StaffUserInput = builder.inputType("StaffUserInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ email: t.field({ type: "EmailAddress", required: true }), name: t.string({ required: true }), password: t.string({ required: true }), roleIds: t.globalIDList({ for: [RoleRef], required: true }) }),
});
const StaffUserUpdateInput = builder.inputType("StaffUserUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ name: t.string(), isActive: t.boolean(), roleIds: t.globalIDList({ for: [RoleRef] }) }),
});

builder.mutationFields((t) => ({
  staffLogin: t.field({
    type: StaffAuthPayload,
    subGraphs: ADMIN,
    description: "First sign-in step. Accounts lock for a while after repeated failures.",
    errors: {},
    args: { email: t.arg({ type: "EmailAddress", required: true }), password: t.arg.string({ required: true }) },
    resolve: (_r, args, ctx) => beginStaffSignIn(ctx.db, ctx.platform.config, args.email, args.password),
  }),
  staffLoginVerify: t.field({
    type: StaffAuthPayload,
    subGraphs: ADMIN,
    description: "Second sign-in step: a 6-digit authenticator code or an unused recovery code.",
    errors: {},
    args: { challengeToken: t.arg.string({ required: true }), code: t.arg.string({ required: true }) },
    resolve: (_r, args, ctx) => completeStaffSignIn(ctx.db, ctx.platform.config, args.challengeToken, args.code),
  }),
  staffPasswordResetRequest: t.field({
    type: AcceptedPayload,
    subGraphs: ADMIN,
    description: "Always accepted, never revealing whether the account exists. Emits staff.password_reset_requested to plugins (the email plugin sends the link), not webhooks.",
    errors: {},
    args: { email: t.arg({ type: "EmailAddress", required: true }) },
    resolve: async (_r, { email }, ctx) => {
      const url = await requestStaffPasswordReset(ctx.db, ctx.platform.config, email);
      if (url && process.env.NODE_ENV !== "production") ctx.platform.logger.info({ email, url }, "staff password reset link (development only)");
      return { accepted: true };
    },
  }),
  staffPasswordReset: t.field({
    type: AcceptedPayload,
    subGraphs: ADMIN,
    errors: {},
    args: { token: t.arg.string({ required: true }), password: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => {
      await resetStaffPassword(ctx.db, args.token, args.password);
      return { accepted: true };
    },
  }),
  staffProfileUpdate: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    description: "Update your own profile.",
    authScopes: { staff: true },
    errors: { types: [InvalidStateError] },
    args: { name: t.arg.string({ required: true }) },
    resolve: async (_r, { name }, ctx) => ({ staffUser: await updateStaffProfile(ctx.db, requireStaff(ctx).id, { name }) }),
  }),
  staffPasswordChange: t.field({
    type: StaffSessionPayload,
    subGraphs: ADMIN,
    description: "Change your own password. Signs out every session and returns a new one.",
    authScopes: { staff: true },
    errors: { types: [InvalidStateError] },
    args: { currentPassword: t.arg.string({ required: true }), newPassword: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => ({ session: await changeStaffPassword(ctx.db, ctx.platform.config, requireStaff(ctx).id, args.currentPassword, args.newPassword) }),
  }),
  staffTwoFactorSetup: t.field({
    type: TwoFactorSetupPayload,
    subGraphs: ADMIN,
    description: "Start enrolling an authenticator app; confirm with staffTwoFactorEnable.",
    authScopes: { staff: true },
    errors: { types: [InvalidStateError] },
    resolve: (_r, _a, ctx) => beginTwoFactorSetup(ctx.db, ctx.platform.config, requireStaff(ctx).id),
  }),
  staffTwoFactorEnable: t.field({
    type: TwoFactorEnablePayload,
    subGraphs: ADMIN,
    authScopes: { staff: true },
    errors: { types: [InvalidStateError] },
    args: { code: t.arg.string({ required: true }) },
    resolve: (_r, { code }, ctx) => enableTwoFactor(ctx.db, ctx.platform.config, requireStaff(ctx).id, code),
  }),
  staffTwoFactorDisable: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    authScopes: { staff: true },
    errors: { types: [InvalidStateError] },
    args: { password: t.arg.string({ required: true }) },
    resolve: async (_r, { password }, ctx) => ({ staffUser: await disableTwoFactor(ctx.db, requireStaff(ctx).id, password) }),
  }),
  staffPreferenceSet: t.field({
    type: StaffPreferencePayload,
    subGraphs: ADMIN,
    description: "Save one of your preferences; null removes it.",
    authScopes: { staff: true },
    errors: { types: [InvalidStateError] },
    args: { key: t.arg.string({ required: true }), value: t.arg({ type: "JSON" }) },
    resolve: async (_r, { key, value }, ctx) => ({ preference: await setStaffPreference(ctx.db, requireStaff(ctx).id, key, value ?? null) }),
  }),
  staffUserCreate: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    description: "Only with roles whose permissions you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { input: t.arg({ type: StaffUserInput, required: true }) },
    resolve: async (_r, { input }, ctx) => {
      const roleIds = input.roleIds.map(rawId);
      requireHeld(ctx, await rolePermissions(ctx, roleIds));
      return { staffUser: await createStaffUser(ctx.db, { ...input, roleIds }) };
    },
  }),
  staffUserUpdate: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    description: "Deactivating a user also signs them out everywhere. Only for staff, and with roles, whose permissions you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [StaffUserRef], required: true }), input: t.arg({ type: StaffUserUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      const roleIds = input.roleIds?.map(rawId);
      await requireManageable(ctx, rawId(id));
      if (roleIds) requireHeld(ctx, await rolePermissions(ctx, roleIds));
      return { staffUser: await updateStaffUser(ctx.db, rawId(id), { name: input.name ?? undefined, isActive: input.isActive ?? undefined, roleIds }) };
    },
  }),
  staffUserUnlock: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    description: "Clear a lockout after failed sign-ins. Only for staff whose permissions you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [StaffUserRef], required: true }) },
    resolve: async (_r, { id }, ctx) => {
      await requireManageable(ctx, rawId(id));
      return { staffUser: await unlockStaffUser(ctx.db, rawId(id)) };
    },
  }),
  staffUserSetPassword: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    description: "Set someone else's password; signs them out everywhere. Only for staff whose permissions you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [StaffUserRef], required: true }), password: t.arg.string({ required: true }) },
    resolve: async (_r, { id, password }, ctx) => {
      await requireManageable(ctx, rawId(id));
      return { staffUser: await setStaffPassword(ctx.db, rawId(id), password) };
    },
  }),
  staffUserResetTwoFactor: t.field({
    type: StaffUserPayload,
    subGraphs: ADMIN,
    description: "Remove someone's second factor (lost device) and sign them out everywhere. Only for staff whose permissions you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [StaffUserRef], required: true }) },
    resolve: async (_r, { id }, ctx) => {
      await requireManageable(ctx, rawId(id));
      return { staffUser: await resetTwoFactor(ctx.db, rawId(id)) };
    },
  }),
  roleCreate: t.field({
    type: RolePayload,
    subGraphs: ADMIN,
    description: "Only with permissions you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { code: t.arg.string({ required: true }), name: t.arg.string({ required: true }), permissions: t.arg.stringList({ required: true }) },
    resolve: async (_r, args, ctx) => {
      requireHeld(ctx, args.permissions);
      return { role: await createRole(ctx.db, args) };
    },
  }),
  roleUpdate: t.field({
    type: RolePayload,
    subGraphs: ADMIN,
    description: "Only for roles whose permissions, before and after the change, you hold yourself.",
    authScopes: { permission: "staff:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [RoleRef], required: true }), name: t.arg.string(), permissions: t.arg.stringList() },
    resolve: async (_r, { id, name, permissions }, ctx) => {
      requireHeld(ctx, [...(await rolePermissions(ctx, [rawId(id)])), ...(permissions ?? [])]);
      return { role: await updateRole(ctx.db, rawId(id), { name: name ?? undefined, permissions: permissions ?? undefined }) };
    },
  }),
  roleDelete: t.field({
    type: DeletePayload,
    subGraphs: ADMIN,
    description: "Fails while the role is assigned to anyone.",
    authScopes: { permission: "staff:write" },
    errors: { types: [InvalidStateError] },
    args: { id: t.arg.globalID({ for: [RoleRef], required: true }) },
    resolve: async (_r, { id }, ctx) => ({ deletedId: toGlobalId("Role", await deleteRole(ctx.db, rawId(id))) }),
  }),
  apiKeyCreate: t.field({
    type: ApiKeyCreatePayload,
    subGraphs: ADMIN,
    description: "Least-privilege credential for integrations (ERP, PIM, fulfillment). Staff users only, with permissions they hold themselves.",
    authScopes: { permission: "integrations:write" },
    errors: { types: [InvalidStateError, PermissionDeniedError] },
    args: { name: t.arg.string({ required: true }), permissions: t.arg.stringList({ required: true }), expiresAt: t.arg({ type: "DateTime" }) },
    resolve: async (_r, args, ctx) => {
      const staff = requireStaff(ctx);
      for (const permission of args.permissions) {
        if (!isGrantablePermission(permission) || !hasPermission(ctx.permissions, permission)) throw new PermissionDeniedError(permission);
      }
      const { apiKey, plaintext } = await createApiKey(ctx.db, { name: args.name, permissions: args.permissions, expiresAt: args.expiresAt, createdByStaffId: staff.id });
      return { apiKey, secret: plaintext };
    },
  }),
  apiKeyRevoke: t.field({
    type: ApiKeyPayload,
    subGraphs: ADMIN,
    authScopes: { permission: "integrations:write" },
    errors: {},
    args: { id: t.arg.globalID({ for: [ApiKeyRef], required: true }) },
    resolve: async (_r, { id }, ctx) => {
      const apiKey = await revokeApiKey(ctx.db, rawId(id));
      if (!apiKey) throw new NotFoundError("ApiKey", id.id);
      return { apiKey };
    },
  }),
}));
