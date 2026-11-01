import { asc } from "drizzle-orm";
import type { Database } from "../../db/client.ts";
import type { PluginChannel } from "../../plugins/sdk.ts";
import { builderFrontends } from "../builder/tables.ts";
import type { Channel } from "../channels/service.ts";

/** The channel's own storefront, else the default one if it serves every channel. */
export const storefrontUrlOf = async (db: Database, channel: Pick<Channel, "id">): Promise<string | null> => {
  const storefronts = await db.select().from(builderFrontends).orderBy(asc(builderFrontends.createdAt));
  const storefront = storefronts.find((f) => f.defaultChannelId === channel.id) ?? storefronts.find((f) => f.isDefault && !f.defaultChannelId) ?? null;
  return storefront?.url ?? null;
};

export const toPluginChannel = async (db: Database, channel: Channel): Promise<PluginChannel> => ({
  id: channel.id,
  code: channel.code,
  name: channel.name,
  defaultLocale: channel.defaultLocale,
  storefrontUrl: await storefrontUrlOf(db, channel),
});
