import { and, arrayContains, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../../config.ts";
import type { Database } from "../../db/client.ts";
import { deriveKey, openSecret, randomToken, sealSecret, sha256 } from "../../lib/crypto.ts";
import { AuthenticationError, InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../../lib/totp.ts";
import { parseInput } from "../../lib/validation.ts";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  hashPassword,
  issueSession,
  revokeAllSessions,
  signPurposeToken,
  verifyPassword,
  verifyPurposeToken,
  type Session,
} from "../auth/service.ts";
import { emit } from "../integrations/outbox.ts";
import { roles, staffPreferences, staffUserRoles, staffUsers } from "./tables.ts";

export type StaffUser = typeof staffUsers.$inferSelect;
export type Role = typeof roles.$inferSelect;

export const PERMISSION_AREAS = ["catalog", "inventory", "orders", "customers", "promotions", "reports", "settings", "content", "staff", "integrations"] as const;
export const PERMISSIONS = ["*", ...PERMISSION_AREAS.flatMap((area) => [`${area}:read`, `${area}:write`])];

export type PluginPermission = { code: string; description: string; plugin: string; pluginTitle: string };

/** Plugins' permissions, registered when a platform is created. Process-wide. */
const pluginPermissions = new Map<string, PluginPermission>();

export const registerPluginPermissions = (permissions: Iterable<PluginPermission>) => {
  for (const permission of permissions) pluginPermissions.set(permission.code, permission);
};

export const listPluginPermissions = (): PluginPermission[] => [...pluginPermissions.values()];

export const grantablePermissions = (): string[] => [...PERMISSIONS, ...pluginPermissions.keys()];

export const isGrantablePermission = (code: string): boolean => PERMISSIONS.includes(code) || pluginPermissions.has(code);

/** `area:write` implies `area:read`; `*` implies everything. */
export const hasPermission = (granted: ReadonlySet<string>, required: string): boolean => {
  if (granted.has("*") || granted.has(required)) return true;
  const [area, level] = required.split(":");
  return level === "read" && granted.has(`${area}:write`);
};

const permissionList = z.array(z.string().refine(isGrantablePermission, "Unknown permission"));
const password = z.string().min(12, "Use at least 12 characters").max(256);

export const createRole = async (db: Database, input: unknown) => {
  const data = parseInput(z.object({ code: z.string().regex(/^[a-z0-9_-]{1,40}$/), name: z.string().min(1), permissions: permissionList }), input);
  const [row] = await db.insert(roles).values(data).returning();
  return row!;
};

export const updateRole = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(z.object({ name: z.string().min(1).optional(), permissions: permissionList.optional() }), input);
  const [row] = await db.update(roles).set(data).where(eq(roles.id, id)).returning();
  if (!row) throw new NotFoundError("Role", id);
  return row;
};

export const deleteRole = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const role = await tx.query.roles.findFirst({ where: eq(roles.id, id) });
    if (!role) throw new NotFoundError("Role", id);
    const [{ count }] = (await tx.select({ count: sql<number>`count(*)::int` }).from(staffUserRoles).where(eq(staffUserRoles.roleId, id))) as [{ count: number }];
    if (count > 0) throw new InvalidStateError(`Role ${role.code} is assigned to ${count} staff user(s)`);
    await tx.delete(roles).where(eq(roles.id, id));
    return id;
  });

export const listRoles = (db: Database) => db.query.roles.findMany({ orderBy: roles.code });

const staffSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  password,
  name: z.string().min(1).max(200),
  roleIds: z.array(z.uuid()).min(1),
});

export const createStaffUser = async (db: Database, input: unknown) =>
  db.transaction(async (tx) => {
    const data = parseInput(staffSchema, input);
    if (await tx.query.staffUsers.findFirst({ where: eq(staffUsers.email, data.email) })) {
      throw new ValidationError("Email already in use", [{ path: ["input", "email"], message: "A staff user with this email exists" }]);
    }
    const [user] = await tx.insert(staffUsers).values({ email: data.email, name: data.name, passwordHash: await hashPassword(data.password), passwordChangedAt: new Date() }).returning();
    await tx.insert(staffUserRoles).values(data.roleIds.map((roleId) => ({ staffUserId: user!.id, roleId })));
    return user!;
  });

