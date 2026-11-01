import type { Redis } from "ioredis";
import type { RedisConnection } from "../../src/lib/redis.ts";

type Entry = { value: string; expiresAt: number };
type SetEntry = { members: Set<string>; expiresAt: number };

/** In-memory stand-in for the ioredis commands the platform uses; clients share one server. */
export class FakeRedisServer {
  strings = new Map<string, Entry>();
  sets = new Map<string, SetEntry>();
  clients = new Set<FakeRedisClient>();
  /** Every command any client ran, e.g. ["get", "key"]. */
  commands: string[][] = [];
  now = () => Date.now();

  client() {
    const client = new FakeRedisClient(this);
    this.clients.add(client);
    return client;
  }

  /** A RedisConnection like createRedisConnection's, plus its fake clients. */
  connection(prefix = "test:") {
    const client = this.client();
    let subscriber: FakeRedisClient | null = null;
    const connection: RedisConnection = {
      client: client as unknown as Redis,
      subscriber: () => (subscriber ??= this.client()) as unknown as Redis,
      prefix,
      close: async () => {
        client.disconnect();
        subscriber?.disconnect();
      },
    };
    return { connection, client, subscriber: () => subscriber };
  }

  live<T extends { expiresAt: number }>(map: Map<string, T>, key: string): T | undefined {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  ttl(key: string) {
    const entry = this.live(this.strings, key) ?? this.live(this.sets, key);
    return entry ? entry.expiresAt - this.now() : -2;
  }

  run(command: string[]): unknown {
    this.commands.push(command);
    const [name, ...args] = command as [string, ...string[]];
    switch (name) {
      case "get":
        return this.live(this.strings, args[0]!)?.value ?? null;
      case "set": {
        const [key, value, unit, ms] = args;
        if (unit !== "PX") throw new Error("fake redis: SET supports PX only");
        this.strings.set(key!, { value: value!, expiresAt: this.now() + Number(ms) });
        return "OK";
      }
      case "sadd": {
        const [key, ...members] = args;
        const entry = this.live(this.sets, key!) ?? { members: new Set<string>(), expiresAt: Number.POSITIVE_INFINITY };
        this.sets.set(key!, entry);
        const before = entry.members.size;
        for (const m of members) entry.members.add(m);
        return entry.members.size - before;
      }
      case "pexpire": {
        const entry = this.live(this.strings, args[0]!) ?? this.live(this.sets, args[0]!);
        if (!entry) return 0;
        entry.expiresAt = this.now() + Number(args[1]);
        return 1;
      }
      case "smembers":
        return [...(this.live(this.sets, args[0]!)?.members ?? [])];
      case "del": {
        let removed = 0;
        for (const key of args) removed += Number(this.strings.delete(key)) + Number(this.sets.delete(key));
        return removed;
      }
      case "publish": {
        let receivers = 0;
        for (const client of this.clients) {
          if (!client.channels.has(args[0]!)) continue;
          receivers++;
          queueMicrotask(() => client.emit("message", args[0]!, args[1]!));
        }
        return receivers;
      }
      default:
        throw new Error(`fake redis: unsupported command ${name}`);
    }
  }
}

type Listener = (...args: any[]) => void;

export class FakeRedisClient {
  status = "ready";
  channels = new Set<string>();
  /** Make every command fail with this error, as a dropped connection would. */
  failure: Error | null = null;
  private listeners = new Map<string, Listener[]>();
  private server: FakeRedisServer;
  constructor(server: FakeRedisServer) {
    this.server = server;
  }

  private exec<T>(command: string[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    try {
      return Promise.resolve(this.server.run(command) as T);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  get(key: string) {
    return this.exec<string | null>(["get", key]);
  }
  del(...keys: string[]) {
    return this.exec<number>(["del", ...keys]);
  }
  publish(channel: string, message: string) {
    return this.exec<number>(["publish", channel, message]);
  }
  async subscribe(...channels: string[]) {
    if (this.failure) throw this.failure;
    for (const c of channels) this.channels.add(c);
    return this.channels.size;
  }
  async unsubscribe(...channels: string[]) {
    for (const c of channels) this.channels.delete(c);
    return this.channels.size;
  }
  multi() {
    const queued: string[][] = [];
    const chain = {
      set: (key: string, value: string, unit: string, ms: number) => (queued.push(["set", key, value, unit, String(ms)]), chain),
      sadd: (key: string, ...members: string[]) => (queued.push(["sadd", key, ...members]), chain),
      pexpire: (key: string, ms: number) => (queued.push(["pexpire", key, String(ms)]), chain),
      smembers: (key: string) => (queued.push(["smembers", key]), chain),
      del: (...keys: string[]) => (queued.push(["del", ...keys]), chain),
      exec: async () => {
        if (this.failure) throw this.failure;
        return queued.map((command): [Error | null, unknown] => {
          try {
            return [null, this.server.run(command)];
          } catch (error) {
            return [error as Error, null];
          }
        });
      },
    };
    return chain;
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  disconnect() {
    this.status = "end";
    this.server.clients.delete(this);
  }
  async quit() {
    this.disconnect();
    return "OK";
  }
}
