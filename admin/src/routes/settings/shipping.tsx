import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Trash2, Truck } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, FormSection, reportError } from "@/components/form";
import { CountryMultiSelect, LocalizedInput, MoneyByCurrencyInput, type MoneyByCurrency } from "@/components/inputs";
import { Page, PageHeader } from "@/components/layout/page";
import { initialSettingValues, SettingsForm, settingsErrors, validateSettings, type SettingDescriptor } from "@/components/settings-form";
import { BooleanBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Checkbox, Switch, Tabs, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Alert, EmptyState, Separator, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Sheet, SheetContent } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { countryName } from "@/lib/format";
import { useAction, useReference } from "@/lib/hooks";
import { fromLocalizedList, localized, toLocalizedList } from "@/lib/utils";
import { amountsToList, formatMinor, localizedPairs, objectFieldError, RowActions, SettingsCard } from "./shared";

const ShippingQuery = graphql(`
  query SettingsShipping {
    shippingZones {
      id
      name
      countries
    }
    shippingMethods {
      id
      code
      names {
        locale
        value
      }
      kind
      provider
      providerOptions
      config
      zone {
        id
      }
      allChannels
      channels {
        id
        name
      }
      taxClass {
        id
        name
      }
      minDeliveryDays
      maxDeliveryDays
      isActive
      position
    }
    shippingProviders {
      code
      title
      description
      plugin
      builtIn
      active
      live
      methodOptions {
        key
        label
        description
        type
        required
        options {
          value
          label
        }
        placeholder
        multiline
        min
        max
        integer
        default: defaultValue
      }
    }
  }
`);

type Data = ResultOf<typeof ShippingQuery>;
type Zone = NonNullable<Data["shippingZones"]>[number];
type Method = NonNullable<Data["shippingMethods"]>[number];
/** Installed providers: the built-in rate models, and those of plugins (ecom.config.ts). */
type Provider = NonNullable<Data["shippingProviders"]>[number];

