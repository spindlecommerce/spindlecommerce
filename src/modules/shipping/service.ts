import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { parseInput } from "../../lib/validation.ts";
import type { ShippingRateDetails } from "../../plugins/sdk.ts";
import { parseProviderOptions } from "./options.ts";
import { BUILT_IN_SHIPPING_KINDS, createShippingRegistry, type ShippingProviderRegistry } from "./providers.ts";
import { shippingMethods, shippingZones, type ShippingMethodConfig } from "./tables.ts";

export type ShippingMethod = typeof shippingMethods.$inferSelect;
export type ShippingZone = typeof shippingZones.$inferSelect;

export type ShippingRate = {
  code: string;
  name: string;
  description: string | null;
  /** The carrier the quote names, else the provider's code. */
  carrier: string;
  amount: number;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  taxClassId: string | null;
  /** Kept with the order for providers that book shipments. */
  details?: ShippingRateDetails | null;
};

const amounts = z.record(z.string().regex(/^[A-Z]{3}$/), z.number().int().nonnegative());
const builtInConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flat_rate"), amounts, per: z.enum(["order", "item"]).default("order") }),
  z.object({ kind: z.literal("table_rate"), basis: z.enum(["weight", "subtotal", "quantity"]), tiers: z.array(z.object({ from: z.number().nonnegative(), amounts })).min(1) }),
  z.object({ kind: z.literal("free"), minimumSubtotals: amounts }),
]);

const methodSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()).default({}),
  zoneId: z.uuid(),
  channelIds: z.array(z.uuid()).default([]),
  // Checked by parseConfig, against the provider's options.
  config: z.looseObject({ kind: z.string().min(1) }),
  minDeliveryDays: z.number().int().nonnegative().nullable().optional(),
  maxDeliveryDays: z.number().int().nonnegative().nullable().optional(),
  taxClassId: z.uuid().nullable().optional(),
  isActive: z.boolean().default(true),
  position: z.number().int().default(0),
});

export const createShippingZone = async (db: Database, input: unknown) => {
  const data = parseInput(z.object({ name: z.string().min(1), countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1) }), input);
  const [row] = await db.insert(shippingZones).values(data).returning();
  return row!;
};

/** A provider not yet set up is accepted; its methods offer rates once it is active. */
const parseConfig = (config: { kind: string; options?: unknown }, registry: ShippingProviderRegistry): ShippingMethodConfig => {
  if (BUILT_IN_SHIPPING_KINDS.has(config.kind)) return parseInput(builtInConfigSchema, config, ["input", "config"]);
  const provider = registry.get(config.kind);
  if (!provider) throw new ValidationError("Unknown shipping provider", [{ path: ["input", "config", "kind"], message: `Not one of ${[...registry.keys()].join(", ")}` }]);
  return { kind: provider.code, options: parseProviderOptions(provider.methodOptions ?? {}, config.options, ["input", "config", "options"]) };
};

/** Pass platform.shipping as `registry` to accept plugin providers' configs. */
export const createShippingMethod = async (db: Database, input: unknown, registry: ShippingProviderRegistry = createShippingRegistry()) => {
  const data = parseInput(methodSchema, input);
  const [row] = await db.insert(shippingMethods).values({ ...data, config: parseConfig(data.config, registry) }).returning();
  return row!;
};

export const updateShippingMethod = async (db: Database, id: string, input: unknown, registry: ShippingProviderRegistry = createShippingRegistry()) => {
  const existing = await db.query.shippingMethods.findFirst({ where: eq(shippingMethods.id, id) });
  if (!existing) throw new NotFoundError("ShippingMethod", id);
  const patch = input as { config?: unknown };
  const data = parseInput(methodSchema, { ...existing, ...patch, code: existing.code });
  // An unchanged config is kept as is, even if its plugin has since been removed.
  const config = patch.config !== undefined ? parseConfig(data.config, registry) : existing.config;
  const [row] = await db.update(shippingMethods).set({ ...data, config, updatedAt: new Date() }).where(eq(shippingMethods.id, id)).returning();
  return row!;
};

export const listShippingMethods = (db: Database) => db.query.shippingMethods.findMany({ orderBy: asc(shippingMethods.position) });
export const findShippingMethodByCode = (db: Database, code: string) => db.query.shippingMethods.findFirst({ where: eq(shippingMethods.code, code) });
export const listShippingZones = (db: Database) => db.query.shippingZones.findMany({ orderBy: asc(shippingZones.name) });

export const updateShippingZone = async (db: Database, id: string, input: unknown) => {
  const data = parseInput(z.object({ name: z.string().min(1).optional(), countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).optional() }), input);
  const [row] = await db.update(shippingZones).set(data).where(eq(shippingZones.id, id)).returning();
  if (!row) throw new NotFoundError("ShippingZone", id);
  return row;
};

/** Refused while the zone has methods, rather than cascading to them. */
export const deleteShippingZone = async (db: Database, id: string) =>
  db.transaction(async (tx) => {
    const methods = await tx.select({ code: shippingMethods.code }).from(shippingMethods).where(eq(shippingMethods.zoneId, id));
    if (methods.length) throw new InvalidStateError(`The zone still has methods: ${methods.map((m) => m.code).join(", ")}`);
    const [row] = await tx.delete(shippingZones).where(eq(shippingZones.id, id)).returning({ id: shippingZones.id });
    if (!row) throw new NotFoundError("ShippingZone", id);
    return id;
  });

/** Orders keep a snapshot of their method, so deleting one does not affect them. */
export const deleteShippingMethod = async (db: Database, id: string) => {
  const [row] = await db.delete(shippingMethods).where(eq(shippingMethods.id, id)).returning({ id: shippingMethods.id });
  if (!row) throw new NotFoundError("ShippingMethod", id);
  return id;
};
