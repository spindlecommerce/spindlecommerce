import { and, desc, eq, ilike, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../../config.ts";
import type { Database } from "../../db/client.ts";
import { holdsOnly } from "../../db/query.ts";
import { addressSchema } from "../../lib/address.ts";
import { AuthenticationError, InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { parseInput, patchSchema } from "../../lib/validation.ts";
import { consumePasswordResetToken, createPasswordResetToken, hashPassword, revokeAllSessions, verifyPassword } from "../auth/service.ts";
import { passwordResetTokens } from "../auth/tables.ts";
import { carts } from "../carts/tables.ts";
import { emit } from "../integrations/outbox.ts";
import { promotions } from "../promotions/tables.ts";
import { customerAddresses, customerGroups, customers } from "./tables.ts";

export type Customer = typeof customers.$inferSelect;
export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type CustomerGroup = typeof customerGroups.$inferSelect;

export const DEFAULT_GROUP_CODE = "general";
export const GUEST_GROUP_CODE = "guest";

const email = z.email().max(254).transform((e) => e.trim().toLowerCase());
const password = z.string().min(10, "Use at least 10 characters").max(256);
const name = z.string().trim().min(1).max(100);

const registerSchema = z.object({
  email,
  password,
  firstName: name,
  lastName: name,
  phone: z.string().max(40).nullable().optional(),
  dateOfBirth: z.iso.date().nullable().optional(),
  acceptsMarketing: z.boolean().default(false),
});

const profileSchema = patchSchema(registerSchema.omit({ email: true, password: true }));
const adminCustomerSchema = registerSchema.extend({ password: password.optional(), groupId: z.uuid().optional(), note: z.string().max(5000).nullable().optional(), isActive: z.boolean().optional() });

export const findGroupByCode = (db: Database, code: string) => db.query.customerGroups.findFirst({ where: eq(customerGroups.code, code) });

export const getGroupId = async (db: Database, code: string) => {
  const group = await findGroupByCode(db, code);
  if (!group) throw new NotFoundError("CustomerGroup", code);
  return group.id;
};

export const listCustomerGroups = (db: Database) => db.query.customerGroups.findMany({ orderBy: customerGroups.code });

export const createCustomerGroup = async (db: Database, input: unknown) => {
  const data = parseInput(z.object({ code: z.string().regex(/^[a-z0-9_-]{1,40}$/), name: z.string().min(1), taxClassId: z.uuid().nullable().optional() }), input);
  const [row] = await db.insert(customerGroups).values(data).returning();
  return row!;
};

const assertEmailFree = async (db: Database, value: string, exceptId?: string) => {
  const existing = await db.query.customers.findFirst({ where: exceptId ? and(eq(customers.email, value), ne(customers.id, exceptId)) : eq(customers.email, value) });
  if (existing) throw new ValidationError("Email already registered", [{ path: ["input", "email"], message: "An account with this email already exists" }]);
};

export const registerCustomer = async (db: Database, input: unknown): Promise<Customer> =>
  db.transaction(async (tx) => {
    const data = parseInput(registerSchema, input);
    if (data.password.toLowerCase().includes(data.email.split("@")[0]!)) {
      throw new ValidationError("Weak password", [{ path: ["input", "password"], message: "The password must not contain your email name" }]);
    }
    await assertEmailFree(tx, data.email);
    const [customer] = await tx
      .insert(customers)
      .values({ ...data, passwordHash: await hashPassword(data.password), groupId: await getGroupId(tx, DEFAULT_GROUP_CODE) })
      .returning();
    await emit(tx, { type: "customer.created", aggregateType: "Customer", aggregateId: customer!.id });
    return customer!;
  });

/** The password is optional; the customer can set one through password reset. */
export const createCustomerAsStaff = async (db: Database, input: unknown): Promise<Customer> =>
  db.transaction(async (tx) => {
    const data = parseInput(adminCustomerSchema, input);
    await assertEmailFree(tx, data.email);
    const [customer] = await tx
      .insert(customers)
      .values({
        ...data,
        passwordHash: data.password ? await hashPassword(data.password) : null,
        groupId: data.groupId ?? (await getGroupId(tx, DEFAULT_GROUP_CODE)),
      })
      .returning();
    await emit(tx, { type: "customer.created", aggregateType: "Customer", aggregateId: customer!.id });
    return customer!;
  });

export const authenticateCustomer = async (db: Database, emailInput: string, passwordInput: string): Promise<Customer> => {
  const customer = await db.query.customers.findFirst({ where: eq(customers.email, emailInput.trim().toLowerCase()) });
  const ok = await verifyPassword(customer?.passwordHash ?? null, passwordInput);
  if (!customer || !ok || !customer.isActive) throw new AuthenticationError("The email or password is incorrect");
  await db.update(customers).set({ lastLoginAt: new Date() }).where(eq(customers.id, customer.id));
  return customer;
};

export const getCustomer = async (db: Database, id: string): Promise<Customer> => {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!customer) throw new NotFoundError("Customer", id);
  return customer;
};

export const updateCustomerProfile = async (db: Database, id: string, input: unknown): Promise<Customer> => {
  const data = parseInput(profileSchema, input);
  const [row] = await db.update(customers).set({ ...data, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
  if (!row) throw new NotFoundError("Customer", id);
  await emit(db, { type: "customer.updated", aggregateType: "Customer", aggregateId: id });
  return row;
};

export const updateCustomerAsStaff = async (db: Database, id: string, input: unknown): Promise<Customer> => {
  const data = parseInput(patchSchema(adminCustomerSchema.omit({ password: true })), input);
  if (data.email) await assertEmailFree(db, data.email, id);
  const [row] = await db.update(customers).set({ ...data, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
  if (!row) throw new NotFoundError("Customer", id);
  if (data.isActive === false) await revokeAllSessions(db, "customer", id);
  await emit(db, { type: "customer.updated", aggregateType: "Customer", aggregateId: id });
  return row;
};

export const changeCustomerPassword = async (db: Database, id: string, currentPassword: string, newPassword: string) => {
  const customer = await getCustomer(db, id);
  if (!(await verifyPassword(customer.passwordHash, currentPassword))) {
    throw new ValidationError("Current password is incorrect", [{ path: ["currentPassword"], message: "Incorrect password" }]);
  }
  const next = parseInput(password, newPassword, ["newPassword"]);
  await db.update(customers).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(customers.id, id));
  return customer;
};

/**
 * Always succeeds, so the response never reveals whether an account exists. `channelId` picks the
 * storefront the reset link opens.
 */
export const requestCustomerPasswordReset = async (db: Database, config: Config, emailInput: string, options: { channelId?: string | null } = {}) => {
  const customer = await db.query.customers.findFirst({ where: eq(customers.email, emailInput.trim().toLowerCase()) });
  if (!customer || !customer.isActive) return;
  const token = await createPasswordResetToken(db, config, "customer", customer.id);
  // Plugin-only event, so webhooks never see the token; the API never returns it either.
  await emit(db, { type: "customer.password_reset_requested", aggregateType: "Customer", aggregateId: customer.id, payload: { email: customer.email, token, ...(options.channelId ? { channelId: options.channelId } : {}) } });
};

export const resetCustomerPassword = async (db: Database, token: string, newPassword: string) =>
  db.transaction(async (tx) => {
    const next = parseInput(password, newPassword, ["newPassword"]);
    const customerId = await consumePasswordResetToken(tx, token, "customer");
    const [row] = await tx.update(customers).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(customers.id, customerId)).returning();
    return row!;
  });

export const listCustomers = async (db: Database, filter: { query?: string | null; groupId?: string | null }, page: { limit: number; afterId?: string | null }) => {
  const where: SQL[] = [];
  if (filter.groupId) where.push(eq(customers.groupId, filter.groupId));
  if (filter.query) {
    const pattern = `%${filter.query.replace(/[%_]/g, "\\$&")}%`;
    where.push(or(ilike(customers.email, pattern), ilike(customers.firstName, pattern), ilike(customers.lastName, pattern))!);
  }
  const total = await db.$count(customers, where.length ? and(...where) : undefined);
  if (page.afterId) where.push(lt(customers.id, page.afterId));
  const rows = await db.select().from(customers).where(where.length ? and(...where) : undefined).orderBy(desc(customers.id)).limit(page.limit);
  return { rows, total };
};

// ---------------------------------------------------------------- addresses

const addressInputSchema = addressSchema.extend({ isDefaultShipping: z.boolean().optional(), isDefaultBilling: z.boolean().optional() });

export const listAddresses = (db: Database, customerId: string) =>
  db.query.customerAddresses.findMany({ where: eq(customerAddresses.customerId, customerId), orderBy: customerAddresses.id });

const clearDefaults = async (db: Database, customerId: string, flags: { isDefaultShipping?: boolean | undefined; isDefaultBilling?: boolean | undefined }) => {
  if (flags.isDefaultShipping) await db.update(customerAddresses).set({ isDefaultShipping: false }).where(eq(customerAddresses.customerId, customerId));
  if (flags.isDefaultBilling) await db.update(customerAddresses).set({ isDefaultBilling: false }).where(eq(customerAddresses.customerId, customerId));
};

export const createAddress = async (db: Database, customerId: string, input: unknown) =>
  db.transaction(async (tx) => {
    const data = parseInput(addressInputSchema, input);
    const isFirst = (await tx.$count(customerAddresses, eq(customerAddresses.customerId, customerId))) === 0;
    const flags = { isDefaultShipping: data.isDefaultShipping ?? isFirst, isDefaultBilling: data.isDefaultBilling ?? isFirst };
    await clearDefaults(tx, customerId, flags);
    const [row] = await tx.insert(customerAddresses).values({ ...data, ...flags, customerId }).returning();
    return row!;
  });

const ownedAddress = async (db: Database, customerId: string, addressId: string) => {
  const address = await db.query.customerAddresses.findFirst({ where: and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, customerId)) });
  if (!address) throw new NotFoundError("CustomerAddress", addressId);
  return address;
};

export const updateAddress = async (db: Database, customerId: string, addressId: string, input: unknown) =>
  db.transaction(async (tx) => {
    const existing = await ownedAddress(tx, customerId, addressId);
    const data = parseInput(addressInputSchema, { ...existing, ...(input as object) });
    await clearDefaults(tx, customerId, data);
    const [row] = await tx.update(customerAddresses).set({ ...data, updatedAt: new Date() }).where(eq(customerAddresses.id, addressId)).returning();
    return row!;
  });

export const deleteAddress = async (db: Database, customerId: string, addressId: string) => {
  await ownedAddress(db, customerId, addressId);
  await db.delete(customerAddresses).where(eq(customerAddresses.id, addressId));
  return addressId;
};

export const getAddress = ownedAddress;

export const addressToSnapshot = (a: CustomerAddress) => ({
  firstName: a.firstName,
  lastName: a.lastName,
  company: a.company,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  region: a.region,
  regionCode: a.regionCode,
  postalCode: a.postalCode,
  countryCode: a.countryCode,
  phone: a.phone,
});

// ---------------------------------------------------------------- admin-only operations

export const updateCustomerGroup = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(z.object({ name: z.string().min(1).optional(), taxClassId: z.uuid().nullable().optional() }), input);
  const [row] = await db.update(customerGroups).set(data).where(eq(customerGroups.id, id)).returning();
  if (!row) throw new NotFoundError("CustomerGroup", id);
  return row;
};

