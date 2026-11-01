import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { RedisConnection } from "./redis.ts";

type Listener = EventListenerOrEventListenerObject;

/**
 * An EventTarget over Redis pub/sub, for graphql-yoga's createPubSub. Local listeners get events
 * directly, and this process's own echo from Redis is dropped. Details must survive JSON. Delivery
 * is at most once: a process not subscribed at publish time misses the event.
 */
export const createRedisEventTarget = (redis: RedisConnection, options: { logger?: Logger; keepAlive?: (promise: Promise<unknown>) => void } = {}): EventTarget => {
  const origin = randomUUID();
  const channelPrefix = `${redis.prefix}events:`;
  const listeners = new Map<string, Set<Listener>>();
  let subscribed = false;

  const fail = (message: string) => (err: unknown) => options.logger?.warn({ err: { message: (err as Error).message } }, message);

  const deliver = (type: string, detail: unknown) => {
    const targets = listeners.get(type);
    if (!targets?.size) return;
    const event = new CustomEvent(type, { detail });
    for (const listener of [...targets]) {
      try {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      } catch (err) {
        options.logger?.error({ err }, "event listener failed");
      }
    }
  };

  const subscriber = () => {
    const connection = redis.subscriber();
    if (!subscribed) {
      subscribed = true;
      // On (re)connect, subscribe every channel, including any whose SUBSCRIBE failed while down.
      connection.on("ready", () => {
        const channels = [...listeners.keys()].map((type) => channelPrefix + type);
        if (channels.length) connection.subscribe(...channels).catch(fail("redis subscribe failed"));
      });
      connection.on("message", (channel: string, message: string) => {
        if (!channel.startsWith(channelPrefix)) return;
        let parsed: { origin?: string; detail?: unknown };
        try {
          parsed = JSON.parse(message) as { origin?: string; detail?: unknown };
        } catch {
          return;
        }
        if (parsed.origin === origin) return;
        deliver(channel.slice(channelPrefix.length), parsed.detail ?? null);
      });
    }
    return connection;
  };

  const target: EventTarget = {
    addEventListener(type: string, listener: Listener | null) {
      if (!listener) return;
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
        subscriber().subscribe(channelPrefix + type).catch(fail("redis subscribe failed"));
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: Listener | null) {
      const set = listeners.get(type);
      if (!set || !listener) return;
      set.delete(listener);
      if (set.size === 0) {
        listeners.delete(type);
        subscriber().unsubscribe(channelPrefix + type).catch(fail("redis unsubscribe failed"));
      }
    },
    dispatchEvent(event: Event) {
      const detail = (event as CustomEvent).detail ?? null;
      deliver(event.type, detail);
      const published = redis.client.publish(channelPrefix + event.type, JSON.stringify({ origin, detail })).catch(fail("redis publish failed"));
      options.keepAlive?.(published);
      return true;
    },
  };
  return target;
};
