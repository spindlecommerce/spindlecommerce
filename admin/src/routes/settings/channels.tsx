import { useQuery } from "@tanstack/react-query";
import { Globe, Plus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, FormSection, reportError } from "@/components/form";
import { CountryMultiSelect } from "@/components/inputs";
import { Page, PageHeader } from "@/components/layout/page";
import { BooleanBadge } from "@/components/status";
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
import { CURRENCY_CODES, languageName } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { Chips, COMMON_LOCALES, SettingsCard } from "./shared";

const ChannelsQuery = graphql(`
  query SettingsChannels {
    channels {
      id
      code
      name
      isActive
      locales
      defaultLocale
      currencies
      defaultCurrency
      countries {
        code
        name
      }
      pricesIncludeTax
      orderNumberPrefix
      stock {
        id
        name
      }
      shippingTaxClass {
        id
        name
      }
    }
    taxClasses {
      id
      name
      kind
    }
  }
`);

const StocksQuery = graphql(`
  query ChannelStocks {
    stocks {
      id
      code
      name
    }
  }
`);

const ChannelCreate = graphql(
  `
    mutation ChannelCreate($input: ChannelInput!) {
      channelCreate(input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const ChannelUpdate = graphql(
  `
    mutation ChannelUpdate($id: ID!, $input: ChannelUpdateInput!) {
      channelUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type Channel = NonNullable<ResultOf<typeof ChannelsQuery>["channels"]>[number];

type ChannelForm = {
  code: string;
  name: string;
  isActive: boolean;
  locales: string[];
  defaultLocale: string;
  currencies: string[];
  defaultCurrency: string;
  countries: string[];
  pricesIncludeTax: boolean;
  orderNumberPrefix: string;
  stockId: string;
  shippingTaxClassId: string;
};

const blank: ChannelForm = {
  code: "",
  name: "",
  isActive: true,
  locales: ["en-US"],
  defaultLocale: "en-US",
  currencies: ["USD"],
  defaultCurrency: "USD",
  countries: [],
  pricesIncludeTax: false,
  orderNumberPrefix: "",
  stockId: "",
  shippingTaxClassId: "",
};

const toForm = (c: Channel): ChannelForm => ({
  code: c.code ?? "",
  name: c.name ?? "",
  isActive: c.isActive ?? true,
  locales: c.locales ?? [],
  defaultLocale: c.defaultLocale ?? "",
  currencies: c.currencies ?? [],
  defaultCurrency: c.defaultCurrency ?? "",
  countries: (c.countries ?? []).flatMap((x) => (x.code ? [x.code] : [])),
  pricesIncludeTax: c.pricesIncludeTax ?? false,
  orderNumberPrefix: c.orderNumberPrefix ?? "",
  stockId: c.stock?.id ?? "",
  shippingTaxClassId: c.shippingTaxClass?.id ?? "",
});

export const ChannelsPage = () => {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ["settings-channels"], queryFn: () => request(ChannelsQuery) });
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const write = can("settings:write");
  const channels = query.data?.channels ?? [];

  return (
    <Page>
      <PageHeader
        title="Channels"
        description="Where you sell: each channel has its own languages, currencies, countries, tax display and stock."
        actions={
          write ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add channel
            </Button>
          ) : null
        }
      />
      <SettingsCard title="All channels" description="Products are published per channel; orders, prices and shipping methods belong to one.">
        {query.isLoading ? (
          <div className="space-y-2 px-5 pb-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : channels.length === 0 ? (
          <EmptyState icon={Globe} title="No channels yet" description="Create a channel to start selling." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Languages</TableHead>
                <TableHead>Currencies</TableHead>
                <TableHead>Countries</TableHead>
                <TableHead>Prices</TableHead>
                <TableHead>Order prefix</TableHead>
                <TableHead>Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.map((c) => (
                <TableRow key={c.id} className={write ? "cursor-pointer" : undefined} onClick={() => write && setEditing(c)}>
                  <TableCell>
                    <span className="font-medium">{c.name}</span>
                    <p className="font-mono text-xs text-muted-foreground">{c.code}</p>
                  </TableCell>
                  <TableCell>
                    <BooleanBadge value={c.isActive} />
                  </TableCell>
                  <TableCell>
                    <Chips items={(c.locales ?? []).map((l) => (l === c.defaultLocale ? `${l} ★` : l))} max={4} />
                  </TableCell>
                  <TableCell>
                    <Chips items={(c.currencies ?? []).map((x) => (x === c.defaultCurrency ? `${x} ★` : x))} max={4} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span title={(c.countries ?? []).map((x) => x.name).join(", ")}>{(c.countries ?? []).length} countries</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.pricesIncludeTax ? "Include tax" : "Exclude tax"}</TableCell>
                  <TableCell className="font-mono text-xs">{c.orderNumberPrefix || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.stock?.name ?? "None"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null ? (
          <ChannelEditor key={editing === "new" ? "new" : editing.id} channel={editing === "new" ? null : editing} taxClasses={query.data?.taxClasses ?? []} onDone={() => setEditing(null)} />
        ) : null}
      </Sheet>
    </Page>
  );
};

const ChannelEditor = ({ channel, taxClasses, onDone }: { channel: Channel | null; taxClasses: NonNullable<ResultOf<typeof ChannelsQuery>["taxClasses"]>; onDone: () => void }) => {
  const { can } = useAuth();
  const stocks = useQuery({ queryKey: ["channel-stocks"], queryFn: () => request(StocksQuery), enabled: can("inventory:read") });
  const form = useForm<ChannelForm>({ defaultValues: channel ? toForm(channel) : blank });
  const locales = form.watch("locales");
  const currencies = form.watch("currencies");

  const save = useAction(
    async (values: ChannelForm) => {
      const common = {
        name: values.name.trim(),
        isActive: values.isActive,
        locales: values.locales,
        defaultLocale: values.defaultLocale,
        currencies: values.currencies,
        defaultCurrency: values.defaultCurrency,
        countries: values.countries,
        pricesIncludeTax: values.pricesIncludeTax,
        orderNumberPrefix: values.orderNumberPrefix.trim(),
        stockId: values.stockId || null,
        shippingTaxClassId: values.shippingTaxClassId || null,
      };
      if (channel) return unwrap((await request(ChannelUpdate, { id: channel.id, input: common })).channelUpdate);
      return unwrap((await request(ChannelCreate, { input: { ...common, code: values.code.trim() } })).channelCreate);
    },
    {
      success: channel ? "Channel saved" : "Channel created",
      invalidate: [["settings-channels"], ["reference"]],
      onSuccess: onDone,
      onError: (error) => reportError(error, form),
    },
  );

  const localeOptions = [...new Set([...COMMON_LOCALES, ...locales])].map((l) => ({ value: l, label: l, hint: languageName(l) }));
  const currencyOptions = [...new Set([...CURRENCY_CODES, ...currencies])].map((c) => ({ value: c, label: c }));
  const errors = form.formState.errors;

  return (
    <SheetContent aria-describedby={undefined} dirty={form.formState.isDirty}>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))} className="flex flex-col gap-6">
        <div>
          <h2 className="text-base font-semibold">{channel ? `Edit ${channel.name}` : "New channel"}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Changing languages or currencies does not touch existing prices or translations.</p>
        </div>
        <FormSection title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Code" required hint={channel ? "Fixed once created." : "Lowercase letters, digits and hyphens, e.g. eu."} error={errors.code?.message}>
              <Input disabled={!!channel} className="font-mono" {...form.register("code", { required: !channel && "Required" })} />
            </Field>
            <Field label="Name" required error={errors.name?.message}>
              <Input {...form.register("name", { required: "Required" })} />
            </Field>
          </div>
          <Label className="font-normal">
            <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            Active — inactive channels accept no carts or orders
          </Label>
        </FormSection>
        <Separator />
        <FormSection title="Languages and currencies">
          <Field label="Languages" required error={errors.locales?.message}>
            <Controller
              control={form.control}
              name="locales"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one" }}
              render={({ field }) => (
                <MultiSelect
                  options={localeOptions}
                  value={field.value}
                  onChange={(next) => {
                    field.onChange(next);
                    if (!next.includes(form.getValues("defaultLocale"))) form.setValue("defaultLocale", next[0] ?? "");
                  }}
                  placeholder="Pick languages"
                />
              )}
            />
          </Field>
          <Field label="Default language" required error={errors.defaultLocale?.message}>
            <NativeSelect {...form.register("defaultLocale", { required: "Required" })}>
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l} — {languageName(l)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Currencies" required error={errors.currencies?.message}>
            <Controller
              control={form.control}
              name="currencies"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one" }}
              render={({ field }) => (
                <MultiSelect
                  options={currencyOptions}
                  value={field.value}
                  onChange={(next) => {
                    field.onChange(next);
                    if (!next.includes(form.getValues("defaultCurrency"))) form.setValue("defaultCurrency", next[0] ?? "");
                  }}
                  placeholder="Pick currencies"
                />
              )}
            />
          </Field>
          <Field label="Default currency" required hint="Variants without a price in another currency convert from this one using exchange rates." error={errors.defaultCurrency?.message}>
            <NativeSelect {...form.register("defaultCurrency", { required: "Required" })}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </NativeSelect>
          </Field>
        </FormSection>
        <Separator />
        <FormSection title="Selling">
          <Field label="Countries sold to" required hint="Checkout refuses shipping addresses elsewhere." error={errors.countries?.message}>
            <Controller
              control={form.control}
              name="countries"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one" }}
              render={({ field }) => <CountryMultiSelect value={field.value} onChange={field.onChange} placeholder="Pick countries" />}
            />
          </Field>
          <Label className="font-normal">
            <Controller control={form.control} name="pricesIncludeTax" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            Prices include tax (typical in the EU and UK)
          </Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Order number prefix" hint="e.g. EU- gives EU-000123" error={errors.orderNumberPrefix?.message}>
              <Input maxLength={10} className="font-mono" {...form.register("orderNumberPrefix")} />
            </Field>
            <Field label="Shipping tax class" hint="Tax class used to tax shipping charges.">
              <NativeSelect {...form.register("shippingTaxClassId")}>
                <option value="">Not taxed</option>
                {taxClasses
                  .filter((t) => t.kind === "PRODUCT")
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Stock" hint={can("inventory:read") ? "Which locations this channel sells from." : "Needs the inventory:read permission to change."}>
            <NativeSelect {...form.register("stockId")} disabled={!can("inventory:read")}>
              <option value="">No stock (nothing is reserved)</option>
              {(stocks.data?.stocks ?? (channel?.stock ? [{ id: channel.stock.id, code: "", name: channel.stock.name }] : [])).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </FormSection>
        <div className="sticky bottom-0 -mx-6 -mb-6 flex justify-end gap-2 border-t bg-popover px-6 py-4">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {channel ? "Save channel" : "Create channel"}
          </Button>
        </div>
      </form>
    </SheetContent>
  );
};