export const updateStaffUser = async (db: Database, id: string, input: unknown) =>
  db.transaction(async (tx) => {
    const data = parseInput(staffSchema.omit({ password: true, email: true }).partial().extend({ isActive: z.boolean().optional() }), input);
    const [user] = await tx.update(staffUsers).set({ name: data.name, isActive: data.isActive, updatedAt: new Date() }).where(eq(staffUsers.id, id)).returning();
    if (!user) throw new NotFoundError("StaffUser", id);
    if (data.roleIds) {
      await tx.delete(staffUserRoles).where(eq(staffUserRoles.staffUserId, id));
      await tx.insert(staffUserRoles).values(data.roleIds.map((roleId) => ({ staffUserId: id, roleId })));
    }
    if (data.isActive === false) await revokeAllSessions(tx, "staff", id);
    return user;
  });

export const listStaffUsers = (db: Database) => db.query.staffUsers.findMany({ orderBy: staffUsers.email });

export const getStaffUser = (db: Database, id: string) => db.query.staffUsers.findFirst({ where: eq(staffUsers.id, id) });

const requireStaffUser = async (db: Database, id: string) => {
  const user = await getStaffUser(db, id);
  if (!user) throw new NotFoundError("StaffUser", id);
  return user;
};

export const getStaffRoles = async (db: Database, staffUserId: string): Promise<Role[]> => {
  const links = await db.select().from(staffUserRoles).where(eq(staffUserRoles.staffUserId, staffUserId));
  return links.length ? db.select().from(roles).where(inArray(roles.id, links.map((l) => l.roleId))) : [];
};

export const getStaffPermissions = async (db: Database, staffUserId: string): Promise<Set<string>> =>
  new Set((await getStaffRoles(db, staffUserId)).flatMap((r) => r.permissions));

export const isLocked = (user: Pick<StaffUser, "lockedUntil">, at = new Date()) => !!user.lockedUntil && user.lockedUntil > at;
export const hasTwoFactor = (user: Pick<StaffUser, "totpEnabledAt" | "totpSecret">) => !!user.totpEnabledAt && !!user.totpSecret;

// ---------------------------------------------------------------- sign-in

/** One message for every failure, so responses never reveal which accounts exist or are locked. */
const signInFailed = () => new AuthenticationError("The email or password is incorrect, or the account is temporarily locked. Try again later.");

const registerFailure = async (db: Database, config: Config, userId: string) => {
  const [row] = await db
    .update(staffUsers)
    .set({ failedLoginCount: sql`${staffUsers.failedLoginCount} + 1` })
    .where(eq(staffUsers.id, userId))
    .returning({ failures: staffUsers.failedLoginCount });
  if (row && row.failures >= config.admin.lockoutFailures) {
    await db
      .update(staffUsers)
      .set({ failedLoginCount: 0, lockedUntil: new Date(Date.now() + config.admin.lockoutMinutes * 60_000) })
      .where(eq(staffUsers.id, userId));
  }
};

const completeSignIn = async (db: Database, config: Config, user: StaffUser) => {
  await db.update(staffUsers).set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(staffUsers.id, user.id));
  return { kind: "session" as const, staffUser: user, session: (await issueSession(db, config, "staff", user.id)).session };
};

export type StaffSignIn =
  | { kind: "session"; staffUser: StaffUser; session: Session }
  | { kind: "challenge"; staffUser: StaffUser; challengeToken: string; expiresAt: Date };

const CHALLENGE = "staff-2fa";

/** First factor. With two-factor on, returns a challenge token for completeStaffSignIn. */
export const beginStaffSignIn = async (db: Database, config: Config, email: string, passwordInput: string): Promise<StaffSignIn> => {
  const user = await db.query.staffUsers.findFirst({ where: eq(staffUsers.email, email.trim().toLowerCase()) });
  const ok = await verifyPassword(user?.passwordHash ?? null, passwordInput);
  if (!user || !user.isActive || isLocked(user)) throw signInFailed();
  if (!ok) {
    await registerFailure(db, config, user.id);
    throw signInFailed();
  }
  if (!hasTwoFactor(user)) return completeSignIn(db, config, user);
  const ttl = config.admin.twoFactorChallengeTtlSeconds;
  return { kind: "challenge", staffUser: user, challengeToken: await signPurposeToken(config, CHALLENGE, user.id, ttl), expiresAt: new Date(Date.now() + ttl * 1000) };
};

