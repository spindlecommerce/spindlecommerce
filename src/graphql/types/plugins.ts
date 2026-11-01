import { InvalidStateError, NotFoundError } from "../../lib/errors.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { listPluginDeliveries, retryPluginDelivery, type PluginDelivery } from "../../modules/plugins/events.ts";
import { isRequired } from "../../modules/plugins/settings.ts";
import { listPluginTaskRuns, runPluginTaskNow, type PluginTaskRun } from "../../modules/plugins/tasks.ts";
import type { PluginSettingStatus, PluginStatus } from "../../modules/plugins/types.ts";
import { listPluginPermissions } from "../../modules/staff/service.ts";
import type { AnyPluginDefinition, ScheduledTask } from "../../plugins/sdk.ts";
import { ADMIN, builder, pageSize, rawId } from "../builder.ts";
import type { GraphQLContext } from "../context.ts";

type PluginShape = { definition: AnyPluginDefinition; status: PluginStatus };
type TaskShape = { task: ScheduledTask<any>; run: PluginTaskRun | null };
type DeliveryShape = PluginDelivery & { eventType: string | null };

const SettingType = builder.enumType("PluginSettingType", {
  subGraphs: ADMIN,
  values: { STRING: { value: "string" }, SECRET: { value: "secret", description: "Write-only: never returned." }, BOOLEAN: { value: "boolean" }, NUMBER: { value: "number" }, SELECT: { value: "select" } } as const,
});

const SettingSource = builder.enumType("PluginSettingSource", {
  subGraphs: ADMIN,
  description: "Where a setting's value comes from, in order of precedence.",
  values: {
    ENV: { value: "env", description: "The environment variable named in `env`; read-only in the admin." },
    ADMIN: { value: "admin", description: "Saved under Settings › Plugins." },
    DEFAULT: { value: "default", description: "The plugin's default." },
    UNSET: { value: "unset" },
  } as const,
});

const DeliveryStatus = builder.enumType("PluginDeliveryStatus", {
  subGraphs: ADMIN,
  values: { PENDING: { value: "pending" }, SUCCEEDED: { value: "succeeded" }, FAILED: { value: "failed", description: "Will retry with backoff." }, DEAD: { value: "dead", description: "Gave up; retry manually." } } as const,
});

const SettingOptionRef = builder.objectRef<{ value: string; label: string }>("PluginSettingOption").implement({
  subGraphs: ADMIN,
  fields: (t) => ({ value: t.exposeString("value"), label: t.exposeString("label") }),
});

const SettingRef = builder.objectRef<PluginSettingStatus>("PluginSetting").implement({
  subGraphs: ADMIN,
  description: "One setting as staff see it. Secrets are write-only: `value` is always null for them; `isSet` says whether one is stored.",
  fields: (t) => ({
    key: t.exposeString("key"),
    label: t.string({ resolve: (s) => s.field.label }),
    description: t.string({ nullable: true, resolve: (s) => s.field.description ?? null }),
    type: t.field({ type: SettingType, resolve: (s) => s.field.type }),
    required: t.boolean({ resolve: (s) => isRequired(s.field) }),
    value: t.field({ type: "JSON", nullable: true, description: "The value in effect; null for secrets.", resolve: (s) => (s.field.type === "secret" ? null : s.value) }),
    default: t.field({
      type: "JSON",
      nullable: true,
      description: "What applies when no value is set; null when the field has no default (and for secrets, which have none).",
      resolve: (s) => (s.field.type !== "secret" && "default" in s.field ? (s.field.default ?? null) : null),
    }),
    isSet: t.exposeBoolean("isSet"),
    source: t.field({ type: SettingSource, resolve: (s) => s.source }),
    env: t.string({ nullable: true, description: "The environment variable that supplies it instead, when set.", resolve: (s) => s.field.env ?? null }),
    options: t.field({ type: [SettingOptionRef], nullable: true, resolve: (s) => (s.field.type === "select" ? s.field.options.map((o) => ({ value: o.value, label: o.label })) : null) }),
    placeholder: t.string({ nullable: true, resolve: (s) => (s.field.type === "string" ? (s.field.placeholder ?? null) : null) }),
    multiline: t.boolean({ nullable: true, resolve: (s) => (s.field.type === "string" ? (s.field.multiline ?? false) : null) }),
    min: t.float({ nullable: true, resolve: (s) => (s.field.type === "number" ? (s.field.min ?? null) : null) }),
    max: t.float({ nullable: true, resolve: (s) => (s.field.type === "number" ? (s.field.max ?? null) : null) }),
    integer: t.boolean({ nullable: true, resolve: (s) => (s.field.type === "number" ? (s.field.integer ?? false) : null) }),
  }),
});

