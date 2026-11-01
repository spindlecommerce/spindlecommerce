import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../../src/modules/plugins/migrations.ts";
import { PluginConfigError, validatePluginDefinitions } from "../../src/modules/plugins/registry.ts";
import { applySettingsUpdate, resolveSettings, settingsSchema, type StoredSettings } from "../../src/modules/plugins/settings.ts";
import { PluginTimeoutError, withTimeout } from "../../src/modules/plugins/timeout.ts";
import { definePlugin, PLUGIN_API_VERSION, setting, ValidationError, type AnyPluginDefinition, type SettingsShape } from "../../src/plugins/sdk.ts";
import { brokenHook, kitchenSink } from "../fixtures/plugins/kitchen-sink/index.ts";
import { orderAlerts } from "../fixtures/plugins/order-alerts/index.ts";

const plugin = (overrides: Partial<AnyPluginDefinition> = {}): AnyPluginDefinition => definePlugin({ name: "acme", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, title: "Acme", ...overrides });

const problems = (definitions: AnyPluginDefinition[], options?: Parameters<typeof validatePluginDefinitions>[1]) => {
  try {
    validatePluginDefinitions(definitions, options);
    return "";
  } catch (error) {
    expect(error).toBeInstanceOf(PluginConfigError);
    return (error as Error).message;
  }
};

const noop = async () => {};
const provider = (code: string) => ({ code, title: code, authorize: async () => ({ status: "pending" as const, pspReference: null }), capture: async () => ({ pspReference: null }), refund: async () => ({ pspReference: null }), void: async () => ({ pspReference: null }) });

describe("plugin validation at startup", () => {
  it("accepts the fixtures", () => {
    expect(problems([kitchenSink(), brokenHook(), orderAlerts()])).toBe("");
  });

  it("refuses bad and duplicate names, and names of platform event namespaces", () => {
    expect(problems([plugin({ name: "Acme" })])).toMatch(/name must be 2–40 lowercase/);
    expect(problems([plugin({ name: "a" })])).toMatch(/name must be/);
    expect(problems([plugin({ name: "x".repeat(41) })])).toMatch(/name must be/);
    expect(problems([plugin(), plugin()])).toMatch(/Plugin "acme": is listed twice/);
    expect(problems([plugin({ name: "order" })])).toMatch(/names platform events/);
  });

  it("says which API version a plugin targets and which the platform implements", () => {
    expect(problems([plugin({ apiVersion: PLUGIN_API_VERSION + 1 })])).toContain(`targets plugin API version ${PLUGIN_API_VERSION + 1}, but this platform implements version ${PLUGIN_API_VERSION}`);
  });

  it("refuses provider codes that clash with each other or with the platform's", () => {
    expect(problems([plugin({ payments: [provider("offline")] })])).toMatch(/payment provider "offline" is already provided by the platform/);
    expect(problems([plugin({ payments: [provider("test_gateway")] })])).toMatch(/already provided by the platform/);
    expect(problems([plugin({ payments: [provider("pay")] }), plugin({ name: "other", payments: [provider("pay")] })])).toMatch(/payment provider "pay" is already provided by the plugin "acme"/);
    expect(problems([plugin({ payments: [provider("pay")] })], { paymentProviderCodes: ["pay"] })).toMatch(/already provided by the platform/);
    for (const code of ["flat_rate", "table_rate", "free"]) expect(problems([plugin({ shipping: [{ code, title: code, rates: async () => [] }] })])).toMatch(/shipping provider ".*" is already provided by the platform/);
    expect(problems([plugin({ shipping: [{ code: "Bad Code", title: "x", rates: async () => [] }] })])).toMatch(/shipping provider code "Bad Code"/);
  });

  it("requires emitted events to be named after the plugin, and handlers to match known events", () => {
    expect(problems([plugin({ emits: ["order.synced"] })])).toMatch(/emitted event "order.synced" must be named "acme.<something>"/);
    expect(problems([plugin({ emits: ["acme.synced"], events: { "acme.synced": noop, "acme.*": noop, "order.*": noop, "order.placed": noop, "*": noop } })])).toBe("");
    expect(problems([plugin({ events: { "order.placd": noop } })])).toMatch(/events key "order.placd" matches no platform or plugin event/);
    expect(problems([plugin({ events: { "acme.*": noop } })])).toMatch(/events key "acme.\*"/);
    // Another plugin's declared events count.
    expect(problems([plugin({ events: { "other.done": noop } }), plugin({ name: "other", emits: ["other.done"] })])).toBe("");
  });

  it("requires area:action permissions that do not clash with the platform's or each other", () => {
    expect(problems([plugin({ permissions: [{ code: "moderate", description: "x" }] })])).toMatch(/permission "moderate" must look like area:action/);
    expect(problems([plugin({ permissions: [{ code: "orders:write", description: "x" }] })])).toMatch(/permission "orders:write" is already defined by the platform/);
    expect(problems([plugin({ permissions: [{ code: "reviews:moderate", description: "x" }] }), plugin({ name: "other", permissions: [{ code: "reviews:moderate", description: "y" }] })])).toMatch(
      /already defined by the plugin "acme"/,
    );
    expect(problems([plugin({ permissions: [{ code: "reviews:moderate", description: "" }] })])).toMatch(/has no description/);
  });

  it("checks settings and tasks", () => {
    expect(problems([plugin({ settings: { "api-key": setting.string({ label: "Key" }) } })])).toMatch(/setting "api-key": keys are letters/);
    expect(problems([plugin({ settings: { mode: setting.select({ label: "Mode", options: [{ value: "a", label: "A" }], default: "b" as "a" }) } })])).toMatch(/the default "b" does not fit/);
    expect(problems([plugin({ settings: { n: setting.number({ label: "N", min: 1, max: 5, default: 9 }) } })])).toMatch(/the default 9 does not fit/);
    expect(problems([plugin({ settings: { key: setting.secret({ label: "Key", env: "NOT VALID" }) } })])).toMatch(/is not an environment variable name/);
    expect(problems([plugin({ tasks: [{ name: "sync", intervalMinutes: 0, run: noop }] })])).toMatch(/intervalMinutes must be a whole number/);
    expect(problems([plugin({ tasks: [{ name: "sync", intervalMinutes: 5, run: noop }, { name: "sync", intervalMinutes: 5, run: noop }] })])).toMatch(/task "sync" is listed twice/);
  });

  it("lists every problem at once", () => {
    const message = problems([plugin({ name: "Bad", apiVersion: 99, emits: ["x.y"] })]);
    expect(message.split("\n").length).toBeGreaterThanOrEqual(4);
  });
});

