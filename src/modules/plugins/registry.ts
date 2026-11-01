import { PLUGIN_API_VERSION, type AnyPluginDefinition, type SettingField } from "../../plugins/sdk.ts";
import { EVENT_TYPES, matchesEventPattern, PLUGIN_ONLY_EVENT_TYPES } from "../integrations/outbox.ts";
import { createProviderRegistry } from "../payments/providers.ts";
import { BUILT_IN_SHIPPING_PROVIDERS } from "../shipping/providers.ts";
import { PERMISSIONS } from "../staff/service.ts";
import { fieldSchema, settingsOf } from "./settings.ts";

export const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,39}$/;
const PROVIDER_CODE = /^[a-z][a-z0-9_-]{1,39}$/;
const PERMISSION_CODE = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const EVENT_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const FIELD_TYPES = new Set(["string", "secret", "boolean", "number", "select"]);

/** Platform event prefixes, so `order.*` always means platform orders. */
const RESERVED_NAMES = new Set([...EVENT_TYPES, ...PLUGIN_ONLY_EVENT_TYPES].map((t) => t.split(".")[0]!));

export class PluginConfigError extends Error {}

const settingProblems = (key: string, field: SettingField): string[] => {
  const problems: string[] = [];
  if (!SETTING_KEY.test(key)) problems.push(`setting "${key}": keys are letters, digits and _, starting with a letter`);
  if (!field || typeof field !== "object" || !FIELD_TYPES.has(field.type)) return [...problems, `setting "${key}": use setting.string(), .secret(), .boolean(), .number() or .select()`];
  if (!field.label) problems.push(`setting "${key}" has no label`);
  if (field.env !== undefined && !ENV_NAME.test(field.env)) problems.push(`setting "${key}": "${field.env}" is not an environment variable name`);
  if (field.type === "select") {
    if (!field.options?.length) problems.push(`setting "${key}" has no options`);
    else if (new Set(field.options.map((o) => o.value)).size !== field.options.length) problems.push(`setting "${key}" has duplicate options`);
  }
  if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) problems.push(`setting "${key}": min is above max`);
  if ("default" in field && field.default !== undefined && !(field.type === "select" && !field.options?.length) && !fieldSchema(field).safeParse(field.default).success) {
    problems.push(`setting "${key}": the default ${JSON.stringify(field.default)} does not fit the field`);
  }
  return problems;
};

/** Fails startup with every problem listed, rather than letting a mistake surface later. */
export const validatePluginDefinitions = (definitions: readonly AnyPluginDefinition[], options: { paymentProviderCodes?: readonly string[] } = {}): void => {
  const problems: string[] = [];
  const names = new Set<string>();
  const paymentCodes = new Map<string, string>([...createProviderRegistry().keys(), ...(options.paymentProviderCodes ?? [])].map((code) => [code, "the platform"]));
  const shippingCodes = new Map<string, string>(BUILT_IN_SHIPPING_PROVIDERS.map((p) => [p.code, "the platform"]));
  const permissions = new Map<string, string>(PERMISSIONS.map((code) => [code, "the platform"]));
  const emitted = new Set<string>();

  for (const [index, definition] of definitions.entries()) {
    const name = typeof definition?.name === "string" ? definition.name : "";
    const where = name ? `Plugin "${name}"` : `Plugin #${index + 1}`;
    const problem = (message: string) => problems.push(`${where}: ${message}`);
    if (!definition || typeof definition !== "object") {
      problem("is not a plugin definition (use definePlugin)");
      continue;
    }
    if (!PLUGIN_NAME.test(name)) problem("the name must be 2–40 lowercase letters, digits and dashes, starting with a letter");
    else if (RESERVED_NAMES.has(name)) problem(`"${name}" names platform events (${name}.*); choose another name`);
    else if (names.has(name)) problem("is listed twice");
    names.add(name);
    if (definition.apiVersion !== PLUGIN_API_VERSION) {
      problem(`targets plugin API version ${String(definition.apiVersion)}, but this platform implements version ${PLUGIN_API_VERSION}; update the plugin or the platform`);
    }
    if (!definition.title) problem("has no title");
    if (typeof definition.version !== "string" || !definition.version) problem("has no version");

    for (const [kind, list, taken] of [["payment", definition.payments, paymentCodes], ["shipping", definition.shipping, shippingCodes]] as const) {
      for (const provider of list ?? []) {
        if (!PROVIDER_CODE.test(provider?.code ?? "")) problem(`${kind} provider code "${provider?.code}" must be 2–40 lowercase letters, digits, _ and -`);
        else if (taken.has(provider.code)) problem(`${kind} provider "${provider.code}" is already provided by ${taken.get(provider.code)}`);
        else taken.set(provider.code, `the plugin "${name}"`);
      }
    }

    for (const type of definition.emits ?? []) {
      if (!type.startsWith(`${name}.`) || !EVENT_NAME.test(type)) problem(`emitted event "${type}" must be named "${name}.<something>" (lowercase letters, digits, _, - and dots)`);
      else emitted.add(type);
    }

    for (const permission of definition.permissions ?? []) {
      if (!PERMISSION_CODE.test(permission?.code ?? "")) problem(`permission "${permission?.code}" must look like area:action, e.g. reviews:moderate`);
      else if (permissions.has(permission.code)) problem(`permission "${permission.code}" is already defined by ${permissions.get(permission.code)}`);
      else permissions.set(permission.code, `the plugin "${name}"`);
      if (!permission?.description) problem(`permission "${permission?.code}" has no description`);
    }

    for (const [key, field] of Object.entries(settingsOf(definition))) for (const message of settingProblems(key, field)) problem(message);
    for (const provider of definition.shipping ?? []) {
      for (const [key, field] of Object.entries(provider?.methodOptions ?? {})) for (const message of settingProblems(key, field)) problem(`shipping provider "${provider.code}": ${message}`);
    }

    const tasks = new Set<string>();
    for (const task of definition.tasks ?? []) {
      if (!TASK_NAME.test(task?.name ?? "")) problem(`task "${task?.name}" needs a name of letters, digits, _, . and -`);
      else if (tasks.has(task.name)) problem(`task "${task.name}" is listed twice`);
      tasks.add(task?.name);
      if (!Number.isInteger(task?.intervalMinutes) || task.intervalMinutes < 1) problem(`task "${task?.name}": intervalMinutes must be a whole number of minutes, at least 1`);
      if (typeof task?.run !== "function") problem(`task "${task?.name}" has no run function`);
    }
    if (definition.migrations !== undefined && !(definition.migrations instanceof URL)) problem("migrations must be a URL: of the plugin's migrations directory, relative to its module");
    if (definition.admin !== undefined && !(definition.admin instanceof URL)) problem("admin must be a URL: of the plugin's admin module, relative to its module");
  }

  // Handlers may subscribe to any plugin's events, so these are checked once every plugin is known.
  const known = [...EVENT_TYPES, ...PLUGIN_ONLY_EVENT_TYPES, ...emitted];
  for (const definition of definitions) {
    for (const [key, handler] of Object.entries(definition?.events ?? {})) {
      if (key !== "*" && !known.some((type) => matchesEventPattern(key, type))) problems.push(`Plugin "${definition.name}": events key "${key}" matches no platform or plugin event (use a type, prefix.* or *)`);
      if (typeof handler !== "function") problems.push(`Plugin "${definition.name}": the handler for "${key}" is not a function`);
    }
  }

  if (problems.length) throw new PluginConfigError(`Invalid plugins (ecom.config.ts):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
};