const CapabilitiesRef = builder.objectRef<AnyPluginDefinition>("PluginCapabilities").implement({
  subGraphs: ADMIN,
  description: "What the plugin extends.",
  fields: (t) => ({
    events: t.stringList({ description: "Event types or patterns it handles.", resolve: (d) => Object.keys(d.events ?? {}) }),
    hooks: t.stringList({ resolve: (d) => Object.entries(d.hooks ?? {}).flatMap(([name, hook]) => (typeof hook === "function" ? [name] : [])) }),
    paymentProviders: t.stringList({ resolve: (d) => (d.payments ?? []).map((p) => p.code) }),
    shippingProviders: t.stringList({ resolve: (d) => (d.shipping ?? []).map((p) => p.code) }),
    emits: t.stringList({ resolve: (d) => d.emits ?? [] }),
    graphql: t.boolean({ resolve: (d) => !!d.graphql }),
    routes: t.boolean({ description: "HTTP routes under /plugins/<name>/.", resolve: (d) => !!d.routes }),
    tasks: t.stringList({ resolve: (d) => (d.tasks ?? []).map((task) => task.name) }),
    migrations: t.boolean({ resolve: (d) => !!d.migrations }),
    admin: t.boolean({ description: "Pages, navigation or widgets in the admin.", resolve: (d) => !!d.admin }),
  }),
});

const PermissionRef = builder.objectRef<{ code: string; description: string; plugin: string; pluginTitle: string }>("PluginPermission").implement({
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.exposeString("code"),
    description: t.exposeString("description"),
    plugin: t.exposeString("plugin", { description: "The name of the plugin that introduces it." }),
    pluginTitle: t.exposeString("pluginTitle", { description: "That plugin's title, to group permissions under (roles screen)." }),
  }),
});

const TaskRef = builder.objectRef<TaskShape>("PluginTask").implement({
  subGraphs: ADMIN,
  description: "A task the worker runs at most once per interval.",
  fields: (t) => ({
    name: t.string({ resolve: (x) => x.task.name }),
    description: t.string({ nullable: true, resolve: (x) => x.task.description ?? null }),
    intervalMinutes: t.int({ resolve: (x) => x.task.intervalMinutes }),
    lastStartedAt: t.field({ type: "DateTime", nullable: true, resolve: (x) => x.run?.lastStartedAt ?? null }),
    lastFinishedAt: t.field({ type: "DateTime", nullable: true, resolve: (x) => x.run?.lastFinishedAt ?? null }),
    lastStatus: t.string({ nullable: true, description: "running, succeeded or failed.", resolve: (x) => x.run?.lastStatus ?? null }),
    lastError: t.string({ nullable: true, resolve: (x) => x.run?.lastError ?? null }),
  }),
});

const DeliveryRef = builder.objectRef<DeliveryShape>("PluginDelivery").implement({
  subGraphs: ADMIN,
  description: "One event for one of the plugin's handlers, retried with backoff until it succeeds or gives up.",
  fields: (t) => ({
    id: t.id({ resolve: (d) => toGlobalId("PluginDelivery", d.id) }),
    eventId: t.id({ resolve: (d) => toGlobalId("Event", d.eventId) }),
    eventType: t.string({ resolve: (d) => d.eventType ?? "unknown" }),
    handler: t.string({ description: "The `events` key that matched, e.g. order.*", resolve: (d) => d.handler }),
    status: t.field({ type: DeliveryStatus, resolve: (d) => d.status }),
    attempts: t.exposeInt("attempts"),
    lastError: t.exposeString("lastError", { nullable: true }),
    nextAttemptAt: t.field({ type: "DateTime", nullable: true, resolve: (d) => (d.status === "pending" || d.status === "failed" ? d.nextAttemptAt : null) }),
    createdAt: t.field({ type: "DateTime", resolve: (d) => d.createdAt }),
  }),
});

