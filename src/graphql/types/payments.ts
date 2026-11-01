import { createPaymentMethod, listPaymentMethods, updatePaymentMethod } from "../../modules/payments/service.ts";
import { ADMIN, builder, rawId } from "../builder.ts";
import { ChannelRef, PaymentMethodRef } from "../refs.ts";
import { fromLocalizedList, LocalizedStringInput, LocalizedStringRef, toLocalizedList } from "./common.ts";
import { byIdFrom } from "./settings.ts";

const CaptureMode = builder.enumType("CaptureMode", {
  subGraphs: ADMIN,
  values: { AUTHORIZE: { value: "authorize", description: "Capture later (on shipment)." }, AUTHORIZE_CAPTURE: { value: "authorize_capture", description: "Capture at checkout." } } as const,
});

builder.node(PaymentMethodRef, {
  subGraphs: ADMIN,
  id: { resolve: (x) => x.id },
  loadMany: byIdFrom(listPaymentMethods),
  fields: (t) => ({
    code: t.exposeString("code"),
    names: t.field({ type: [LocalizedStringRef], resolve: (m) => toLocalizedList(m.name) }),
    provider: t.exposeString("provider"),
    captureMode: t.field({ type: CaptureMode, nullable: true, description: "Null means the provider's default.", resolve: (m) => m.config.captureMode ?? null }),
    countries: t.field({ type: ["CountryCode"], resolve: (m) => m.countries }),
    channels: t.field({ type: [ChannelRef], resolve: async (m, _a, ctx) => (await ctx.db.query.channels.findMany()).filter((c) => m.channelIds.length === 0 || m.channelIds.includes(c.id)) }),
    allChannels: t.boolean({ description: "True when not restricted to particular channels.", resolve: (m) => m.channelIds.length === 0 }),
    isActive: t.exposeBoolean("isActive"),
    position: t.exposeInt("position"),
  }),
});

type ProviderInfo = { code: string; title: string; description: string | null; plugin: string | null; active: boolean };

const PaymentProviderInfoRef = builder.objectRef<ProviderInfo>("PaymentProviderInfo").implement({
  subGraphs: ADMIN,
  description: "A payment provider payment methods can use: built in, or from a plugin.",
  fields: (t) => ({
    code: t.exposeString("code"),
    title: t.exposeString("title"),
    description: t.exposeString("description", { nullable: true }),
    plugin: t.exposeString("plugin", { nullable: true, description: "The plugin it comes from; null when built in." }),
    active: t.exposeBoolean("active", { description: "False while its plugin is disabled or needs settings: methods using it are not offered at checkout." }),
  }),
});

builder.queryFields((t) => ({
  paymentMethods: t.field({ type: [PaymentMethodRef], subGraphs: ADMIN, authScopes: { permission: "settings:read" }, resolve: (_r, _a, ctx) => listPaymentMethods(ctx.db) }),
  paymentProviders: t.field({
    type: [PaymentProviderInfoRef],
    subGraphs: ADMIN,
    authScopes: { permission: "settings:read" },
    resolve: (_r, _a, ctx) =>
      Promise.all(
        [...ctx.platform.payments.values()].map(async (p) => ({
          code: p.code,
          title: p.title ?? p.code,
          description: p.description ?? null,
          plugin: p.plugin ?? null,
          active: p.plugin ? await ctx.platform.plugins.isActive(p.plugin) : true,
        })),
      ),
  }),
}));

// ---------------------------------------------------------------- inputs

const PaymentMethodInput = builder.inputType("PaymentMethodInput", {
  subGraphs: ADMIN,
  fields: (t) => ({
    code: t.string({ required: true }),
    names: t.field({ type: [LocalizedStringInput], required: true }),
    provider: t.string({ required: true, description: "A provider code from paymentProviders: offline, test_gateway, stripe, …" }),
    captureMode: t.field({ type: CaptureMode }),
    channelIds: t.globalIDList({ for: [ChannelRef] }),
    countries: t.field({ type: ["CountryCode"] }),
    isActive: t.boolean(),
    position: t.int(),
  }),
});
const PaymentMethodUpdateInput = builder.inputType("PaymentMethodUpdateInput", {
  subGraphs: ADMIN,
  description: "Code and provider are fixed once created.",
  fields: (t) => ({
    names: t.field({ type: [LocalizedStringInput] }),
    captureMode: t.field({ type: CaptureMode, description: "Null resets to the provider's default." }),
    countries: t.field({ type: ["CountryCode"] }),
    channelIds: t.globalIDList({ for: [ChannelRef], description: "Empty means every channel." }),
    isActive: t.boolean(),
    position: t.int(),
  }),
});

const PaymentMethodPayload = builder.simpleObject("PaymentMethodPayload", { subGraphs: ADMIN, fields: (t) => ({ paymentMethod: t.field({ type: PaymentMethodRef }) }) });

// ---------------------------------------------------------------- mutations

const write = { subGraphs: ADMIN, authScopes: { permission: "settings:write" }, errors: {} } as const;
const ids = (list: { id: string }[] | null | undefined) => (list ?? []).map(rawId);

builder.mutationFields((t) => ({
  paymentMethodCreate: t.field({
    ...write,
    type: PaymentMethodPayload,
    args: { input: t.arg({ type: PaymentMethodInput, required: true }) },
    resolve: async (_r, { input }, ctx) => ({
      paymentMethod: await createPaymentMethod(ctx.db, ctx.platform.payments, {
        code: input.code,
        name: fromLocalizedList(input.names),
        provider: input.provider,
        channelIds: ids(input.channelIds),
        countries: input.countries ?? [],
        config: input.captureMode ? { captureMode: input.captureMode } : {},
        isActive: input.isActive ?? true,
        position: input.position ?? 0,
      }),
    }),
  }),
  paymentMethodUpdate: t.field({
    ...write,
    type: PaymentMethodPayload,
    args: { id: t.arg.globalID({ for: [PaymentMethodRef], required: true }), input: t.arg({ type: PaymentMethodUpdateInput, required: true }) },
    resolve: async (_r, { id, input }, ctx) => {
      const existing = (await listPaymentMethods(ctx.db)).find((m) => m.id === rawId(id));
      return {
        paymentMethod: await updatePaymentMethod(ctx.db, ctx.platform.payments, rawId(id), {
          ...(input.names ? { name: fromLocalizedList(input.names) } : {}),
          ...(input.captureMode !== undefined ? { config: { ...existing?.config, captureMode: input.captureMode ?? undefined } } : {}),
          ...(input.channelIds ? { channelIds: ids(input.channelIds) } : {}),
          ...Object.fromEntries(Object.entries({ countries: input.countries, isActive: input.isActive, position: input.position }).filter(([, v]) => v != null)),
        }),
      };
    },
  }),
}));