const shape = {
  apiKey: setting.secret({ label: "API key", required: true, env: "ACME_API_KEY" }),
  region: setting.select({ label: "Region", options: [{ value: "eu", label: "EU" }, { value: "us", label: "US" }], default: "eu", env: "ACME_REGION" }),
  timeout: setting.number({ label: "Timeout", min: 1, max: 60, integer: true }),
  sandbox: setting.boolean({ label: "Sandbox" }),
  label: setting.string({ label: "Label", required: true }),
} satisfies SettingsShape;

const empty: StoredSettings = { values: {}, secrets: {} };
const warnings: string[] = [];
const resolve = (stored: StoredSettings, env: Record<string, string | undefined> = {}) => resolveSettings(shape, stored, env, (m) => warnings.push(m));

describe("plugin settings", () => {
  it("resolves the environment over stored values over defaults", () => {
    const stored: StoredSettings = { values: { region: "us", timeout: 30, label: "Shop" }, secrets: { apiKey: "stored-key" } };
    expect(resolve(stored)).toEqual({
      values: { apiKey: "stored-key", region: "us", timeout: 30, sandbox: false, label: "Shop" },
      sources: { apiKey: "admin", region: "admin", timeout: "admin", sandbox: "default", label: "admin" },
      missing: [],
    });
    const fromEnv = resolve(stored, { ACME_API_KEY: "env-key", ACME_REGION: "eu" });
    expect(fromEnv.values).toMatchObject({ apiKey: "env-key", region: "eu" });
    expect(fromEnv.sources).toMatchObject({ apiKey: "env", region: "env" });
    // Empty variables are unset (Vercel and .env files carry empty placeholders).
    expect(resolve(stored, { ACME_API_KEY: " " }).sources.apiKey).toBe("admin");
    expect(resolve(empty).values).toEqual({ apiKey: undefined, region: "eu", timeout: undefined, sandbox: false, label: undefined });
    expect(resolve(empty).sources).toEqual({ apiKey: "unset", region: "default", timeout: "unset", sandbox: "default", label: "unset" });
  });

  it("is configured once every required setting has a value", () => {
    expect(resolve(empty).missing).toEqual(["apiKey", "label"]);
    expect(resolve({ values: { label: "Shop" }, secrets: {} }, { ACME_API_KEY: "k" }).missing).toEqual([]);
  });

  it("skips values that no longer fit, with a warning", () => {
    warnings.length = 0;
    expect(resolve({ values: { region: "apac" }, secrets: {} }, { ACME_REGION: "mars" }).values.region).toBe("eu");
    expect(warnings).toEqual(["ACME_REGION is not a valid value for the setting region; ignored", "the stored value of the setting region no longer fits it; ignored"]);
  });

  it("updates: a value sets, null clears, a missing key keeps", () => {
    const stored: StoredSettings = { values: { timeout: 10, label: "Shop" }, secrets: { apiKey: "old" } };
    const next = applySettingsUpdate(shape, stored, { apiKey: "new", timeout: null, region: "us" }, resolve(stored));
    expect(next).toEqual({ values: { label: "Shop", region: "us" }, secrets: { apiKey: "new" } });
    // Forms send strings; a blank secret keeps the stored one, a blank text setting clears it.
    expect(applySettingsUpdate(shape, stored, { apiKey: "", label: "", timeout: "15", sandbox: "true" }, resolve(stored))).toEqual({
      values: { timeout: 15, sandbox: true },
      secrets: { apiKey: "old" },
    });
    expect(applySettingsUpdate(shape, stored, undefined, resolve(stored))).toBe(stored);
  });

  it("reports field errors at [input, settings, key]", () => {
    const attempt = (input: unknown, env?: Record<string, string>) => {
      try {
        applySettingsUpdate(shape, empty, input, resolve(empty, env));
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        return (error as ValidationError).fieldErrors;
      }
      return [];
    };
    expect(attempt({ nope: 1, timeout: 99, region: "mars" })).toEqual([
      { path: ["input", "settings", "nope"], message: "Unknown setting" },
      { path: ["input", "settings", "region"], message: "Use one of eu, us" },
      { path: ["input", "settings", "timeout"], message: expect.stringMatching(/60/) },
    ]);
    expect(attempt({ timeout: "soon" })[0]?.path).toEqual(["input", "settings", "timeout"]);
    expect(attempt([1])).toEqual([{ path: ["input", "settings"], message: "Settings are an object of values by key" }]);
    // The environment supplies it: the admin cannot set it, but may post back what it shows.
    expect(attempt({ apiKey: "admin-key" }, { ACME_API_KEY: "env-key" })).toEqual([{ path: ["input", "settings", "apiKey"], message: "Set by the environment variable ACME_API_KEY; change it there" }]);
    expect(attempt({ region: "us" }, { ACME_REGION: "us" })).toEqual([]);
  });

  it("builds one zod schema from the shape", () => {
    expect(settingsSchema(shape).safeParse({ timeout: 5, region: null }).success).toBe(true);
    expect(settingsSchema(shape).safeParse({ timeout: 0.5 }).success).toBe(false);
  });
});