const tasksOf = async (ctx: GraphQLContext, definition: AnyPluginDefinition): Promise<TaskShape[]> => {
  const runs = await listPluginTaskRuns(ctx.db, definition.name);
  return (definition.tasks ?? []).map((task) => ({ task, run: runs.find((r) => r.task === task.name) ?? null }));
};

const PluginRef = builder.objectRef<PluginShape>("Plugin").implement({
  subGraphs: ADMIN,
  description: "A plugin installed with the platform (ecom.config.ts). Active means enabled with every required setting filled in.",
  fields: (t) => ({
    name: t.string({ resolve: (p) => p.definition.name }),
    title: t.string({ resolve: (p) => p.definition.title }),
    version: t.string({ resolve: (p) => p.definition.version }),
    description: t.string({ nullable: true, resolve: (p) => p.definition.description ?? null }),
    enabled: t.boolean({ resolve: (p) => p.status.enabled }),
    configured: t.boolean({ resolve: (p) => p.status.configured }),
    active: t.boolean({ resolve: (p) => p.status.active }),
    missingSettings: t.stringList({ description: "Keys of required settings without a value.", resolve: (p) => p.status.missing }),
    settings: t.field({ type: [SettingRef], resolve: (p) => p.status.settings }),
    capabilities: t.field({ type: CapabilitiesRef, resolve: (p) => p.definition }),
    permissions: t.field({
      type: [PermissionRef],
      resolve: (p) => (p.definition.permissions ?? []).map((x) => ({ code: x.code, description: x.description, plugin: p.definition.name, pluginTitle: p.definition.title })),
    }),
    tasks: t.field({ type: [TaskRef], resolve: (p, _a, ctx) => tasksOf(ctx, p.definition) }),
    deliveries: t.field({
      type: [DeliveryRef],
      description: "Event deliveries to its handlers, newest first.",
      args: { status: t.arg({ type: DeliveryStatus }), first: t.arg.int({ defaultValue: 20 }) },
      complexity: (args) => ({ field: 2, multiplier: pageSize(args.first) }),
      resolve: (p, args, ctx) => listPluginDeliveries(ctx.db, p.definition.name, { status: args.status, limit: pageSize(args.first) }),
    }),
    hasAdmin: t.boolean({ description: "Adds pages, navigation or widgets to the admin.", resolve: (p) => !!p.definition.admin }),
    canCheck: t.boolean({ description: "Has a connection check (pluginCheck).", resolve: (p) => typeof p.definition.check === "function" }),
  }),
});

const pluginOf = async (ctx: GraphQLContext, name: string): Promise<PluginShape | null> => {
  const definition = ctx.platform.plugins.get(name);
  return definition ? { definition, status: await ctx.platform.plugins.status(name, { fresh: true }) } : null;
};

