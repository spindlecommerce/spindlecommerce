import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { randomToken } from "../../lib/crypto.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { parseInput } from "../../lib/validation.ts";
import { emit } from "../integrations/outbox.ts";
import type { EngineRule } from "./engine.ts";
import { actionSchema, conditionSchema } from "./rules.ts";
import { coupons, promotions, promotionUsages } from "./tables.ts";

export type Promotion = typeof promotions.$inferSelect;
export type Coupon = typeof coupons.$inferSelect;

const promotionSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().default(true),
    channelIds: z.array(z.uuid()).default([]),
    customerGroupIds: z.array(z.uuid()).default([]),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    priority: z.number().int().min(0).default(0),
    stopFurtherRules: z.boolean().default(false),
    requiresCoupon: z.boolean().default(false),
    conditions: conditionSchema.default({ type: "all", conditions: [] }),
    action: actionSchema,
    usageLimit: z.number().int().positive().nullable().optional(),
    usageLimitPerCustomer: z.number().int().positive().nullable().optional(),
    couponCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,40}$/)).default([]),
  })
  .refine((p) => !p.startsAt || !p.endsAt || p.startsAt < p.endsAt, { path: ["endsAt"], message: "Must be after startsAt" })
  .refine((p) => p.requiresCoupon || p.couponCodes.length === 0, { path: ["couponCodes"], message: "Set requiresCoupon to use coupon codes" });

const normalizeCode = (code: string) => code.trim().toUpperCase();

const insertCoupons = async (db: Database, promotionId: string, codes: string[], opts: { usageLimit?: number | null; expiresAt?: Date | null } = {}) => {
  if (codes.length === 0) return [];
  const normalized = codes.map(normalizeCode);
  const taken = await db.select({ code: coupons.code }).from(coupons).where(inArray(coupons.code, normalized));
  if (taken.length) throw new ValidationError("Coupon codes already exist", taken.map((t) => ({ path: ["input", "couponCodes"], message: `${t.code} is already used` })));
  return db.insert(coupons).values(normalized.map((code) => ({ promotionId, code, usageLimit: opts.usageLimit ?? null, expiresAt: opts.expiresAt ?? null }))).returning();
};

export const createPromotion = async (db: Database, input: unknown) =>
  db.transaction(async (tx) => {
    const { couponCodes, ...data } = parseInput(promotionSchema, input);
    const [promotion] = await tx.insert(promotions).values(data).returning();
    await insertCoupons(tx, promotion!.id, couponCodes);
    await emit(tx, { type: "promotion.created", aggregateType: "Promotion", aggregateId: promotion!.id });
    return promotion!;
  });

export const updatePromotion = async (db: Database, id: string, input: unknown) =>
  db.transaction(async (tx) => {
    const existing = await tx.query.promotions.findFirst({ where: eq(promotions.id, id) });
    if (!existing) throw new NotFoundError("Promotion", id);
    const { couponCodes, ...data } = parseInput(promotionSchema, { ...existing, ...(input as object), couponCodes: (input as { couponCodes?: string[] }).couponCodes ?? [] });
    const [row] = await tx.update(promotions).set({ ...data, updatedAt: new Date() }).where(eq(promotions.id, id)).returning();
    await insertCoupons(tx, id, couponCodes);
    await emit(tx, { type: "promotion.updated", aggregateType: "Promotion", aggregateId: id });
    return row!;
  });

export const deletePromotion = async (db: Database, id: string) => {
  const [row] = await db.delete(promotions).where(eq(promotions.id, id)).returning({ id: promotions.id });
  if (!row) throw new NotFoundError("Promotion", id);
  return id;
};

export const generateCoupons = async (db: Database, input: { promotionId: string; quantity: number; prefix?: string | null; length?: number; usageLimit?: number | null; expiresAt?: Date | null }) =>
  db.transaction(async (tx) => {
    const promotion = await tx.query.promotions.findFirst({ where: eq(promotions.id, input.promotionId) });
    if (!promotion) throw new NotFoundError("Promotion", input.promotionId);
    if (!promotion.requiresCoupon) throw new ValidationError("This promotion does not use coupons", [{ path: ["promotionId"], message: "requiresCoupon is false" }]);
    if (input.quantity < 1 || input.quantity > 10_000) throw new ValidationError("Invalid quantity", [{ path: ["quantity"], message: "Between 1 and 10000" }]);
    const length = Math.min(Math.max(input.length ?? 10, 6), 32);
    const codes = new Set<string>();
    while (codes.size < input.quantity) {
      codes.add(`${input.prefix ?? ""}${randomToken(length).replace(/[^A-Za-z0-9]/g, "").slice(0, length).toUpperCase()}`);
    }
    return insertCoupons(tx, input.promotionId, [...codes], input);
  });

export const listPromotions = async (db: Database, page: { limit: number; afterId?: string | null }, filter: { query?: string | null; isActive?: boolean | null } = {}) => {
  const conditions: SQL[] = [];
  if (filter.query?.trim()) {
    const q = filter.query.trim();
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(promotions.name, pattern), sql`${promotions.id} in (select promotion_id from coupons where code = ${normalizeCode(q)})`)!);
  }
  if (filter.isActive != null) conditions.push(eq(promotions.isActive, filter.isActive));
  const where = conditions.length ? and(...conditions) : undefined;
  const total = await db.$count(promotions, where);
  const rows = await db.select().from(promotions).where(page.afterId ? and(where, lt(promotions.id, page.afterId)) : where).orderBy(desc(promotions.id)).limit(page.limit);
  return { rows, total };
};

