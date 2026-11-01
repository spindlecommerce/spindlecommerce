import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { ValidationError } from "../../lib/errors.ts";
import { CURRENCY_CODE, fromDecimalString } from "../../lib/money.ts";
import { parseInput } from "../../lib/validation.ts";
import { productVariants } from "../catalog/tables.ts";
import { emit } from "../integrations/outbox.ts";
import { reindexProducts } from "../search/projector.ts";
import { variantPrices } from "./tables.ts";

const decimal = z.string().regex(/^\d+(\.\d+)?$/, "Use a decimal string such as 19.99");

export const priceInputSchema = z
  .object({
    channelId: z.uuid(),
    currency: z.string().regex(CURRENCY_CODE),
    amount: decimal,
    compareAtAmount: decimal.nullable().optional(),
    costAmount: decimal.nullable().optional(),
    customerGroupId: z.uuid().nullable().optional(),
    minQuantity: z.number().int().positive().default(1),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
  })
  .refine((p) => !p.startsAt || !p.endsAt || p.startsAt < p.endsAt, { path: ["endsAt"], message: "Must be after startsAt" });

export type PriceInput = z.input<typeof priceInputSchema>;

export const toPriceRows = (variantId: string, prices: PriceInput[], path: string[]) =>
  prices.map((input, index) => {
    const p = parseInput(priceInputSchema, input, [...path, String(index)]);
    try {
      return {
        variantId,
        channelId: p.channelId,
        currency: p.currency,
        amount: fromDecimalString(p.amount, p.currency),
        compareAtAmount: p.compareAtAmount ? fromDecimalString(p.compareAtAmount, p.currency) : null,
        costAmount: p.costAmount ? fromDecimalString(p.costAmount, p.currency) : null,
        customerGroupId: p.customerGroupId ?? null,
        minQuantity: p.minQuantity,
        startsAt: p.startsAt ?? null,
        endsAt: p.endsAt ?? null,
      };
    } catch (error) {
      throw new ValidationError("Invalid price", [{ path: [...path, String(index), "amount"], message: (error as Error).message }]);
    }
  });

/** Replaces all of the variant's prices, in every channel and currency. */
export const setVariantPrices = async (db: Database, variantId: string, prices: PriceInput[]) => {
  const rows = toPriceRows(variantId, prices, ["input", "prices"]);
  await db.delete(variantPrices).where(eq(variantPrices.variantId, variantId));
  if (rows.length > 0) await db.insert(variantPrices).values(rows);
  const [variant] = await db.select({ productId: productVariants.productId }).from(productVariants).where(eq(productVariants.id, variantId));
  if (variant) {
    await reindexProducts(db, [variant.productId]);
    await emit(db, { type: "price.updated", aggregateType: "ProductVariant", aggregateId: variantId, payload: { productId: variant.productId } });
  }
  return db.select().from(variantPrices).where(eq(variantPrices.variantId, variantId));
};