builder.queryFields((t) => ({
  plugins: t.field({
    type: [PluginRef],
    subGraphs: ADMIN,
    description: "The installed plugins, in ecom.config.ts order.",
    authScopes: { permission: "settings:read" },
    resolve: async (_r, _a, ctx) => {
      const plugins: PluginShape[] = [];
      for (const definition of ctx.platform.plugins.definitions) plugins.push((await pluginOf(ctx, definition.name))!);
      return plugins;
    },
  }),
  plugin: t.field({
    type: PluginRef,
    nullable: true,
    subGraphs: ADMIN,
    authScopes: { permission: "settings:read" },
    args: { name: t.arg.string({ required: true }) },
    resolve: (_r, { name }, ctx) => pluginOf(ctx, name),
  }),
  pluginPermissions: t.field({
    type: [PermissionRef],
    subGraphs: ADMIN,
    description: "Permissions the installed plugins introduce, with what each allows and which plugin adds it (their codes are also in `permissions`).",
    authScopes: { staff: true },
    resolve: () => listPluginPermissions(),
  }),
  activePlugins: t.stringList({
    subGraphs: ADMIN,
    description: "Names of the plugins that are enabled and configured: which plugin pages, navigation and widgets the admin shows (each still checks its own permissions).",
    authScopes: { staff: true },
    resolve: async (_r, _a, ctx) => {
      const active: string[] = [];
      for (const definition of ctx.platform.plugins.definitions) if (await ctx.platform.plugins.isActive(definition.name)) active.push(definition.name);
      return active;
    },
  }),
}));

const PluginUpdateInput = builder.inputType("PluginUpdateInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    enabled: t.boolean(),
    settings: t.field({
      type: "JSON",
      description: "Values by key: a value sets, null clears, a missing key keeps. A secret also keeps on an empty string (forms show secrets blank).",
    }),
  }),
});

const PluginUpdatePayload = builder.simpleObject("PluginUpdatePayload", { subGraphs: ADMIN, fields: (t) => ({ plugin: t.field({ type: PluginRef }) }) });
const PluginCheckPayload = builder.simpleObject("PluginCheckPayload", {
  subGraphs: ADMIN,
  fields: (t) => ({ ok: t.boolean(), message: t.string({ description: "What the plugin found, for staff." }) }),
});
const PluginTaskRunPayload = builder.simpleObject("PluginTaskRunPayload", { subGraphs: ADMIN, fields: (t) => ({ task: t.field({ type: TaskRef }) }) });
const PluginDeliveryRetryPayload = builder.simpleObject("PluginDeliveryRetryPayload", { subGraphs: ADMIN, fields: (t) => ({ delivery: t.field({ type: DeliveryRef }) }) });

const write = { subGraphs: ADMIN, authScopes: { permission: "settings:write" } } as const;

builder.mutationFields((t) => ({
  pluginUpdate: t.field({
    ...write,
    type: PluginUpdatePayload,
    description: "Enable or disable a plugin and change its settings. Field errors are at [input, settings, <key>].",
    errors: {},
    args: { name: t.arg.string({ required: true }), input: t.arg({ type: PluginUpdateInput, required: true }) },
    resolve: async (_r, { name, input }, ctx) => {
      const definition = ctx.platform.plugins.get(name);
      if (!definition) throw new NotFoundError("Plugin", name);
      const status = await ctx.platform.plugins.update(name, { enabled: input.enabled, settings: input.settings }, { staffId: ctx.staff?.id ?? null });
      return { plugin: { definition, status } };
    },
  }),
  pluginCheck: t.field({
    ...write,
    type: PluginCheckPayload,
    description: "Test connection: the plugin checks its saved settings against the remote service (15 seconds at most). Works while disabled.",
    errors: { types: [InvalidStateError] },
    args: { name: t.arg.string({ required: true }) },
    resolve: (_r, { name }, ctx) => ctx.platform.plugins.check(name),
  }),
  pluginTaskRun: t.field({
    ...write,
    type: PluginTaskRunPayload,
    description: "Run a task now, whatever its interval, and wait for it; a failure is reported in the task's lastError.",
    errors: { types: [InvalidStateError] },
    args: { name: t.arg.string({ required: true }), task: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => {
      const run = await runPluginTaskNow(ctx.platform, args.name, args.task);
      const task = ctx.platform.plugins.get(args.name)!.tasks!.find((x) => x.name === args.task)!;
      return { task: { task, run } };
    },
  }),
  pluginDeliveryRetry: t.field({
    ...write,
    type: PluginDeliveryRetryPayload,
    description: "Make a failed or dead delivery due now.",
    errors: {},
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }, ctx) => ({ delivery: await retryPluginDelivery(ctx.db, rawId(String(id))) }),
  }),
}));
