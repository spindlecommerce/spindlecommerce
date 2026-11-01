import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CreditCard, Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, FormSection, reportError } from "@/components/form";
import { CountryMultiSelect, LocalizedInput } from "@/components/inputs";
import { Page, PageHeader } from "@/components/layout/page";
import { BooleanBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { EmptyState, Separator, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { countryName } from "@/lib/format";
import { useAction, useReference } from "@/lib/hooks";
import { fromLocalizedList, localized, toLocalizedList } from "@/lib/utils";
import { Chips, localizedPairs, objectFieldError, SettingsCard } from "./shared";

const PaymentMethodsQuery = graphql(`
  query SettingsPaymentMethods {
    paymentMethods {
      id
      code
      provider
      names {
        locale
        value
      }
      captureMode
      countries
      allChannels
      channels {
        id
        name
      }
      isActive
      position
    }
    paymentProviders {
      code
      title
      description
      plugin
      active
    }
  }
`);

type Method = NonNullable<ResultOf<typeof PaymentMethodsQuery>["paymentMethods"]>[number];
/** Installed providers: built in, or from plugins (ecom.config.ts). */
type Provider = NonNullable<ResultOf<typeof PaymentMethodsQuery>["paymentProviders"]>[number];

const MethodCreate = graphql(`mutation PaymentMethodCreate($input: PaymentMethodInput!) { paymentMethodCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const MethodUpdate = graphql(`mutation PaymentMethodUpdate($id: ID!, $input: PaymentMethodUpdateInput!) { paymentMethodUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);

/** A plugin's provider that is not set up yet: its methods are hidden at checkout until it is. */
const NeedsSetup = ({ plugin }: { plugin: string }) => (
  <Link to="/settings/plugins/$name" params={{ name: plugin }} onClick={(e) => e.stopPropagation()}>
    <Badge variant="warning">Needs setup</Badge>
  </Link>
);

const ProviderBadge = ({ code, providers }: { code: string; providers: readonly Provider[] }) => {
  const provider = providers.find((p) => p.code === code);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="secondary">{provider?.title ?? code}</Badge>
      {!provider ? <Badge variant="destructive">Not installed</Badge> : !provider.active && provider.plugin ? <NeedsSetup plugin={provider.plugin} /> : null}
    </span>
  );
};

export const PaymentsPage = () => {
  const { can } = useAuth();
  const { defaultLocale } = useReference();
  const query = useQuery({ queryKey: ["settings-payments"], queryFn: () => request(PaymentMethodsQuery) });
  const [editing, setEditing] = useState<Method | "new" | null>(null);
  const write = can("settings:write");
  const methods = [...(query.data?.paymentMethods ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const providers = query.data?.paymentProviders ?? [];

  return (
    <Page>
      <PageHeader
        title="Payments"
        description="Methods customers can pay with, in checkout order. Turn a method off instead of deleting it: past orders refer to it for captures and refunds."
        actions={
          write ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add payment method
            </Button>
          ) : null
        }
      />
      <SettingsCard title="Payment methods">
        {query.isLoading ? (
          <div className="space-y-2 px-5 pb-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : methods.length === 0 ? (
          <EmptyState icon={CreditCard} title="No payment methods" description="Customers cannot check out until at least one method is active." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Method</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Capture</TableHead>
                <TableHead>Countries</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead className="text-right">Position</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {methods.map((m) => (
                <TableRow key={m.id} className={write ? "cursor-pointer" : undefined} onClick={() => write && setEditing(m)}>
                  <TableCell>
                    <span className="font-medium">{localized(localizedPairs(m.names), defaultLocale) || m.code}</span>
                    <p className="font-mono text-xs text-muted-foreground">{m.code}</p>
                  </TableCell>
                  <TableCell>
                    <ProviderBadge code={m.provider ?? ""} providers={providers} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.captureMode === "AUTHORIZE_CAPTURE" ? "At checkout" : m.captureMode === "AUTHORIZE" ? "Later (authorize only)" : "Provider default"}</TableCell>
                  <TableCell>
                    <Chips items={(m.countries ?? []).map((c) => countryName(c))} max={3} empty="All countries" />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.allChannels ? "All" : (m.channels ?? []).map((c) => c.name).join(", ")}</TableCell>
                  <TableCell className="tabular text-right">{m.position}</TableCell>
                  <TableCell>
                    <BooleanBadge value={m.isActive} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null ? <MethodEditor key={editing === "new" ? "new" : editing.id} method={editing === "new" ? null : editing} providers={providers} onDone={() => setEditing(null)} /> : null}
      </Sheet>
    </Page>
  );
};

type MethodForm = {
  code: string;
  provider: string;
  names: Record<string, string>;
  captureMode: "" | "AUTHORIZE" | "AUTHORIZE_CAPTURE";
  countries: string[];
  channelIds: string[];
  isActive: boolean;
  position: number;
};

const MethodEditor = ({ method, providers, onDone }: { method: Method | null; providers: readonly Provider[]; onDone: () => void }) => {
  const { locales, channels } = useReference();
  const form = useForm<MethodForm>({
    defaultValues: {
      code: method?.code ?? "",
      provider: method?.provider ?? "offline",
      names: fromLocalizedList(localizedPairs(method?.names)),
      captureMode: method?.captureMode ?? "",
      countries: method?.countries ?? [],
      channelIds: !method || method.allChannels ? [] : (method.channels ?? []).map((c) => c.id),
      isActive: method?.isActive ?? true,
      position: method?.position ?? 0,
    },
  });
  const selected = providers.find((p) => p.code === form.watch("provider"));
  const save = useAction(
    async (v: MethodForm) => {
      // captureMode null means the provider default; empty channelIds means every channel.
      const common = { names: toLocalizedList(v.names), captureMode: v.captureMode || null, countries: v.countries, channelIds: v.channelIds, isActive: v.isActive, position: Number(v.position) || 0 };
      if (method) return unwrap((await request(MethodUpdate, { id: method.id, input: common })).paymentMethodUpdate);
      return unwrap((await request(MethodCreate, { input: { ...common, code: v.code.trim(), provider: v.provider } })).paymentMethodCreate);
    },
    { success: method ? "Payment method saved" : "Payment method created", invalidate: [["settings-payments"]], onSuccess: onDone, onError: (error) => reportError(error, form) },
  );
  const errors = form.formState.errors;

  return (
    <SheetContent aria-describedby={undefined} dirty={form.formState.isDirty}>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-6">
        <div>
          <h2 className="text-base font-semibold">{method ? `Edit ${localized(localizedPairs(method.names), locales[0]) || method.code}` : "New payment method"}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Shown at checkout when the cart's channel, billing country and total allow it.</p>
        </div>
        <FormSection title="Method">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" required hint={method ? "Fixed once created." : "e.g. banktransfer"} error={errors.code?.message}>
              <Input disabled={!!method} className="font-mono" {...form.register("code", { required: !method && "Required" })} />
            </Field>
            <Field label="Provider" hint={method ? "Fixed once created." : undefined} error={errors.provider?.message}>
              <NativeSelect disabled={!!method} {...form.register("provider")}>
                {providers.map((p) => (
                  <option key={p.code} value={p.code ?? ""}>
                    {p.title}
                    {p.active ? "" : " (needs setup)"}
                  </option>
                ))}
                {method && !providers.some((p) => p.code === method.provider) ? <option value={method.provider ?? ""}>{method.provider} (not installed)</option> : null}
              </NativeSelect>
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            {selected?.description}
            {selected && !selected.active && selected.plugin ? (
              <>
                {" "}
                Not offered at checkout until{" "}
                <Link to="/settings/plugins/$name" params={{ name: selected.plugin }} className="text-primary hover:underline">
                  the {selected.plugin} plugin is set up
                </Link>
                .
              </>
            ) : null}
          </p>
          <Field label="Name shown to customers" required error={objectFieldError(errors.names)}>
            <Controller
              control={form.control}
              name="names"
              rules={{ validate: (v) => Object.values(v).some((x) => x.trim()) || "Enter a name" }}
              render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={locales} placeholder="Bank transfer" />}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Capture" hint="When the money is taken.">
              <NativeSelect {...form.register("captureMode")}>
                <option value="">Provider default</option>
                <option value="AUTHORIZE">Later — authorize at checkout, capture on shipment</option>
                <option value="AUTHORIZE_CAPTURE">At checkout</option>
              </NativeSelect>
            </Field>
            <Field label="Position" hint="Lower first.">
              <Input type="number" {...form.register("position", { valueAsNumber: true })} />
            </Field>
          </div>
          <Label className="font-normal">
            <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            Active
          </Label>
        </FormSection>
        <Separator />
        <FormSection title="Availability">
          <Field label="Billing countries" hint="Leave empty to allow every country.">
            <Controller control={form.control} name="countries" render={({ field }) => <CountryMultiSelect value={field.value} onChange={field.onChange} placeholder="All countries" />} />
          </Field>
          <Field label="Channels" hint="Leave empty to offer it in every channel.">
            <Controller
              control={form.control}
              name="channelIds"
              render={({ field }) => <MultiSelect options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} value={field.value} onChange={field.onChange} placeholder="All channels" />}
            />
          </Field>
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
