import { eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { Config } from "../../config.ts";
import type { Database } from "../../db/client.ts";
import { deriveKey, openSecret, sealSecret } from "../../lib/crypto.ts";
import { InvalidStateError, NotFoundError, ValidationError } from "../../lib/errors.ts";
import { isUuid } from "../../lib/ids.ts";
import type { Platform } from "../../platform.ts";
import type { AnyPluginDefinition, CheckoutIssue, PluginContext, PluginErrorReport } from "../../plugins/sdk.ts";
import { emitPluginEvents, registerPluginEventTypes } from "../integrations/outbox.ts";
import { localPublicBase } from "../media/storage.ts";
import type { PaymentProvider } from "../payments/providers.ts";
import { bindShippingProvider, type ShippingProvider } from "../shipping/providers.ts";
import { registerPluginPermissions } from "../staff/service.ts";
import { createKeyValueStore, runOnce } from "./kv.ts";
import { bindPaymentProvider } from "./providers.ts";
import { validatePluginDefinitions } from "./registry.ts";
import { createPluginServices } from "./services.ts";
import { applySettingsUpdate, resolveSettings, settingsOf, type Env, type ResolvedSettings, type StoredSettings } from "./settings.ts";
import { pluginSettings } from "./tables.ts";
import { errorMessage, withTimeout } from "./timeout.ts";
import type { PluginRuntime, PluginStatus } from "./types.ts";

/** Settings older than this are re-read in the background. */
export const STATE_TTL_MS = 5_000;
export const CHECKOUT_HOOK_TIMEOUT_MS = 5_000;
export const ERROR_HOOK_TIMEOUT_MS = 5_000;
export const CHECK_TIMEOUT_MS = 15_000;

type PluginState = ResolvedSettings & {
  enabled: boolean;
  stored: StoredSettings;
  /** The settings could not be read (no table yet, database down): inactive until they can. */
  unavailable: boolean;
  /** Epoch ms of the last save (0: no row). An unchanged row keeps its state and context. */
  savedAt: number;
};

const isActiveState = (state: PluginState) => state.enabled && state.missing.length === 0 && !state.unavailable;


export type PluginRuntimeDeps = {
  db: Database;
  config: Config;
  logger: Logger;
  fetch: typeof fetch;
  /** Where settings' `env` overrides are read: process.env by default. */
  env?: Env;
  /** Backs PluginContext.platform; a function because the platform is built later. */
  platform: () => Platform;
  /** Payment providers passed to createPlatform, which plugin providers must not shadow. */
  paymentProviderCodes?: readonly string[];
  /** Keeps unawaited work (onError hooks) alive, e.g. Vercel's waitUntil. */
  keepAlive?: (promise: Promise<unknown>) => void;
};

/** Events, tasks, routes and migrations live in sibling files; GraphQL in src/graphql/schema.ts. */
export const createPluginRuntime = (definitions: readonly AnyPluginDefinition[], deps: PluginRuntimeDeps): PluginRuntime => {
  validatePluginDefinitions(definitions, { paymentProviderCodes: deps.paymentProviderCodes });
  registerPluginPermissions(definitions.flatMap((d) => (d.permissions ?? []).map((p) => ({ code: p.code, description: p.description, plugin: d.name, pluginTitle: d.title }))));
  registerPluginEventTypes(definitions.flatMap((d) => d.emits ?? []));

  const { db, config, logger } = deps;
  const env = deps.env ?? process.env;
  const byName = new Map(definitions.map((d) => [d.name, d]));
  const names = definitions.map((d) => d.name);
  const secretKey = deriveKey(config.jwtSecret, "plugin-settings");

  const warned = new Set<string>();
  const warnOnce = (plugin: string, message: string) => {
    if (warned.has(`${plugin}:${message}`)) return;
    warned.add(`${plugin}:${message}`);
    logger.warn({ plugin }, `Plugin ${plugin}: ${message}`);
  };

  const openSecrets = (plugin: string, sealed: string): Record<string, string> => {
    try {
      const secrets = JSON.parse(openSecret(secretKey, sealed)) as unknown;
      return secrets && typeof secrets === "object" ? (secrets as Record<string, string>) : {};
    } catch {
      warnOnce(plugin, "its secret settings cannot be decrypted (did JWT_SECRET change?); enter them again under Settings › Plugins");
      return {};
    }
  };

  const stateFrom = (definition: AnyPluginDefinition, row: typeof pluginSettings.$inferSelect | undefined): PluginState => {
    const stored: StoredSettings = { values: row?.values ?? {}, secrets: row?.secrets ? openSecrets(definition.name, row.secrets) : {} };
    return {
      ...resolveSettings(settingsOf(definition), stored, env, (message) => warnOnce(definition.name, message)),
      enabled: row?.enabled ?? true,
      stored,
      unavailable: false,
      savedAt: row?.updatedAt.getTime() ?? 0,
    };
  };

  const unavailable = (definition: AnyPluginDefinition): PluginState => {
    const stored = { values: {}, secrets: {} };
    return { ...resolveSettings(settingsOf(definition), stored, {}, () => {}), enabled: false, stored, unavailable: true, savedAt: -1 };
  };

  // ------------------------------------------------------------ state cache

  /**
   * After the first load, reads never wait on the database: providers run while checkout holds a
   * transaction, and a second connection could exhaust the pool or, on PGlite, never run.
   */
  const entries = new Map<string, { state: PluginState; at: number }>();
  /** Save count per plugin, so a load that overlapped a save does not overwrite it. */
  const saves = new Map<string, number>();
  let inflight: { promise: Promise<void>; startedAt: number } | null = null;
  let failing = false;

  const load = async (only: readonly string[]) => {
    if (only.length === 0) return;
    const before = new Map(only.map((name) => [name, saves.get(name) ?? 0]));
    const rows = await db.select().from(pluginSettings).where(inArray(pluginSettings.plugin, [...only]));
    const at = Date.now();
    for (const name of only) {
      if ((saves.get(name) ?? 0) !== before.get(name)) continue;
      const row = rows.find((r) => r.plugin === name);
      const current = entries.get(name);
      if (current && !current.state.unavailable && current.state.savedAt === (row?.updatedAt.getTime() ?? 0)) current.at = at;
      else entries.set(name, { state: stateFrom(byName.get(name)!, row), at });
    }
    if (failing) logger.info("Plugin settings are readable again");
    failing = false;
  };

  const refresh = (): Promise<void> => {
    if (inflight && Date.now() - inflight.startedAt < 30_000) return inflight.promise;
    const promise = load(names)
      .catch((error: unknown) => {
        if (!failing) logger.error({ err: error }, "Reading plugin settings failed: plugins keep their last known state, or stay inactive");
        failing = true;
        const at = Date.now();
        for (const definition of definitions) {
          const entry = entries.get(definition.name);
          if (entry) entry.at = at;
          else entries.set(definition.name, { state: unavailable(definition), at });
        }
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { promise, startedAt: Date.now() };
    return promise;
  };

  const peek = async (name: string): Promise<PluginState> => {
    let entry = entries.get(name);
    if (!entry) {
      await refresh();
      entry = entries.get(name)!;
    } else if (Date.now() - entry.at > STATE_TTL_MS) {
      void refresh();
    }
    return entry.state;
  };

  // ------------------------------------------------------------ contexts

  const contexts = new WeakMap<PluginState, PluginContext>();
  const loggers = new Map<string, Logger>();

  const buildContext = (definition: AnyPluginDefinition, state: PluginState): PluginContext => {
    const name = definition.name;
    const kv = createKeyValueStore(db, name);
    const emits = new Set(definition.emits ?? []);
    let child = loggers.get(name);
    if (!child) loggers.set(name, (child = logger.child({ plugin: name })));
    return {
      plugin: { name, version: definition.version },
      settings: Object.freeze({ ...state.values }) as PluginContext["settings"],
      db,
      logger: child,
      kv,
      fetch: deps.fetch,
      once: (key, fn) => runOnce(kv, key, fn),
      emit: async (event, tx) => {
        if (!emits.has(event.type)) throw new InvalidStateError(`The plugin ${name} does not declare the event ${event.type}: add it to emits`);
        if (!event.aggregateType || !isUuid(event.aggregateId)) {
          throw new ValidationError("The event is invalid", [{ path: ["aggregateId"], message: "Events need an aggregateType and the UUID of the entity they are about" }]);
        }
        await emitPluginEvents(tx ?? db, [{ type: event.type, aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: event.payload ?? {} }]);
      },
      services: createPluginServices(db, name, { defaultChannelCode: config.defaultChannelCode }),
      // Same base as media URLs: MEDIA_PUBLIC_URL, else ADMIN_URL without /admin, else localhost.
      urls: { admin: config.admin.url, api: localPublicBase(env, config, "") },
      production: config.production,
      get platform() {
        return deps.platform();
      },
    };
  };

  /** One context per settings state, shared until the settings change. */
  const contextFor = (definition: AnyPluginDefinition, state: PluginState) => {
    let ctx = contexts.get(state);
    if (!ctx) contexts.set(state, (ctx = buildContext(definition, state)));
    return ctx;
  };

  const labels = (definition: AnyPluginDefinition, keys: string[]) => keys.map((k) => settingsOf(definition)[k]?.label ?? k).join(", ");

  const inactiveReason = (definition: AnyPluginDefinition, state: PluginState) => {
    if (state.unavailable) return "its settings cannot be read";
    if (!state.enabled) return "it is disabled";
    if (state.missing.length) return `it is not configured (missing ${labels(definition, state.missing)})`;
    return null;
  };

  const context = async (name: string): Promise<PluginContext> => {
    const definition = byName.get(name);
    if (!definition) throw new InvalidStateError(`No plugin named ${name} is installed`);
    const state = await peek(name);
    const reason = inactiveReason(definition, state);
    if (reason) throw new InvalidStateError(`The plugin ${name} is not active: ${reason}. See Settings › Plugins.`);
    return contextFor(definition, state);
  };

  const isActive = async (name: string) => byName.has(name) && isActiveState(await peek(name));

  // ------------------------------------------------------------ hooks and lifecycle

  const issuesFrom = (plugin: string, value: unknown): CheckoutIssue[] => {
    if (!Array.isArray(value)) {
      logger.error({ plugin }, "checkoutValidate returned something other than an array of issues; ignored");
      return [];
    }
    return value.flatMap((issue: Partial<CheckoutIssue> | null) =>
      issue && typeof issue.code === "string" && typeof issue.message === "string"
        ? [{ code: issue.code, message: issue.message, ...(Array.isArray(issue.field) ? { field: issue.field.map(String) } : {}) }]
        : [],
    );
  };

  /**
   * Fails open: a plugin that throws or times out is ignored, so one broken plugin cannot stop
   * every sale. Plugins that must refuse orders reliably should keep their checks local.
   */
  const checkoutValidate: PluginRuntime["checkoutValidate"] = async (input) => {
    const hooked = definitions.filter((d) => d.hooks?.checkoutValidate);
    const results = await Promise.all(
      hooked.map(async (definition) => {
        try {
          const state = await peek(definition.name);
          if (!isActiveState(state)) return [];
          const issues = await withTimeout(definition.hooks!.checkoutValidate!(input, contextFor(definition, state)), CHECKOUT_HOOK_TIMEOUT_MS, `${definition.name} checkoutValidate`);
          return issuesFrom(definition.name, issues);
        } catch (error) {
          logger.error({ err: error, plugin: definition.name }, "checkoutValidate failed; ignoring the plugin for this checkout (fail open)");
          void reportError(error, { source: "plugin-hook", plugin: definition.name, details: { hook: "checkoutValidate" } });
          return [];
        }
      }),
    );
    return results.flat();
  };

  /** Errors thrown by onError hooks are only logged, so a broken reporter cannot loop. */
  const reportError: PluginRuntime["reportError"] = (error, where) => {
    const hooked = definitions.filter((d) => d.hooks?.onError);
    if (hooked.length === 0) return Promise.resolve();
    const report: PluginErrorReport = {
      source: where.source,
      error: { name: error instanceof Error ? error.name : "Error", message: errorMessage(error), stack: error instanceof Error ? (error.stack ?? null) : null },
      plugin: where.plugin ?? null,
      details: where.details ?? {},
      occurredAt: new Date(),
    };
    const work = Promise.all(
      hooked.map(async (definition) => {
        try {
          const state = await peek(definition.name);
          if (!isActiveState(state)) return;
          await withTimeout(definition.hooks!.onError!(report, contextFor(definition, state)), ERROR_HOOK_TIMEOUT_MS, `${definition.name} onError`);
        } catch (hookError) {
          logger.error({ err: hookError, plugin: definition.name }, "onError failed; the error it was given is not reported again");
        }
      }),
    ).then(() => undefined);
    deps.keepAlive?.(work);
    return work;
  };

  const started = new Set<string>();
  const runOnStart = async (definition: AnyPluginDefinition, state: PluginState) => {
    if (!definition.onStart || started.has(definition.name)) return;
    started.add(definition.name);
    try {
      await definition.onStart(contextFor(definition, state));
    } catch (error) {
      logger.error({ err: error, plugin: definition.name }, "Plugin onStart failed");
      void reportError(error, { source: "plugin-start", plugin: definition.name });
    }
  };

  const start = async () => {
    await Promise.all(
      definitions.map(async (definition) => {
        const state = await peek(definition.name);
        if (isActiveState(state)) await runOnStart(definition, state);
      }),
    );
  };

  // ------------------------------------------------------------ administration

  const toStatus = (definition: AnyPluginDefinition, state: PluginState): PluginStatus => ({
    name: definition.name,
    enabled: state.enabled,
    configured: state.missing.length === 0 && !state.unavailable,
    active: isActiveState(state),
    missing: [...state.missing],
    settings: Object.entries(settingsOf(definition)).map(([key, field]) => ({
      key,
      field,
      value: field.type === "secret" ? null : (state.values[key] ?? null),
      isSet: state.values[key] !== undefined,
      source: state.sources[key] ?? "unset",
    })),
  });

  const requirePlugin = (name: string) => {
    const definition = byName.get(name);
    if (!definition) throw new NotFoundError("Plugin", name);
    return definition;
  };

  const status = async (name: string, options: { fresh?: boolean } = {}) => {
    const definition = requirePlugin(name);
    if (options.fresh) await load([name]);
    return toStatus(definition, await peek(name));
  };

  const update: PluginRuntime["update"] = async (name, input, actor = { staffId: null }) => {
    const definition = requirePlugin(name);
    const before = entries.get(name)?.state;
    const saved = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(pluginSettings).where(eq(pluginSettings.plugin, name)).for("update");
      const current = stateFrom(definition, row);
      const stored = applySettingsUpdate(settingsOf(definition), current.stored, input.settings, current);
      const values = {
        enabled: input.enabled ?? row?.enabled ?? true,
        values: stored.values,
        // One sealed object for every secret: the database never holds one in the clear.
        secrets: Object.keys(stored.secrets).length ? sealSecret(secretKey, JSON.stringify(stored.secrets)) : null,
        updatedBy: actor.staffId,
        updatedAt: new Date(),
      };
      const [written] = await tx.insert(pluginSettings).values({ plugin: name, ...values }).onConflictDoUpdate({ target: pluginSettings.plugin, set: values }).returning();
      return written!;
    });
    const state = stateFrom(definition, saved);
    saves.set(name, (saves.get(name) ?? 0) + 1);
    entries.set(name, { state, at: Date.now() });
    // Just became active: run onStart now, not at the next restart.
    if (isActiveState(state) && !(before && isActiveState(before))) void runOnStart(definition, state);
    return toStatus(definition, state);
  };

  const check = async (name: string) => {
    const definition = requirePlugin(name);
    if (!definition.check) throw new InvalidStateError(`The plugin ${name} has no connection check`);
    await load([name]);
    const state = entries.get(name)!.state;
    if (state.missing.length) throw new InvalidStateError(`Fill in ${labels(definition, state.missing)} first`);
    try {
      const result = await withTimeout(definition.check(contextFor(definition, state)), CHECK_TIMEOUT_MS, "The check");
      if (typeof result?.ok !== "boolean") return { ok: false, message: "The check returned no result" };
      return { ok: result.ok, message: typeof result.message === "string" && result.message ? result.message : result.ok ? "OK" : "Failed" };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  };

  const providers = { payment: [] as PaymentProvider[], shipping: [] as ShippingProvider[] };
  const runtime: PluginRuntime = {
    definitions,
    get: (name) => byName.get(name),
    isActive,
    context,
    checkoutValidate,
    reportError,
    get paymentProviders() {
      return providers.payment;
    },
    get shippingProviders() {
      return providers.shipping;
    },
    start,
    status,
    update,
    check,
    refresh,
  };
  for (const definition of definitions) {
    for (const provider of definition.payments ?? []) providers.payment.push(bindPaymentProvider(provider, definition.name, runtime, logger));
    for (const provider of definition.shipping ?? []) providers.shipping.push(bindShippingProvider(provider, definition.name, runtime));
  }
  return runtime;
};