describe("plugin migrations", () => {
  it("split at semicolons outside strings, comments and dollar-quoted bodies", () => {
    const sql = `-- a comment; still a comment
CREATE TABLE t (a text DEFAULT 'x;y');
/* block; comment */
CREATE FUNCTION f() RETURNS text AS $body$ SELECT 'a;b'; $body$ LANGUAGE sql;
INSERT INTO t VALUES ($$;$$);
-- trailing comment`;
    expect(splitSqlStatements(sql)).toEqual([
      "-- a comment; still a comment\nCREATE TABLE t (a text DEFAULT 'x;y')",
      "/* block; comment */\nCREATE FUNCTION f() RETURNS text AS $body$ SELECT 'a;b'; $body$ LANGUAGE sql",
      "INSERT INTO t VALUES ($$;$$)",
    ]);
  });

  it("split at drizzle-kit's statement breakpoints when a file has them", () => {
    expect(splitSqlStatements("CREATE TABLE a (x int);--> statement-breakpoint\nCREATE INDEX i ON a (x);")).toEqual(["CREATE TABLE a (x int);", "CREATE INDEX i ON a (x);"]);
  });
});

describe("plugin time limits", () => {
  it("fail slow work and pass quick work through", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "The check")).rejects.toThrow(new PluginTimeoutError("The check timed out after 20 ms"));
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
    await expect(withTimeout(Promise.reject(new Error("nope")), 1000, "x")).rejects.toThrow("nope");
  });
});