/**
 * Members move to the default group; the group's prices are deleted with it. Refused while a
 * promotion targets only this group, since an empty group list means every group.
 */
export const deleteCustomerGroup = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const group = await tx.query.customerGroups.findFirst({ where: eq(customerGroups.id, id) });
    if (!group) throw new NotFoundError("CustomerGroup", id);
    if (group.code === DEFAULT_GROUP_CODE || group.code === GUEST_GROUP_CODE) throw new InvalidStateError(`The built-in ${group.code} group cannot be deleted`);
    const limited = await tx.select({ name: promotions.name }).from(promotions).where(holdsOnly(promotions.customerGroupIds, id));
    if (limited.length) throw new InvalidStateError(`Promotions limited to this group: ${limited.map((p) => p.name).join(", ")}; change their groups or delete them first`);
    const fallback = await getGroupId(tx, DEFAULT_GROUP_CODE);
    await tx.update(customers).set({ groupId: fallback, updatedAt: new Date() }).where(eq(customers.groupId, id));
    await tx.update(promotions).set({ customerGroupIds: sql`array_remove(${promotions.customerGroupIds}, ${id}::uuid)` }).where(sql`${id}::uuid = any(${promotions.customerGroupIds})`);
    await tx.delete(customerGroups).where(eq(customerGroups.id, id));
    return id;
  });

