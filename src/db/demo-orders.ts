import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildQuote } from "../modules/carts/quote.ts";
import { createCart, setCartBillingAddress, setCartPaymentMethod, setCartShippingAddress, setCartShippingMethod } from "../modules/carts/service.ts";
import { productChannelListings, products, productVariants } from "../modules/catalog/tables.ts";
import { findChannelByCode, resolveScope } from "../modules/channels/service.ts";
import { placeOrder } from "../modules/checkout/service.ts";
import { registerCustomer } from "../modules/customers/service.ts";
import { customers } from "../modules/customers/tables.ts";
import { processOutbox } from "../modules/integrations/worker.ts";
import { orderEvents, orderLines, orders } from "../modules/orders/tables.ts";
import { cancelOrder, capturePayment, fulfillOrder, refundOrder, type Actor } from "../modules/orders/service.ts";
import { staffUsers } from "../modules/staff/tables.ts";
import type { Platform } from "../platform.ts";

const ADDRESSES: Record<"us" | "eu", Record<string, string>[]> = {
  us: [
    { firstName: "Jordan", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" },
    { firstName: "Sam", lastName: "Patel", line1: "11 W 53rd St", city: "New York", regionCode: "NY", postalCode: "10019", countryCode: "US" },
    { firstName: "Riley", lastName: "Chen", line1: "1 Congress Ave", city: "Austin", regionCode: "TX", postalCode: "78701", countryCode: "US" },
    { firstName: "Morgan", lastName: "Diaz", line1: "400 Broad St", city: "Seattle", regionCode: "WA", postalCode: "98109", countryCode: "US" },
    { firstName: "Casey", lastName: "Nguyen", line1: "100 Queen St W", city: "Toronto", regionCode: "ON", postalCode: "M5H 2N2", countryCode: "CA" },
  ],
  eu: [
    { firstName: "Lena", lastName: "Fischer", line1: "Unter den Linden 10", city: "Berlin", postalCode: "10117", countryCode: "DE" },
    { firstName: "Camille", lastName: "Martin", line1: "12 Rue de Rivoli", city: "Paris", postalCode: "75004", countryCode: "FR" },
    { firstName: "Jonas", lastName: "Gruber", line1: "Kärntner Straße 5", city: "Wien", postalCode: "1010", countryCode: "AT" },
    { firstName: "Daan", lastName: "de Vries", line1: "Damrak 1", city: "Amsterdam", postalCode: "1012 LG", countryCode: "NL" },
    { firstName: "Olivia", lastName: "Brown", line1: "10 Downing St", city: "London", postalCode: "SW1A 2AA", countryCode: "GB" },
  ],
};

const NAMES = [
  ["Avery", "Chen"], ["Blake", "Okafor"], ["Charlie", "Novak"], ["Dakota", "Reyes"], ["Emerson", "Lindqvist"], ["Finley", "Murphy"], ["Harper", "Nakamura"], ["Indigo", "Silva"],
  ["Jesse", "Kowalski"], ["Kai", "Haddad"], ["Logan", "Brennan"], ["Marlowe", "Dubois"], ["Noel", "Fischer"], ["Oakley", "Patel"], ["Parker", "Moreau"], ["Quinn", "Adeyemi"],
] as const;

/**
 * `count` orders over the last 90 days: placed through the real checkout, captured, shipped,
 * refunded or canceled as staff would, then backdated. Needs the demo us and eu channels.
 */
export const seedDemoOrders = async (platform: Platform, count = 80): Promise<{ placed: number; skipped: string[] }> => {
  const { db } = platform;

  // Deterministic, so repeated runs on fresh databases produce the same history.
  let state = 20261026;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;

  const channels = { us: await findChannelByCode(db, "us"), eu: await findChannelByCode(db, "eu") };
  if (!channels.us || !channels.eu) throw new Error("Demo orders need the demo data's us and eu channels.");

  const admin = await db.query.staffUsers.findFirst({ where: eq(staffUsers.isActive, true), orderBy: staffUsers.createdAt });
  const staff: Actor = admin ? { type: "staff", id: admin.id } : { type: "system", id: null };

  const demoCustomers = [];
  for (const [firstName, lastName] of NAMES) {
    const email = `${firstName.toLowerCase()}.demo@example.com`;
    const existing = await db.query.customers.findFirst({ where: eq(customers.email, email) });
    demoCustomers.push(existing ?? (await registerCustomer(db, { email, password: randomBytes(18).toString("base64url"), firstName, lastName, acceptsMarketing: random() < 0.5 })));
  }

  const sellable = async (channelId: string) =>
    db
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(productChannelListings, and(eq(productChannelListings.productId, products.id), eq(productChannelListings.channelId, channelId)))
      .where(and(eq(products.status, "active"), eq(productVariants.isActive, true), eq(productChannelListings.isPublished, true)));
  const variants = { us: await sellable(channels.us.id), eu: await sellable(channels.eu.id) };

  // Skewed towards recent days, and placed oldest first so the time-ordered ids agree with the
  // backdated dates.
  const ages = Array.from({ length: count }, () => Math.floor(89 * random() ** 1.6)).sort((a, b) => b - a);

  let placed = 0;
  const skipped: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = random() < 0.7 ? "us" : "eu";
    const scope = await resolveScope(db, { channel: code, currency: code === "eu" && random() < 0.25 ? "GBP" : null });
    const customer = random() < 0.75 ? pick(demoCustomers) : null;
    const actor = { customerId: customer?.id ?? null };
    const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ variantId: pick(variants[code]).id, quantity: 1 + Math.floor(random() * 2) }));
    const unique = [...new Map(lines.map((l) => [l.variantId, l])).values()];
    try {
      const cart = await createCart(db, scope, actor, { email: customer ? null : `guest${i}@example.com`, lines: unique });
      await setCartShippingAddress(db, cart.id, { address: pick(ADDRESSES[code]) }, actor);
      await setCartBillingAddress(db, cart.id, { sameAsShipping: true }, actor);
      const quote = await buildQuote(db, cart.id);
      const rate = quote.shippingRates[0];
      if (!rate) throw new Error("no shipping rate");
      await setCartShippingMethod(db, cart.id, rate.code, actor);
      const methods = (await buildQuote(db, cart.id)).paymentMethods.map((m) => m.code);
      await setCartPaymentMethod(db, cart.id, methods.includes("card") && random() < 0.7 ? "card" : pick(methods), actor);
      const order = await placeOrder(platform, { cartId: cart.id, idempotencyKey: `demo-${i}` }, actor);

      const roll = random();
      if (roll < 0.08 && order.paymentStatus !== "paid") {
        await cancelOrder(platform, order.id, { reason: "Customer request" }, staff);
      } else if (roll < 0.9) {
        // Instant-capture cards are paid at checkout.
        if (order.paymentStatus !== "paid") await capturePayment(platform, order.id, {}, staff);
        if (roll < 0.8) await fulfillOrder(db, order.id, { tracking: [{ carrier: "UPS", number: `1Z${randomBytes(6).toString("hex").toUpperCase()}` }] }, staff);
        if (roll < 0.1) {
          const [line] = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id)).limit(1);
          if (line) await refundOrder(platform, order.id, { lines: [{ orderLineId: line.id, quantity: 1, restock: true }], reason: "Did not fit" }, staff);
        }
      }

      const shift = sql`(${ages[i]!} * interval '1 day' + ${Math.floor(random() * 3_600)} * interval '1 second')`;
      await db.update(orders).set({ placedAt: sql`${orders.placedAt} - ${shift}`, createdAt: sql`${orders.createdAt} - ${shift}` }).where(eq(orders.id, order.id));
      await db.update(orderEvents).set({ createdAt: sql`${orderEvents.createdAt} - ${shift}` }).where(eq(orderEvents.orderId, order.id));
      placed++;
    } catch (error) {
      skipped.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Spread the demo accounts' sign-up dates too, so the customer report has a shape.
  await db.execute(sql`update customers set created_at = now() - (random() * 120 * interval '1 day') where email like '%.demo@example.com'`);
  while ((await processOutbox(platform)) > 0) {
    // drain events so webhooks and projections see the history
  }
  return { placed, skipped };
};
