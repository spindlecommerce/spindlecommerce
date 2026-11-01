import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, textArray, updatedAt } from "../../db/columns.ts";

/** Permissions are `<area>:<read|write>` strings; `*` grants everything. */
export const roles = pgTable("roles", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  permissions: textArray("permissions"),
  createdAt: createdAt(),
});

export const staffUsers = pgTable(
  "staff_users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    /** Consecutive failed sign-ins; reaching the configured limit sets `lockedUntil`. */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** TOTP seeds, sealed with a key derived from JWT_SECRET (see lib/crypto.ts). */
    totpSecret: text("totp_secret"),
    totpPendingSecret: text("totp_pending_secret"),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** Last accepted TOTP time step, so a code cannot be replayed within its window. */
    totpLastCounter: bigint("totp_last_counter", { mode: "number" }),
    /** SHA-256 hashes of unused single-use recovery codes. */
    recoveryCodeHashes: textArray("recovery_code_hashes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("staff_users_email_uq").on(t.email)],
);

export const staffUserRoles = pgTable(
  "staff_user_roles",
  {
    staffUserId: uuid("staff_user_id").notNull().references(() => staffUsers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.staffUserId, t.roleId] })],
);

/** Per-user admin settings such as saved grid views, synced across devices. */
export const staffPreferences = pgTable(
  "staff_preferences",
  {
    staffUserId: uuid("staff_user_id").notNull().references(() => staffUsers.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.staffUserId, t.key] })],
);
