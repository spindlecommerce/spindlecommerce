import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { holdsOnly, queryRows } from "../../db/query.ts";
import { InvalidStateError, NotFoundError } from "../../lib/errors.ts";
import { parseInput, patchSchema } from "../../lib/validation.ts";
import type { TaxRateRow, TaxRuleRow } from "./engine.ts";
import { taxClasses, taxRates, taxRules } from "./tables.ts";

export type TaxClass = typeof taxClasses.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type TaxRule = typeof taxRules.$inferSelect;

const taxClassSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1),
  kind: z.enum(["product", "customer"]),
});

const taxRateSchema = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  regionCode: z.string().max(10).nullable().optional(),
  postalCodePattern: z.string().max(20).nullable().optional(),
  rate: z.number().min(0).max(100),
});

const taxRuleSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().min(0).default(0),
  productTaxClassIds: z.array(z.uuid()).min(1),
  customerTaxClassIds: z.array(z.uuid()).default([]),
  taxRateIds: z.array(z.uuid()).min(1),
});

export const createTaxClass = async (db: Database, input: unknown) => {
  const [row] = await db.insert(taxClasses).values(parseInput(taxClassSchema, input)).returning();
  return row!;
};

export const createTaxRate = async (db: Database, input: unknown) => {
  const data = parseInput(taxRateSchema, input);
  const [row] = await db.insert(taxRates).values({ ...data, rate: String(data.rate) }).returning();
  return row!;
};

export const updateTaxRate = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(taxRateSchema.partial(), input);
  const [row] = await db
    .update(taxRates)
    .set({ ...data, rate: data.rate === undefined ? undefined : String(data.rate) })
    .where(eq(taxRates.id, id))
    .returning();
  if (!row) throw new NotFoundError("TaxRate", id);
  return row;
};

export const createTaxRule = async (db: Database, input: unknown) => {
  const [row] = await db.insert(taxRules).values(parseInput(taxRuleSchema, input)).returning();
  return row!;
};

export const listTaxClasses = (db: Database) => db.query.taxClasses.findMany({ orderBy: taxClasses.code });
export const listTaxRates = (db: Database) => db.query.taxRates.findMany({ orderBy: taxRates.code });
export const listTaxRules = (db: Database) => db.query.taxRules.findMany({ orderBy: taxRules.priority });

/** Small, hot reference data, loaded whole for the totals pipeline. */
export const loadTaxTables = async (db: Database): Promise<{ rates: TaxRateRow[]; rules: TaxRuleRow[] }> => {
  const rates = await db.select().from(taxRates);
  const rules = await db.select().from(taxRules);
  return {
    rates: rates.map((r) => ({ ...r, rate: Number(r.rate) })),
    rules,
  };
};

export const updateTaxClass = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(z.object({ name: z.string().min(1) }), input);
  const [row] = await db.update(taxClasses).set(data).where(eq(taxClasses.id, id)).returning();
  if (!row) throw new NotFoundError("TaxClass", id);
  return row;
};

/**
 * Refused while products, types, customer groups, channels or methods use it, or while it is a
 * rule's only class: an empty customer class list would mean every class. Other rules drop it.
 */
export const deleteTaxClass = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const [usage] = await queryRows<Record<string, number>>(
      tx,
      sql`select (select count(*) from products where tax_class_id = ${id}::uuid)::int as products,
                 (select count(*) from product_types where tax_class_id = ${id}::uuid)::int as product_types,
                 (select count(*) from customer_groups where tax_class_id = ${id}::uuid)::int as customer_groups,
                 (select count(*) from channels where shipping_tax_class_id = ${id}::uuid)::int as channels,
                 (select count(*) from shipping_methods where tax_class_id = ${id}::uuid)::int as shipping_methods`,
    );
    const NOUNS: Record<string, [string, string]> = { products: ["product", "products"], product_types: ["product type", "product types"], customer_groups: ["customer group", "customer groups"], channels: ["channel", "channels"], shipping_methods: ["shipping method", "shipping methods"] };
    const inUse = Object.entries(usage ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([table, count]) => `${count} ${NOUNS[table]?.[Number(count) === 1 ? 0 : 1] ?? table}`);
    if (inUse.length) throw new InvalidStateError(`The tax class is still used by ${inUse.join(", ")}`);
    const limited = await tx.select({ name: taxRules.name }).from(taxRules).where(or(holdsOnly(taxRules.productTaxClassIds, id), holdsOnly(taxRules.customerTaxClassIds, id)));
    if (limited.length) throw new InvalidStateError(`Tax rules limited to this class: ${limited.map((r) => r.name).join(", ")}; change their classes or delete them first`);
    await tx
      .update(taxRules)
      .set({ productTaxClassIds: sql`array_remove(${taxRules.productTaxClassIds}, ${id}::uuid)`, customerTaxClassIds: sql`array_remove(${taxRules.customerTaxClassIds}, ${id}::uuid)` });
    const [row] = await tx.delete(taxClasses).where(eq(taxClasses.id, id)).returning({ id: taxClasses.id });
    if (!row) throw new NotFoundError("TaxClass", id);
    return id;
  });

/** Removes the rate from every rule that used it. */
export const deleteTaxRate = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    await tx.update(taxRules).set({ taxRateIds: sql`array_remove(${taxRules.taxRateIds}, ${id}::uuid)` });
    const [row] = await tx.delete(taxRates).where(eq(taxRates.id, id)).returning({ id: taxRates.id });
    if (!row) throw new NotFoundError("TaxRate", id);
    return id;
  });

export const updateTaxRule = async (db: Database, id: string, input: unknown) => {
  const [row] = await db.update(taxRules).set(parseInput(patchSchema(taxRuleSchema), input)).where(eq(taxRules.id, id)).returning();
  if (!row) throw new NotFoundError("TaxRule", id);
  return row;
};

export const deleteTaxRule = async (db: Database, id: string) => {
  const [row] = await db.delete(taxRules).where(eq(taxRules.id, id)).returning({ id: taxRules.id });
  if (!row) throw new NotFoundError("TaxRule", id);
  return id;
};