/** Orders keep their own email and addresses and are detached; carts and sessions are deleted. */
export const deleteCustomer = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const customer = await getCustomer(tx, id);
    await revokeAllSessions(tx, "customer", id);
    await tx.delete(passwordResetTokens).where(and(eq(passwordResetTokens.subjectType, "customer"), eq(passwordResetTokens.subjectId, id)));
    await tx.delete(carts).where(eq(carts.customerId, id));
    await tx.delete(customers).where(eq(customers.id, id));
    await emit(tx, { type: "customer.deleted", aggregateType: "Customer", aggregateId: id, payload: { email: customer.email } });
    return id;
  });

/** Staff-initiated; a plugin delivers the email on `customer.password_reset_requested`. */
export const sendCustomerPasswordReset = async (db: Database, config: Config, id: string) => {
  const customer = await getCustomer(db, id);
  if (!customer.isActive) throw new InvalidStateError("The account is inactive");
  const token = await createPasswordResetToken(db, config, "customer", customer.id);
  await emit(db, { type: "customer.password_reset_requested", aggregateType: "Customer", aggregateId: customer.id, payload: { email: customer.email, token } });
  return customer;
};

export const revokeCustomerSessions = async (db: Database, id: string) => {
  const customer = await getCustomer(db, id);
  await revokeAllSessions(db, "customer", id);
  return customer;
};
