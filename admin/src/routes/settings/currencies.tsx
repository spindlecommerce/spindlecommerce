import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Coins, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CURRENCY_CODES, relativeTime } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { RowActions, SettingsCard } from "./shared";

const CurrenciesQuery = graphql(`
  query SettingsCurrencies {
    channels {
      id
      code
      name
      currencies
      defaultCurrency
    }
    exchangeRates {
      baseCurrency
      quoteCurrency
      rate
      updatedAt
    }
  }
`);

type Rate = NonNullable<ResultOf<typeof CurrenciesQuery>["exchangeRates"]>[number];

const RateSet = graphql(
  `
    mutation ExchangeRateSet($baseCurrency: CurrencyCode!, $quoteCurrency: CurrencyCode!, $rate: Float!) {
      exchangeRateSet(baseCurrency: $baseCurrency, quoteCurrency: $quoteCurrency, rate: $rate) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const RateDelete = graphql(
  `
    mutation ExchangeRateDelete($baseCurrency: CurrencyCode!, $quoteCurrency: CurrencyCode!) {
      exchangeRateDelete(baseCurrency: $baseCurrency, quoteCurrency: $quoteCurrency) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const CurrenciesPage = () => {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ["settings-currencies"], queryFn: () => request(CurrenciesQuery) });
  const [editing, setEditing] = useState<Partial<Rate> | null>(null);
  const [deleting, setDeleting] = useState<Rate | null>(null);
  const write = can("settings:write");
  const channels = query.data?.channels ?? [];
  const rates = query.data?.exchangeRates ?? [];
  const has = (base: string, quote: string) => rates.some((r) => r.baseCurrency === base && r.quoteCurrency === quote);
  const missing = [
    ...new Map(
      channels.flatMap((c) =>
        (c.currencies ?? [])
          .filter((currency) => currency !== c.defaultCurrency && c.defaultCurrency && !has(c.defaultCurrency, currency))
          .map((currency) => [`${c.defaultCurrency}/${currency}`, { base: c.defaultCurrency!, quote: currency, channel: c.name ?? c.code ?? "" }] as const),
      ),
    ).values(),
  ];

  const remove = useAction(
    (rate: Rate) => request(RateDelete, { baseCurrency: rate.baseCurrency!, quoteCurrency: rate.quoteCurrency! }).then((r) => unwrap(r.exchangeRateDelete)),
    { success: "Exchange rate deleted", invalidate: [["settings-currencies"]], onSuccess: () => setDeleting(null) },
  );

  return (
    <Page>
      <PageHeader
        title="Currencies"
        description="Each channel sells in its own currencies. A variant without a price in a currency is converted from the channel's default currency with these rates."
        actions={
          write ? (
            <Button onClick={() => setEditing({})}>
              <Plus />
              Add exchange rate
            </Button>
          ) : null
        }
      />
      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex flex-col gap-6">
          <SettingsCard
            title="Currencies by channel"
            description="★ marks the default currency."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/settings/channels">Edit on Channels</Link>
              </Button>
            }
          >
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {channels.map((c) => (
                <div key={c.id} className="rounded-lg border p-3">
                  <p className="text-[13px] font-medium">{c.name}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(c.currencies ?? []).map((currency) => (
                      <Badge key={currency} variant={currency === c.defaultCurrency ? "default" : "secondary"}>
                        {currency}
                        {currency === c.defaultCurrency ? " ★" : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </SettingsCard>

          {missing.length ? (
            <Alert
              variant="warning"
              title="Missing exchange rates"
              action={
                write ? (
                  <Button size="sm" variant="outline" onClick={() => setEditing({ baseCurrency: missing[0]!.base, quoteCurrency: missing[0]!.quote })}>
                    Add {missing[0]!.base} → {missing[0]!.quote}
                  </Button>
                ) : undefined
              }
            >
              Variants without an explicit price in these currencies cannot be sold:{" "}
              {missing.map((m) => `${m.base} → ${m.quote} (${m.channel})`).join(", ")}.
            </Alert>
          ) : null}

          <SettingsCard title="Exchange rates" description="1 unit of the base currency in the quote currency.">
            {rates.length === 0 ? (
              <EmptyState icon={Coins} title="No exchange rates" description="Only needed when a channel sells in more than one currency without per-currency prices." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Pair</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead>Example</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rates.map((rate) => (
                    <TableRow key={`${rate.baseCurrency}/${rate.quoteCurrency}`}>
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {rate.baseCurrency} <ArrowRight className="size-3.5 text-muted-foreground" /> {rate.quoteCurrency}
                        </span>
                      </TableCell>
                      <TableCell className="tabular text-right font-mono">{rate.rate}</TableCell>
                      <TableCell className="text-muted-foreground">
                        100 {rate.baseCurrency} = {((rate.rate ?? 0) * 100).toFixed(2)} {rate.quoteCurrency}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{relativeTime(rate.updatedAt)}</TableCell>
                      <TableCell>{write ? <RowActions onEdit={() => setEditing(rate)} onDelete={() => setDeleting(rate)} /> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SettingsCard>
        </div>
      )}
      {editing ? <RateDialog key={`${editing.baseCurrency}/${editing.quoteCurrency}`} rate={editing} existing={rates} channelCurrencies={[...new Set(channels.flatMap((c) => c.currencies ?? []))]} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.baseCurrency} → ${deleting?.quoteCurrency}?`}
        description="Variants without an explicit price in the quote currency stop having a price there."
        destructive
        confirmLabel="Delete rate"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Page>
  );
};

type RateForm = { baseCurrency: string; quoteCurrency: string; rate: string };

const RateDialog = ({ rate, existing, channelCurrencies, onClose }: { rate: Partial<Rate>; existing: Rate[]; channelCurrencies: string[]; onClose: () => void }) => {
  const editingExisting = existing.some((r) => r.baseCurrency === rate.baseCurrency && r.quoteCurrency === rate.quoteCurrency);
  const form = useForm<RateForm>({
    defaultValues: { baseCurrency: rate.baseCurrency ?? channelCurrencies[0] ?? "USD", quoteCurrency: rate.quoteCurrency ?? channelCurrencies[1] ?? "EUR", rate: rate.rate ? String(rate.rate) : "" },
  });
  const options = [...new Set([...channelCurrencies, ...CURRENCY_CODES])];
  const save = useAction(
    (v: RateForm) => request(RateSet, { baseCurrency: v.baseCurrency, quoteCurrency: v.quoteCurrency, rate: Number(v.rate) }).then((r) => unwrap(r.exchangeRateSet)),
    { success: "Exchange rate saved", invalidate: [["settings-currencies"]], onSuccess: onClose, onError: (error) => reportError(error, form, []) },
  );
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{editingExisting ? "Edit exchange rate" : "New exchange rate"}</DialogTitle>
          <DialogDescription>Converted prices are rounded to the quote currency's minor unit at checkout.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From (base)">
              <NativeSelect disabled={editingExisting} {...form.register("baseCurrency")}>
                {options.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="To (quote)" error={errors.quoteCurrency?.message}>
              <NativeSelect disabled={editingExisting} {...form.register("quoteCurrency", { validate: (v) => v !== form.getValues("baseCurrency") || "Pick a different currency" })}>
                {options.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Rate" required hint="1 base = this many quote, e.g. 0.92" error={errors.rate?.message}>
            <Input inputMode="decimal" className="font-mono" {...form.register("rate", { required: "Required", validate: (v) => Number(v) > 0 || "Must be positive" })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save rate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