/** Usage history keeps its counts; usage rows lose their coupon link. */
export const deleteCoupons = async (db: Database, ids: string[]) => {
  if (ids.length === 0 || ids.length > 10_000) throw new ValidationError("Invalid ids", [{ path: ["ids"], message: "Between 1 and 10000" }]);
  const deleted = await db.delete(coupons).where(inArray(coupons.id, ids)).returning({ id: coupons.id });
  return deleted.map((d) => d.id);
};

export const getCouponsByPromotionIds = (db: Database, ids: readonly string[]) =>
  ids.length === 0 ? Promise.resolve([]) : db.select().from(coupons).where(inArray(coupons.promotionId, [...ids]));

export const findCoupon = (db: Database, code: string) => db.query.coupons.findFirst({ where: eq(coupons.code, normalizeCode(code)) });

export type CouponCheck = { ok: true; coupon: Coupon; promotion: Promotion } | { ok: false; reason: string };

/** Checks limits, dates and scope; the rule's conditions are left to the engine. */
export const checkCoupon = async (db: Database, code: string, ctx: { channelId: string; customerGroupId: string | null; customerId: string | null; at: Date }): Promise<CouponCheck> => {
  const coupon = await findCoupon(db, code);
  if (!coupon) return { ok: false, reason: "unknown coupon" };
  const promotion = await db.query.promotions.findFirst({ where: eq(promotions.id, coupon.promotionId) });
  if (!promotion || !promotion.isActive) return { ok: false, reason: "the promotion is not active" };
  if (coupon.expiresAt && coupon.expiresAt <= ctx.at) return { ok: false, reason: "the coupon has expired" };
  if ((promotion.startsAt && promotion.startsAt > ctx.at) || (promotion.endsAt && promotion.endsAt <= ctx.at)) return { ok: false, reason: "the promotion is not running" };
  if (promotion.channelIds.length && !promotion.channelIds.includes(ctx.channelId)) return { ok: false, reason: "not valid in this store" };
  if (promotion.customerGroupIds.length && (!ctx.customerGroupId || !promotion.customerGroupIds.includes(ctx.customerGroupId))) {
    return { ok: false, reason: "not valid for your customer group" };
  }
  if (coupon.usageLimit !== null && coupon.timesUsed >= coupon.usageLimit) return { ok: false, reason: "the coupon has been used up" };
  if (promotion.usageLimit !== null && promotion.timesUsed >= promotion.usageLimit) return { ok: false, reason: "the promotion has been used up" };
  if (promotion.usageLimitPerCustomer !== null && ctx.customerId) {
    const used = await db.$count(promotionUsages, and(eq(promotionUsages.promotionId, promotion.id), eq(promotionUsages.customerId, ctx.customerId)));
    if (used >= promotion.usageLimitPerCustomer) return { ok: false, reason: "you have already used this promotion" };
  }
  return { ok: true, coupon, promotion };
};

/** Automatic rules plus those unlocked by the cart's valid coupons. */
export const loadApplicableRules = async (
  db: Database,
  ctx: { channelId: string; customerGroupId: string | null; customerId: string | null; couponCodes: readonly string[]; at: Date },
): Promise<{ rules: EngineRule[]; invalidCoupons: { code: string; reason: string }[] }> => {
  const automatic = await db
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.isActive, true),
        eq(promotions.requiresCoupon, false),
        sql`(${promotions.startsAt} is null or ${promotions.startsAt} <= ${ctx.at})`,
        sql`(${promotions.endsAt} is null or ${promotions.endsAt} > ${ctx.at})`,
        sql`(cardinality(${promotions.channelIds}) = 0 or ${ctx.channelId}::uuid = any(${promotions.channelIds}))`,
      ),
    );
  const rules: EngineRule[] = automatic
    .filter((p) => p.customerGroupIds.length === 0 || (ctx.customerGroupId !== null && p.customerGroupIds.includes(ctx.customerGroupId)))
    .filter((p) => p.usageLimit === null || p.timesUsed < p.usageLimit)
    .map((p) => ({ id: p.id, name: p.name, priority: p.priority, stopFurtherRules: p.stopFurtherRules, conditions: p.conditions, action: p.action, couponCode: null }));
  const invalidCoupons: { code: string; reason: string }[] = [];
  for (const code of ctx.couponCodes) {
    const check = await checkCoupon(db, code, ctx);
    if (!check.ok) {
      invalidCoupons.push({ code, reason: check.reason });
      continue;
    }
    if (rules.some((r) => r.id === check.promotion.id)) continue;
    const p = check.promotion;
    rules.push({ id: p.id, name: p.name, priority: p.priority, stopFurtherRules: p.stopFurtherRules, conditions: p.conditions, action: p.action, couponCode: check.coupon.code });
  }
  return { rules, invalidCoupons };
};

/** Call inside the checkout transaction. */
export const recordPromotionUsage = async (
  db: Database,
  input: { orderId: string; customerId: string | null; applied: { promotionId: string; couponCode: string | null }[] },
) => {
  for (const usage of input.applied) {
    await db.update(promotions).set({ timesUsed: sql`${promotions.timesUsed} + 1` }).where(eq(promotions.id, usage.promotionId));
    let couponId: string | null = null;
    if (usage.couponCode) {
      const [coupon] = await db.update(coupons).set({ timesUsed: sql`${coupons.timesUsed} + 1` }).where(eq(coupons.code, usage.couponCode)).returning({ id: coupons.id });
      couponId = coupon?.id ?? null;
    }
    await db.insert(promotionUsages).values({ promotionId: usage.promotionId, couponId, customerId: input.customerId, orderId: input.orderId });
  }
};
