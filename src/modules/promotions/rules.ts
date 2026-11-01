import { z } from "zod";

/**
 * Cart rules: a condition tree plus one action. Amounts are minor units keyed by currency; a
 * missing currency makes amount conditions false and amount actions zero.
 */
const comparison = z.enum(["gte", "gt", "lte", "lt", "eq"]);
export type Comparison = z.infer<typeof comparison>;

const amounts = z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().nonnegative());

export type LinePredicate =
  | { type: "all"; predicates: LinePredicate[] }
  | { type: "any"; predicates: LinePredicate[] }
  | { type: "sku_in"; skus: string[] }
  | { type: "product_in"; productIds: string[] }
  | { type: "category_in"; categoryIds: string[] }
  | { type: "attribute_in"; attribute: string; values: string[] };

export const linePredicateSchema: z.ZodType<LinePredicate> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("all"), predicates: z.array(linePredicateSchema) }),
    z.object({ type: z.literal("any"), predicates: z.array(linePredicateSchema) }),
    z.object({ type: z.literal("sku_in"), skus: z.array(z.string().min(1)).min(1) }),
    z.object({ type: z.literal("product_in"), productIds: z.array(z.uuid()).min(1) }),
    z.object({ type: z.literal("category_in"), categoryIds: z.array(z.uuid()).min(1) }),
    z.object({ type: z.literal("attribute_in"), attribute: z.string().min(1), values: z.array(z.string()).min(1) }),
  ]),
);

export type Condition =
  | { type: "all"; conditions: Condition[] }
  | { type: "any"; conditions: Condition[] }
  | { type: "not"; condition: Condition }
  | { type: "subtotal"; operator: Comparison; amounts: Record<string, number> }
  | { type: "total_quantity"; operator: Comparison; value: number }
  | { type: "line_matches"; predicate: LinePredicate; minQuantity?: number }
  | { type: "shipping_country_in"; countries: string[] }
  | { type: "customer_group_in"; groupIds: string[] };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("all"), conditions: z.array(conditionSchema) }),
    z.object({ type: z.literal("any"), conditions: z.array(conditionSchema) }),
    z.object({ type: z.literal("not"), condition: conditionSchema }),
    z.object({ type: z.literal("subtotal"), operator: comparison, amounts }),
    z.object({ type: z.literal("total_quantity"), operator: comparison, value: z.number().int().nonnegative() }),
    z.object({ type: z.literal("line_matches"), predicate: linePredicateSchema, minQuantity: z.number().int().positive().optional() }),
    z.object({ type: z.literal("shipping_country_in"), countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1) }),
    z.object({ type: z.literal("customer_group_in"), groupIds: z.array(z.uuid()).min(1) }),
  ]),
);

export const actionSchema = z.discriminatedUnion("type", [
  /** A percentage off the matching lines, up to `maxDiscountAmounts` when set. */
  z.object({
    type: z.literal("percentage_off"),
    percent: z.number().gt(0).lte(100),
    target: linePredicateSchema.optional(),
    maxDiscountAmounts: amounts.optional(),
  }),
  /** An amount off each unit. */
  z.object({ type: z.literal("fixed_off_each"), amounts, target: linePredicateSchema.optional() }),
  /** An amount off the matching lines, allocated proportionally. */
  z.object({ type: z.literal("fixed_off_cart"), amounts, target: linePredicateSchema.optional() }),
  /** Per line: for every buy+get units, `get` units are discounted by `percent`. */
  z.object({
    type: z.literal("buy_x_get_y"),
    buyQuantity: z.number().int().positive(),
    getQuantity: z.number().int().positive(),
    percent: z.number().gt(0).lte(100).default(100),
    target: linePredicateSchema.optional(),
  }),
  /** Discount on shipping; percent 100 is free shipping. */
  z.object({ type: z.literal("shipping_off"), percent: z.number().gt(0).lte(100).default(100), methodCodes: z.array(z.string()).optional() }),
]);

export type Action = z.infer<typeof actionSchema>;