const totpKey = (config: Config) => deriveKey(config.jwtSecret, "staff-totp");
const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/** Second factor: a TOTP code (each time step accepted once) or an unused recovery code. */
export const completeStaffSignIn = async (db: Database, config: Config, challengeToken: string, code: string) => {
  const userId = await verifyPurposeToken(config, challengeToken, CHALLENGE);
  const user = await getStaffUser(db, userId);
  if (!user || !user.isActive || isLocked(user) || !hasTwoFactor(user)) throw signInFailed();
  const counter = verifyTotp(openSecret(totpKey(config), user.totpSecret!), code);
  // Each update spends the code only if it is unspent, so two sign-ins racing with one code can't both pass.
  if (counter !== null) {
    const [spent] = await db
      .update(staffUsers)
      .set({ totpLastCounter: counter })
      .where(and(eq(staffUsers.id, user.id), or(isNull(staffUsers.totpLastCounter), lt(staffUsers.totpLastCounter, counter))))
      .returning({ id: staffUsers.id });
    if (spent) return completeSignIn(db, config, user);
  } else {
    const hash = sha256(normalizeRecoveryCode(code));
    const [spent] = await db
      .update(staffUsers)
      .set({ recoveryCodeHashes: sql`array_remove(${staffUsers.recoveryCodeHashes}, ${hash})` })
      .where(and(eq(staffUsers.id, user.id), arrayContains(staffUsers.recoveryCodeHashes, [hash])))
      .returning({ id: staffUsers.id });
    if (spent) return completeSignIn(db, config, user);
  }
  await registerFailure(db, config, user.id);
  throw new AuthenticationError("The code is incorrect or was already used");
};

export const unlockStaffUser = async (db: Database, id: string) => {
  const [user] = await db.update(staffUsers).set({ lockedUntil: null, failedLoginCount: 0 }).where(eq(staffUsers.id, id)).returning();
  if (!user) throw new NotFoundError("StaffUser", id);
  return user;
};

// ---------------------------------------------------------------- two-factor enrollment

const ensureStableSecret = (config: Config) => {
  if (config.secretIsEphemeral) throw new InvalidStateError("Set JWT_SECRET before enabling two-factor authentication; its seeds are encrypted with a key derived from it");
};

/** The new seed stays pending until a code from it is confirmed. */
export const beginTwoFactorSetup = async (db: Database, config: Config, staffUserId: string) => {
  ensureStableSecret(config);
  const user = await requireStaffUser(db, staffUserId);
  const secret = generateTotpSecret();
  await db.update(staffUsers).set({ totpPendingSecret: sealSecret(totpKey(config), secret) }).where(eq(staffUsers.id, user.id));
  return { secret, uri: otpauthUri(secret, user.email, "Ecom Admin") };
};

/** Returns recovery codes, shown once. */
export const enableTwoFactor = async (db: Database, config: Config, staffUserId: string, code: string) => {
  ensureStableSecret(config);
  const user = await requireStaffUser(db, staffUserId);
  if (!user.totpPendingSecret) throw new InvalidStateError("Start two-factor setup first");
  const counter = verifyTotp(openSecret(totpKey(config), user.totpPendingSecret), code);
  if (counter === null) throw new ValidationError("The code is incorrect", [{ path: ["code"], message: "Enter the 6-digit code from your authenticator app" }]);
  const recoveryCodes = Array.from({ length: 10 }, () => {
    const raw = randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(10, "x").slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const [updated] = await db
    .update(staffUsers)
    .set({
      totpSecret: user.totpPendingSecret,
      totpPendingSecret: null,
      totpEnabledAt: new Date(),
      totpLastCounter: counter,
      recoveryCodeHashes: recoveryCodes.map((c) => sha256(normalizeRecoveryCode(c))),
    })
    .where(eq(staffUsers.id, user.id))
    .returning();
  return { staffUser: updated!, recoveryCodes };
};

const clearTwoFactor = { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastCounter: null, recoveryCodeHashes: [] as string[] };

/** Turning two-factor off yourself requires your password. */
export const disableTwoFactor = async (db: Database, staffUserId: string, currentPassword: string) => {
  const user = await requireStaffUser(db, staffUserId);
  if (!(await verifyPassword(user.passwordHash, currentPassword))) throw new ValidationError("The password is incorrect", [{ path: ["password"], message: "Enter your current password" }]);
  const [updated] = await db.update(staffUsers).set(clearTwoFactor).where(eq(staffUsers.id, user.id)).returning();
  return updated!;
};

/** Admin reset for a lost device; also signs the user out. */
export const resetTwoFactor = async (db: Database, staffUserId: string) =>
  db.transaction(async (tx) => {
    const [updated] = await tx.update(staffUsers).set(clearTwoFactor).where(eq(staffUsers.id, staffUserId)).returning();
    if (!updated) throw new NotFoundError("StaffUser", staffUserId);
    await revokeAllSessions(tx, "staff", staffUserId);
    return updated;
  });

// ---------------------------------------------------------------- passwords and profile

export const updateStaffProfile = async (db: Database, staffUserId: string, input: unknown) => {
  const data = parseInput(z.object({ name: z.string().trim().min(1).max(200) }), input);
  const [user] = await db.update(staffUsers).set({ name: data.name }).where(eq(staffUsers.id, staffUserId)).returning();
  if (!user) throw new NotFoundError("StaffUser", staffUserId);
  return user;
};

/** Signs out every session, this one included, and returns a fresh session. */
export const changeStaffPassword = async (db: Database, config: Config, staffUserId: string, currentPassword: string, newPassword: string) =>
  db.transaction(async (tx) => {
    const user = await requireStaffUser(tx, staffUserId);
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new ValidationError("The current password is incorrect", [{ path: ["currentPassword"], message: "Enter your current password" }]);
    }
    const next = parseInput(password, newPassword, ["newPassword"]);
    await tx.update(staffUsers).set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date() }).where(eq(staffUsers.id, user.id));
    await revokeAllSessions(tx, "staff", user.id);
    return (await issueSession(tx, config, "staff", user.id)).session;
  });