const ZoneCreate = graphql(`mutation ZoneCreate($name: String!, $countries: [CountryCode!]!) { shippingZoneCreate(name: $name, countries: $countries) { __typename ...ErrorFields } }`, [ErrorFields]);
const ZoneUpdate = graphql(`mutation ZoneUpdate($id: ID!, $name: String, $countries: [CountryCode!]) { shippingZoneUpdate(id: $id, name: $name, countries: $countries) { __typename ...ErrorFields } }`, [ErrorFields]);
const ZoneDelete = graphql(`mutation ZoneDelete($id: ID!) { shippingZoneDelete(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);
const MethodCreate = graphql(`mutation MethodCreate($input: ShippingMethodInput!) { shippingMethodCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const MethodUpdate = graphql(`mutation MethodUpdate($id: ID!, $input: ShippingMethodUpdateInput!) { shippingMethodUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const MethodDelete = graphql(`mutation MethodDelete($id: ID!) { shippingMethodDelete(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);

/** The stored rate config (amounts in minor units), as exposed by ShippingMethod.config. */
type StoredConfig =
  | { kind: "flat_rate"; amounts: Record<string, number>; per?: "order" | "item" }
  | { kind: "table_rate"; basis: "weight" | "subtotal" | "quantity"; tiers: { from: number; amounts: Record<string, number> }[] }
  | { kind: "free"; minimumSubtotals: Record<string, number> };

type Basis = "WEIGHT" | "SUBTOTAL" | "QUANTITY";
type RateState = {
  kind: "flat" | "table" | "free" | "provider";
  prices: MoneyByCurrency[];
  perItem: boolean;
  basis: Basis;
  tiers: { from: string; prices: MoneyByCurrency[] }[];
  minimumSubtotals: MoneyByCurrency[];
  /** Another provider (kind "provider"): its code and option values, as SettingsForm edits them. */
  provider: string;
  options: Record<string, unknown>;
};

const BASIS_UNIT: Record<Basis, string> = { WEIGHT: "g", SUBTOTAL: "subtotal", QUANTITY: "items" };

/** Subtotal thresholds are minor units; edit them as amounts with two decimals. */
const tierFromDisplay = (from: number, basis: Basis) => (basis === "SUBTOTAL" ? (from / 100).toFixed(2) : String(from));
const tierFromValue = (from: string, basis: Basis) => (basis === "SUBTOTAL" ? Math.round(Number(from) * 100) : Math.round(Number(from)));

/** A provider's method options as SettingsForm takes them, with a method's stored values. */
const optionFields = (provider: Provider | undefined, stored?: unknown): SettingDescriptor[] =>
  (provider?.methodOptions ?? []).map((o) => ({
    ...o,
    key: o.key ?? "",
    label: o.label ?? o.key ?? "",
    type: o.type ?? "STRING",
    options: o.options?.map((c) => ({ value: c.value ?? "", label: c.label ?? c.value ?? "" })) ?? null,
    value: (stored as Record<string, unknown> | null | undefined)?.[o.key ?? ""],
  }));

const toRateState = (method: Method | null, providers: readonly Provider[]): RateState => {
  const empty: RateState = { kind: "flat", prices: [], perItem: false, basis: "WEIGHT", tiers: [{ from: "0", prices: [] }], minimumSubtotals: [], provider: "", options: {} };
  if (method && !method.kind) {
    const provider = providers.find((p) => p.code === method.provider);
    return { ...empty, kind: "provider", provider: method.provider ?? "", options: initialSettingValues(optionFields(provider, method.providerOptions)) };
  }
  const config = (method?.config as StoredConfig | undefined) ?? null;
  if (!config) return empty;
  if (config.kind === "flat_rate") return { ...empty, kind: "flat", prices: amountsToList(config.amounts), perItem: config.per === "item" };
  if (config.kind === "free") return { ...empty, kind: "free", minimumSubtotals: amountsToList(config.minimumSubtotals) };
  const basis = config.basis.toUpperCase() as Basis;
  return { ...empty, kind: "table", basis, tiers: config.tiers.map((t) => ({ from: tierFromDisplay(t.from, basis), prices: amountsToList(t.amounts) })) };
};

const toRateInput = (rate: RateState) => {
  const clean = (list: MoneyByCurrency[]) => list.filter((m) => m.amount.trim() !== "").map((m) => ({ currencyCode: m.currencyCode, amount: m.amount.trim() }));
  // The whole set of options: blanks are left out, so the provider's defaults apply.
  if (rate.kind === "provider") return { provider: { code: rate.provider, options: Object.fromEntries(Object.entries(rate.options).filter(([, v]) => v !== undefined && v !== null && v !== "")) } };
  if (rate.kind === "flat") return { flatRate: { prices: clean(rate.prices), perItem: rate.perItem } };
  if (rate.kind === "free") return { free: { minimumSubtotals: clean(rate.minimumSubtotals) } };
  return { tableRate: { basis: rate.basis, tiers: rate.tiers.map((t) => ({ from: tierFromValue(t.from, rate.basis), prices: clean(t.prices) })) } };
};

const amounts = (record: Record<string, number>) =>
  Object.entries(record)
    .map(([currency, minor]) => formatMinor(minor, currency))
    .join(" · ");

/** A plugin's provider that is not set up yet: its methods offer no rates until it is. */
const NeedsSetup = ({ plugin }: { plugin: string }) => (
  <Link to="/settings/plugins/$name" params={{ name: plugin }} onClick={(e) => e.stopPropagation()}>
    <Badge variant="warning">Needs setup</Badge>
  </Link>
);

const ProviderRate = ({ code, providers }: { code: string; providers: readonly Provider[] }) => {
  const provider = providers.find((p) => p.code === code);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="secondary">{provider?.title ?? code}</Badge>
      {provider?.live ? <span className="text-muted-foreground">live rates</span> : null}
      {!provider ? <Badge variant="destructive">Not installed</Badge> : !provider.active && provider.plugin ? <NeedsSetup plugin={provider.plugin} /> : null}
    </span>
  );
};

const describeRate = (config: StoredConfig | null) => {
  if (!config) return "—";
  if (config.kind === "flat_rate") return `${amounts(config.amounts) || "Free"} per ${config.per === "item" ? "item" : "order"}`;
  if (config.kind === "free") return Object.keys(config.minimumSubtotals).length ? `Free from ${amounts(config.minimumSubtotals)}` : "Always free";
  return `${config.tiers.length} tier${config.tiers.length === 1 ? "" : "s"} by ${config.basis}`;
};

const INVALIDATE = [["settings-shipping"]];

export const ShippingPage = () => {
  const { can } = useAuth();
  const { defaultLocale, channels } = useReference();
  const query = useQuery({ queryKey: ["settings-shipping"], queryFn: () => request(ShippingQuery) });
  const [zoneDialog, setZoneDialog] = useState<Zone | "new" | null>(null);
  const [deletingZone, setDeletingZone] = useState<Zone | null>(null);
  const [methodEditor, setMethodEditor] = useState<{ method: Method | null; zoneId: string } | null>(null);
  const [deletingMethod, setDeletingMethod] = useState<Method | null>(null);
  const write = can("settings:write");

  const removeZone = useAction((id: string) => request(ZoneDelete, { id }).then((r) => unwrap(r.shippingZoneDelete)), { success: "Zone deleted", invalidate: INVALIDATE, onSuccess: () => setDeletingZone(null) });
  const removeMethod = useAction((id: string) => request(MethodDelete, { id }).then((r) => unwrap(r.shippingMethodDelete)), {
    success: "Shipping method deleted",
    invalidate: INVALIDATE,
    onSuccess: () => setDeletingMethod(null),
  });

  const zones = [...(query.data?.shippingZones ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const methods = query.data?.shippingMethods ?? [];
  const providers = query.data?.shippingProviders ?? [];

  return (
    <Page>
      <PageHeader
        title="Shipping"
        description="A zone is a set of countries; each method in it prices shipping as a flat rate, a table of tiers, free above a subtotal, or with a plugin's provider such as live carrier rates."
        actions={
          write ? (
            <Button onClick={() => setZoneDialog("new")}>
              <Plus />
              Add zone
            </Button>
          ) : null
        }
      />
      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : zones.length === 0 ? (
        <SettingsCard title="Shipping zones">
          <EmptyState icon={Truck} title="No shipping zones" description="Add a zone with the countries you ship to, then add methods to it." />
        </SettingsCard>
      ) : (
        <div className="flex flex-col gap-6">
          {zones.map((zone) => {
            const zoneMethods = methods.filter((m) => m.zone?.id === zone.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            return (
              <SettingsCard
                key={zone.id}
                title={zone.name}
                description={<span title={(zone.countries ?? []).map(countryName).join(", ")}>{(zone.countries ?? []).map((c) => countryName(c)).slice(0, 6).join(", ")}{(zone.countries ?? []).length > 6 ? ` and ${(zone.countries ?? []).length - 6} more` : ""}</span>}
                action={
                  write ? (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => setMethodEditor({ method: null, zoneId: zone.id })}>
                        <Plus />
                        Add method
                      </Button>
                      <RowActions onEdit={() => setZoneDialog(zone)} onDelete={() => setDeletingZone(zone)} deleteLabel="Delete zone" />
                    </div>
                  ) : null
                }
              >
                {zoneMethods.length === 0 ? (
                  <p className="px-5 pb-5 text-[13px] text-muted-foreground">No methods yet — customers in this zone cannot check out with shipping.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Method</TableHead>
                        <TableHead>Rate</TableHead>
                        <TableHead>Channels</TableHead>
                        <TableHead>Tax class</TableHead>
                        <TableHead>Delivery</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {zoneMethods.map((m) => (
                        <TableRow key={m.id} className={write ? "cursor-pointer" : undefined} onClick={() => write && setMethodEditor({ method: m, zoneId: zone.id })}>
                          <TableCell>
                            <span className="font-medium">{localized(localizedPairs(m.names), defaultLocale) || m.code}</span>
                            <p className="font-mono text-xs text-muted-foreground">{m.code}</p>
                          </TableCell>
                          <TableCell className="text-[13px]">{m.kind ? describeRate(m.config as StoredConfig) : <ProviderRate code={m.provider ?? ""} providers={providers} />}</TableCell>
                          <TableCell className="text-muted-foreground">{m.allChannels ? "All" : (m.channels ?? []).map((c) => c.name).join(", ")}</TableCell>
                          <TableCell className="text-muted-foreground">{m.taxClass?.name ?? "Channel default"}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {m.minDeliveryDays != null || m.maxDeliveryDays != null ? `${m.minDeliveryDays ?? "?"}–${m.maxDeliveryDays ?? "?"} days` : "—"}
                          </TableCell>
                          <TableCell>
                            <BooleanBadge value={m.isActive} />
                          </TableCell>
                          <TableCell>{write ? <RowActions onEdit={() => setMethodEditor({ method: m, zoneId: zone.id })} onDelete={() => setDeletingMethod(m)} /> : null}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </SettingsCard>
            );
          })}
        </div>
      )}

      {zoneDialog !== null ? <ZoneDialog key={zoneDialog === "new" ? "new" : zoneDialog.id} zone={zoneDialog === "new" ? null : zoneDialog} onClose={() => setZoneDialog(null)} /> : null}
      <Sheet open={methodEditor !== null} onOpenChange={(open) => !open && setMethodEditor(null)}>
        {methodEditor ? (
          <MethodEditor key={methodEditor.method?.id ?? `new-${methodEditor.zoneId}`} method={methodEditor.method} zoneId={methodEditor.zoneId} zones={zones} providers={providers} onDone={() => setMethodEditor(null)} />
        ) : null}
      </Sheet>
      <ConfirmDialog
        open={!!deletingZone}
        onOpenChange={(open) => !open && setDeletingZone(null)}
        title={`Delete zone ${deletingZone?.name ?? ""}?`}
        description="Zones that still have methods cannot be deleted; delete their methods first."
        destructive
        confirmLabel="Delete zone"
        loading={removeZone.isPending}
        onConfirm={() => deletingZone && removeZone.mutate(deletingZone.id)}
      />
      <ConfirmDialog
        open={!!deletingMethod}
        onOpenChange={(open) => !open && setDeletingMethod(null)}
        title={`Delete ${localized(localizedPairs(deletingMethod?.names), defaultLocale) || deletingMethod?.code || "method"}?`}
        description="Existing orders keep their own copy of the method; carts stop offering it."
        destructive
        confirmLabel="Delete method"
        loading={removeMethod.isPending}
        onConfirm={() => deletingMethod && removeMethod.mutate(deletingMethod.id)}
      />
    </Page>
  );
};

const ZoneDialog = ({ zone, onClose }: { zone: Zone | null; onClose: () => void }) => {
  const form = useForm<{ name: string; countries: string[] }>({ defaultValues: { name: zone?.name ?? "", countries: zone?.countries ?? [] } });
  const save = useAction(
    async (v: { name: string; countries: string[] }) => {
      if (zone) return unwrap((await request(ZoneUpdate, { id: zone.id, name: v.name.trim(), countries: v.countries })).shippingZoneUpdate);
      return unwrap((await request(ZoneCreate, { name: v.name.trim(), countries: v.countries })).shippingZoneCreate);
    },
    { success: zone ? "Zone saved" : "Zone created", invalidate: INVALIDATE, onSuccess: onClose, onError: (error) => reportError(error, form, []) },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{zone ? `Edit ${zone.name}` : "New shipping zone"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <Field label="Name" required error={form.formState.errors.name?.message}>
            <Input placeholder="Domestic" {...form.register("name", { required: "Required" })} />
          </Field>
          <Field label="Countries" required error={form.formState.errors.countries?.message}>
            <Controller
              control={form.control}
              name="countries"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one" }}
              render={({ field }) => <CountryMultiSelect value={field.value} onChange={field.onChange} placeholder="Pick countries" />}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {zone ? "Save zone" : "Create zone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

type MethodForm = {
  code: string;
  names: Record<string, string>;
  zoneId: string;
  channelIds: string[];
  isActive: boolean;
  position: number;
  minDeliveryDays: string;
  maxDeliveryDays: string;
  taxClassId: string;
  rate: RateState;
};

const OPTIONS_PATH = ["input", "config", "options"];

const MethodEditor = ({ method, zoneId, zones, providers, onDone }: { method: Method | null; zoneId: string; zones: Zone[]; providers: readonly Provider[]; onDone: () => void }) => {
  const { locales, currencies, channels, taxClasses } = useReference();
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const form = useForm<MethodForm>({
    defaultValues: {
      code: method?.code ?? "",
      names: fromLocalizedList(localizedPairs(method?.names)),
      zoneId: method?.zone?.id ?? zoneId,
      channelIds: !method || method.allChannels ? [] : (method.channels ?? []).map((c) => c.id),
      isActive: method?.isActive ?? true,
      position: method?.position ?? 0,
      minDeliveryDays: method?.minDeliveryDays != null ? String(method.minDeliveryDays) : "",
      maxDeliveryDays: method?.maxDeliveryDays != null ? String(method.maxDeliveryDays) : "",
      taxClassId: method?.taxClass?.id ?? "",
      rate: toRateState(method, providers),
    },
  });
  const rate = form.watch("rate");
  const setRate = (patch: Partial<RateState>) => form.setValue("rate", { ...form.getValues("rate"), ...patch }, { shouldDirty: true });
  // Built-in rate models have their own editors below; every other provider is a tab with its options.
  const others = providers.filter((p) => !p.builtIn);
  const selected = rate.kind === "provider" ? providers.find((p) => p.code === rate.provider) : undefined;
  const fields = optionFields(selected);
  const tab = rate.kind === "provider" ? `provider:${rate.provider}` : rate.kind;
  const chooseTab = (value: string) => {
    if (!value.startsWith("provider:")) return setRate({ kind: value as RateState["kind"] });
    const code = value.slice("provider:".length);
    if (code === rate.provider) return setRate({ kind: "provider" });
    setOptionErrors({});
    setRate({ kind: "provider", provider: code, options: initialSettingValues(optionFields(providers.find((p) => p.code === code))) });
  };

  const save = useAction(
    async (v: MethodForm) => {
      const days = (value: string) => (value.trim() === "" ? null : Number(value));
      const common = {
        names: toLocalizedList(v.names),
        channelIds: v.channelIds,
        isActive: v.isActive,
        position: Number(v.position) || 0,
        minDeliveryDays: days(v.minDeliveryDays),
        maxDeliveryDays: days(v.maxDeliveryDays),
        rate: toRateInput(v.rate),
        zoneId: v.zoneId,
        // null removes the override, so the channel's shipping tax class applies.
        taxClassId: v.taxClassId || null,
      };
      if (method) return unwrap((await request(MethodUpdate, { id: method.id, input: common })).shippingMethodUpdate);
      return unwrap((await request(MethodCreate, { input: { ...common, code: v.code.trim() } })).shippingMethodCreate);
    },
    {
      success: method ? "Shipping method saved" : "Shipping method created",
      invalidate: INVALIDATE,
      onSuccess: onDone,
      onError: (error) => {
        setOptionErrors(settingsErrors(error, OPTIONS_PATH));
        reportError(error, form);
      },
    },
  );
  const submit = form.handleSubmit((v) => {
    if (v.rate.kind === "provider") {
      const problems = validateSettings(fields, v.rate.options, { required: true });
      setOptionErrors(problems);
      if (Object.keys(problems).length) return;
    }
    save.mutate(v);
  });
  const errors = form.formState.errors;

  return (
    <SheetContent aria-describedby={undefined} dirty={form.formState.isDirty}>
      <form onSubmit={submit} className="flex flex-col gap-6">
        <div>
          <h2 className="text-base font-semibold">{method ? `Edit ${localized(localizedPairs(method.names), locales[0]) || method.code}` : "New shipping method"}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Shown at checkout for addresses in the zone, in the order of position.</p>
        </div>
        <FormSection title="Method">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" required hint={method ? "Fixed once created." : "e.g. us_standard"} error={errors.code?.message}>
              <Input disabled={!!method} className="font-mono" {...form.register("code", { required: !method && "Required" })} />
            </Field>
            <Field label="Zone">
              <NativeSelect {...form.register("zoneId")}>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Name shown to customers" required error={objectFieldError(errors.names)}>
            <Controller
              control={form.control}
              name="names"
              rules={{ validate: (v) => Object.values(v).some((x) => x.trim()) || "Enter a name" }}
              render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={locales} placeholder="Standard (5–7 days)" />}
            />
          </Field>
          <Field label="Channels" hint="Leave empty to offer it in every channel.">
            <Controller
              control={form.control}
              name="channelIds"
              render={({ field }) => <MultiSelect options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} value={field.value} onChange={field.onChange} placeholder="All channels" />}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Min. days">
              <Input type="number" min={0} {...form.register("minDeliveryDays")} />
            </Field>
            <Field label="Max. days">
              <Input type="number" min={0} {...form.register("maxDeliveryDays")} />
            </Field>
            <Field label="Position" hint="Lower first.">
              <Input type="number" {...form.register("position", { valueAsNumber: true })} />
            </Field>
          </div>
          <Field label="Tax class" hint="Overrides the channel's shipping tax class.">
            <NativeSelect {...form.register("taxClassId")}>
              <option value="">Channel default</option>
              {taxClasses
                .filter((t) => t.kind === "PRODUCT")
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Label className="font-normal">
            <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            Active
          </Label>
        </FormSection>
        <Separator />
        <FormSection
          title="Rate"
          description={rate.kind === "provider" ? "The provider prices each cart; a method can offer several of its rates." : "Amounts are per currency; carts in a currency without an amount do not see the method."}
        >
          <Tabs value={tab} onValueChange={chooseTab}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="flat">Flat rate</TabsTrigger>
              <TabsTrigger value="table">Table rate</TabsTrigger>
              <TabsTrigger value="free">Free</TabsTrigger>
              {others.map((p) => (
                <TabsTrigger key={p.code} value={`provider:${p.code}`}>
                  {p.title}
                </TabsTrigger>
              ))}
              {rate.kind === "provider" && !selected ? <TabsTrigger value={tab}>{rate.provider}</TabsTrigger> : null}
            </TabsList>
          </Tabs>
          {rate.kind === "provider" ? (
            <div className="grid gap-4">
              {selected?.description ? <p className="text-[13px] text-muted-foreground">{selected.description}</p> : null}
              {!selected ? (
                <Alert variant="destructive">The provider {rate.provider} is not installed, so this method offers no rates. Choose another provider, or add its plugin to ecom.config.ts.</Alert>
              ) : !selected.active && selected.plugin ? (
                <Alert variant="warning" title={`${selected.title} needs setup`}>
                  The method offers no rates until{" "}
                  <Link to="/settings/plugins/$name" params={{ name: selected.plugin }} className="font-medium text-primary hover:underline">
                    the {selected.plugin} plugin
                  </Link>{" "}
                  is enabled and configured.
                </Alert>
              ) : null}
              {selected?.live ? <p className="text-xs text-muted-foreground">Rates come from {selected.title} as customers check out and are kept for a few minutes, so checkout never waits on it.</p> : null}
              {fields.length ? (
                <SettingsForm
                  fields={fields}
                  values={rate.options}
                  onChange={(options) => {
                    setOptionErrors({});
                    setRate({ options });
                  }}
                  errors={optionErrors}
                />
              ) : selected ? (
                <p className="text-[13px] text-muted-foreground">{selected.title} has no options per method.</p>
              ) : null}
            </div>
          ) : null}
          {rate.kind === "flat" ? (
            <div className="grid gap-3">
              <MoneyByCurrencyInput value={rate.prices} onChange={(prices) => setRate({ prices })} currencies={currencies} />
              <Label className="font-normal">
                <Checkbox checked={rate.perItem} onCheckedChange={(v) => setRate({ perItem: v === true })} />
                Charge per item instead of per order
              </Label>
            </div>
          ) : null}
          {rate.kind === "free" ? (
            <div className="grid gap-2">
              <p className="text-[13px] text-muted-foreground">Free when the discounted subtotal reaches the amount. Leave empty to always be free.</p>
              <MoneyByCurrencyInput value={rate.minimumSubtotals} onChange={(minimumSubtotals) => setRate({ minimumSubtotals })} currencies={currencies} />
            </div>
          ) : null}
          {rate.kind === "table" ? (
            <div className="grid gap-3">
              <Field label="Priced by" hint={rate.basis === "SUBTOTAL" ? "Thresholds use two decimals and apply in every currency." : rate.basis === "WEIGHT" ? "Thresholds in grams." : "Thresholds in items."}>
                <NativeSelect value={rate.basis} onChange={(e) => setRate({ basis: e.target.value as Basis })} className="w-48">
                  <option value="WEIGHT">Weight</option>
                  <option value="SUBTOTAL">Subtotal</option>
                  <option value="QUANTITY">Quantity</option>
                </NativeSelect>
              </Field>
              {rate.tiers.map((tier, i) => (
                <div key={i} className="rounded-lg border p-3">
                  <div className="mb-3 flex items-center gap-2">
                    <Label className="shrink-0 text-[13px]">From</Label>
                    <Input inputMode="decimal" className="w-32" value={tier.from} onChange={(e) => setRate({ tiers: rate.tiers.map((t, j) => (j === i ? { ...t, from: e.target.value } : t)) })} />
                    <span className="text-[13px] text-muted-foreground">{BASIS_UNIT[rate.basis]}</span>
                    <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" disabled={rate.tiers.length === 1} onClick={() => setRate({ tiers: rate.tiers.filter((_, j) => j !== i) })} aria-label="Remove tier">
                      <Trash2 />
                    </Button>
                  </div>
                  <MoneyByCurrencyInput value={tier.prices} onChange={(prices) => setRate({ tiers: rate.tiers.map((t, j) => (j === i ? { ...t, prices } : t)) })} currencies={currencies} />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setRate({ tiers: [...rate.tiers, { from: "", prices: rate.tiers.at(-1)?.prices.map((p) => ({ ...p, amount: "" })) ?? [] }] })}>
                <Plus />
                Add tier
              </Button>
              <Alert variant="info">The highest tier whose threshold the cart reaches sets the price.</Alert>
            </div>
          ) : null}
        </FormSection>
        <div className="sticky bottom-0 -mx-6 -mb-6 flex justify-end gap-2 border-t bg-popover px-6 py-4">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {method ? "Save method" : "Create method"}
          </Button>
        </div>
      </form>
    </SheetContent>
  );
};
