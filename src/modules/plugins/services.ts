import { asc, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { isUuid } from "../../lib/ids.ts";
import type { PluginServices } from "../../plugins/sdk.ts";
import { carts } from "../carts/tables.ts";
import { findChannelByCode, listChannels } from "../channels/service.ts";
import { channels } from "../channels/tables.ts";
import { customers } from "../customers/tables.ts";
import { emit } from "../integrations/outbox.ts";
import { getOrder, toPluginOrder } from "../orders/read.ts";
import { appendOrderEvent, orderEvent } from "../orders/service.ts";
import { orders } from "../orders/tables.ts";
import { shipFromLocation } from "../shipping/rates.ts";
import { getPluginProduct, listPluginProducts } from "./catalog.ts";
import { toPluginChannel } from "./channels.ts";

/** PluginContext.services, with writes attributed to the plugin. */
export const createPluginServices = (db: Database, plugin: string, options: { defaultChannelCode?: string } = {}): PluginServices => ({
  orders: {
    get: async (id) => {
      const order = isUuid(id) ? await db.query.orders.findFirst({ where: eq(orders.id, id) }) : undefined;
      return order ? toPluginOrder(db, order) : null;
    },
    getByNumber: async (number) => {
      const order = await db.query.orders.findFirst({ where: eq(orders.number, number) });
      return order ? toPluginOrder(db, order) : null;
    },
    addNote: async (orderId, message) => {
      const text = typeof message === "string" ? message.trim().slice(0, 5000) : "";
      if (!text) throw new ValidationError("The note is empty", [{ path: ["message"], message: "Write a note" }]);
      if (!isUuid(orderId)) throw new NotFoundError("Order", orderId);
      await db.transaction(async (tx) => {
        const order = await getOrder(tx, orderId);
        // Order history has no plugin actor: a system entry that names the plugin.
        await appendOrderEvent(tx, orderId, { type: "note", message: text, actor: { type: "system", id: null }, data: { plugin } });
        await emit(tx, orderEvent("order.note_added", order, { plugin }));
      });
    },
  },
  customers: {
    get: async (id) => {
      if (!isUuid(id)) return null;
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, id) });
      if (!customer) return null;
      // Customers have no locale of their own: the one they last shopped in.
      const [order] = await db.select({ locale: orders.locale }).from(orders).where(eq(orders.customerId, id)).orderBy(desc(orders.placedAt)).limit(1);
      const [cart] = order ? [] : await db.select({ locale: carts.locale }).from(carts).where(eq(carts.customerId, id)).orderBy(desc(carts.updatedAt)).limit(1);
      return {
        id: customer.id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        locale: order?.locale ?? cart?.locale ?? null,
        phone: customer.phone,
        acceptsMarketing: customer.acceptsMarketing,
      };
    },
  },
  catalog: {
    getProduct: (id, scope) => getPluginProduct(db, id, scope),
    listProducts: (scope) => listPluginProducts(db, scope),
  },
  channels: {
    get: async (id) => {
      const channel = isUuid(id) ? await db.query.channels.findFirst({ where: eq(channels.id, id) }) : undefined;
      return channel ? toPluginChannel(db, channel) : null;
    },
    getByCode: async (code) => {
      const channel = typeof code === "string" && code ? await findChannelByCode(db, code) : undefined;
      return channel ? toPluginChannel(db, channel) : null;
    },
    list: async () => Promise.all((await listChannels(db)).filter((c) => c.isActive).map((c) => toPluginChannel(db, c))),
    // As resolveScope picks it for requests without a channel.
    getDefault: async () => {
      const code = options.defaultChannelCode;
      const channel = code
        ? await db.query.channels.findFirst({ where: eq(channels.code, code) })
        : await db.query.channels.findFirst({ where: eq(channels.isActive, true), orderBy: asc(channels.createdAt) });
      return channel ? toPluginChannel(db, channel) : null;
    },
  },
  locations: {
    // The origin shipping rates are quoted from, so plugins and rate requests agree.
    shipFrom: async (channelId) => (isUuid(channelId) && (await db.query.channels.findFirst({ where: eq(channels.id, channelId) })) ? shipFromLocation(db, channelId) : null),
  },
});