/** For administrators; signs the user out everywhere. */
export const setStaffPassword = async (db: Database, staffUserId: string, newPassword: string) =>
  db.transaction(async (tx) => {
    const next = parseInput(password, newPassword, ["password"]);
    const [user] = await tx.update(staffUsers).set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(staffUsers.id, staffUserId)).returning();
    if (!user) throw new NotFoundError("StaffUser", staffUserId);
    await revokeAllSessions(tx, "staff", staffUserId);
    return user;
  });

/**
 * Always succeeds, so the response never reveals whether an account exists. A plugin (email) sends
 * the link on `staff.password_reset_requested`, a plugin-only event that webhooks never receive.
 */
export const requestStaffPasswordReset = async (db: Database, config: Config, email: string) => {
  const user = await db.query.staffUsers.findFirst({ where: eq(staffUsers.email, email.trim().toLowerCase()) });
  if (!user || !user.isActive) return null;
  const token = await createPasswordResetToken(db, config, "staff", user.id);
  const url = `${config.admin.url}/reset-password?token=${encodeURIComponent(token)}`;
  await emit(db, { type: "staff.password_reset_requested", aggregateType: "StaffUser", aggregateId: user.id, payload: { email: user.email, name: user.name, token, url } });
  return url;
};

export const resetStaffPassword = async (db: Database, token: string, newPassword: string) =>
  db.transaction(async (tx) => {
    const next = parseInput(password, newPassword, ["password"]);
    const staffUserId = await consumePasswordResetToken(tx, token, "staff");
    const [user] = await tx
      .update(staffUsers)
      .set({ passwordHash: await hashPassword(next), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(staffUsers.id, staffUserId))
      .returning();
    return user!;
  });

// ---------------------------------------------------------------- preferences

const preferenceKey = z.string().regex(/^[a-z0-9:._-]{1,100}$/, "Use lowercase letters, digits and : . _ -");

export const getStaffPreferences = async (db: Database, staffUserId: string, keys?: readonly string[] | null) =>
  db
    .select()
    .from(staffPreferences)
    .where(keys?.length ? and(eq(staffPreferences.staffUserId, staffUserId), inArray(staffPreferences.key, [...keys])) : eq(staffPreferences.staffUserId, staffUserId));

/** `null` deletes the preference. Values are limited to 64 KB of JSON. */
export const setStaffPreference = async (db: Database, staffUserId: string, key: string, value: unknown) => {
  const k = parseInput(preferenceKey, key, ["key"]);
  if (value === null || value === undefined) {
    await db.delete(staffPreferences).where(and(eq(staffPreferences.staffUserId, staffUserId), eq(staffPreferences.key, k)));
    return { staffUserId, key: k, value: null, updatedAt: new Date() };
  }
  if (JSON.stringify(value).length > 65_536) throw new ValidationError("Preference too large", [{ path: ["value"], message: "Keep preferences under 64 KB" }]);
  const [row] = await db
    .insert(staffPreferences)
    .values({ staffUserId, key: k, value })
    .onConflictDoUpdate({ target: [staffPreferences.staffUserId, staffPreferences.key], set: { value, updatedAt: new Date() } })
    .returning();
  return row!;
};
