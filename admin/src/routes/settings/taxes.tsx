import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox, MultiSelect } from "@/components/ui/combobox";
import { SectionTabsList, SectionTabsTrigger, Tabs, TabsContent } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { COUNTRY_CODES, countryName } from "@/lib/format";
import { useAction, useListSearch } from "@/lib/hooks";
import { downloadText, toCsv } from "@/lib/utils";
import { Chips, parseCsv, RowActions, SettingsCard } from "./shared";

const TaxesQuery = graphql(`
  query SettingsTaxes {
    taxClasses {
      id
      code
      name
      kind
    }
    taxRates {
      id
      code
      name
      countryCode
      regionCode
      postalCodePattern
      rate
    }
    taxRules {
      id
      name
      priority
      productTaxClasses {
        id
        name
      }
      customerTaxClasses {
        id
        name
      }
      taxRates {
        id
        code
      }
    }
  }
`);

type Taxes = ResultOf<typeof TaxesQuery>;
type TaxClass = NonNullable<Taxes["taxClasses"]>[number];
type TaxRate = NonNullable<Taxes["taxRates"]>[number];
type TaxRule = NonNullable<Taxes["taxRules"]>[number];

const TaxClassCreate = graphql(`mutation TaxClassCreate($input: TaxClassInput!) { taxClassCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxClassUpdate = graphql(`mutation TaxClassUpdate($id: ID!, $name: String!) { taxClassUpdate(id: $id, name: $name) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxClassDelete = graphql(`mutation TaxClassDelete($id: ID!) { taxClassDelete(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxRateCreate = graphql(`mutation TaxRateCreate($input: TaxRateInput!) { taxRateCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxRateUpdate = graphql(`mutation TaxRateUpdate($id: ID!, $input: TaxRateUpdateInput!) { taxRateUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxRateDelete = graphql(`mutation TaxRateDelete($id: ID!) { taxRateDelete(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxRuleCreate = graphql(`mutation TaxRuleCreate($input: TaxRuleInput!) { taxRuleCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxRuleUpdate = graphql(`mutation TaxRuleUpdate($id: ID!, $input: TaxRuleUpdateInput!) { taxRuleUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const TaxRuleDelete = graphql(`mutation TaxRuleDelete($id: ID!) { taxRuleDelete(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);

const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code), hint: code })).sort((a, b) => a.label.localeCompare(b.label));
const CSV_HEADER = ["code", "name", "country", "region", "postal_pattern", "rate"];
const INVALIDATE = [["settings-taxes"], ["reference"]];


export const TaxesPage = () => {
  const { can } = useAuth();
  const [search, setSearch] = useListSearch();
  const query = useQuery({ queryKey: ["settings-taxes"], queryFn: () => request(TaxesQuery) });
  const tab = search.tab ?? "rules";
  const write = can("settings:write");
  const data = query.data;

  return (
    <Page>
      <PageHeader title="Taxes" description="Rules combine a product's tax class and the customer's tax class into the rates charged at an address." />
      <Tabs value={tab} onValueChange={(value) => setSearch({ tab: value === "rules" ? undefined : value })}>
        <SectionTabsList className="mb-5">
          <SectionTabsTrigger value="rules">Rules</SectionTabsTrigger>
          <SectionTabsTrigger value="rates">Rates</SectionTabsTrigger>
          <SectionTabsTrigger value="classes">Tax classes</SectionTabsTrigger>
        </SectionTabsList>
        {query.isLoading || !data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <TabsContent value="rules">
              <RulesTab data={data} write={write} />
            </TabsContent>
            <TabsContent value="rates">
              <RatesTab data={data} write={write} />
            </TabsContent>
            <TabsContent value="classes">
              <ClassesTab data={data} write={write} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </Page>
  );
};

// ---------------------------------------------------------------- rules

const RulesTab = ({ data, write }: { data: Taxes; write: boolean }) => {
  const [editing, setEditing] = useState<TaxRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<TaxRule | null>(null);
  const remove = useAction((id: string) => request(TaxRuleDelete, { id }).then((r) => unwrap(r.taxRuleDelete)), {
    success: "Rule deleted",
    invalidate: INVALIDATE,
    onSuccess: () => setDeleting(null),
  });
  const rules = [...(data.taxRules ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return (
    <SettingsCard
      title="Tax rules"
      description="Equal priorities add up; higher priorities compound on top of lower ones."
      action={
        write ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus />
            Add rule
          </Button>
        ) : null
      }
    >
      {rules.length === 0 ? (
        <EmptyState title="No tax rules" description="Without rules no tax is charged." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Rule</TableHead>
              <TableHead className="text-right">Priority</TableHead>
              <TableHead>Product classes</TableHead>
              <TableHead>Customer classes</TableHead>
              <TableHead>Rates</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell className="font-medium">{rule.name}</TableCell>
                <TableCell className="tabular text-right">{rule.priority}</TableCell>
                <TableCell>
                  <Chips items={(rule.productTaxClasses ?? []).map((c) => c.name ?? "")} />
                </TableCell>
                <TableCell>
                  <Chips items={(rule.customerTaxClasses ?? []).map((c) => c.name ?? "")} empty="All customers" />
                </TableCell>
                <TableCell>
                  <Chips items={(rule.taxRates ?? []).map((r) => r.code ?? "")} max={4} />
                </TableCell>
                <TableCell>{write ? <RowActions onEdit={() => setEditing(rule)} onDelete={() => setDeleting(rule)} /> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing !== null ? <RuleDialog key={editing === "new" ? "new" : editing.id} rule={editing === "new" ? null : editing} data={data} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete rule ${deleting?.name ?? ""}?`}
        description="Orders already placed keep their tax; new carts stop using this rule."
        destructive
        confirmLabel="Delete rule"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </SettingsCard>
  );
};

type RuleForm = { name: string; priority: number; productTaxClassIds: string[]; customerTaxClassIds: string[]; taxRateIds: string[] };

const RuleDialog = ({ rule, data, onClose }: { rule: TaxRule | null; data: Taxes; onClose: () => void }) => {
  const form = useForm<RuleForm>({
    defaultValues: {
      name: rule?.name ?? "",
      priority: rule?.priority ?? 0,
      productTaxClassIds: (rule?.productTaxClasses ?? []).map((c) => c.id),
      customerTaxClassIds: (rule?.customerTaxClasses ?? []).map((c) => c.id),
      taxRateIds: (rule?.taxRates ?? []).map((r) => r.id),
    },
  });
  const save = useAction(
    async (values: RuleForm) => {
      const input = { ...values, name: values.name.trim(), priority: Number(values.priority) || 0 };
      if (rule) return unwrap((await request(TaxRuleUpdate, { id: rule.id, input })).taxRuleUpdate);
      return unwrap((await request(TaxRuleCreate, { input })).taxRuleCreate);
    },
    { success: rule ? "Rule saved" : "Rule created", invalidate: INVALIDATE, onSuccess: onClose, onError: (error) => reportError(error, form) },
  );
  const classes = (kind: "PRODUCT" | "CUSTOMER") => (data.taxClasses ?? []).filter((c) => c.kind === kind).map((c) => ({ value: c.id, label: c.name ?? "", hint: c.code ?? undefined }));
  const rates = (data.taxRates ?? []).map((r) => ({ value: r.id, label: `${r.code} (${r.rate}%)`, hint: r.countryCode ?? undefined }));
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit tax rule" : "New tax rule"}</DialogTitle>
          <DialogDescription>A product in one of the product classes, bought by a customer in one of the customer classes, pays the matching rates for the address.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field label="Name" required error={errors.name?.message}>
              <Input {...form.register("name", { required: "Required" })} />
            </Field>
            <Field label="Priority" error={errors.priority?.message}>
              <Input type="number" min={0} {...form.register("priority", { valueAsNumber: true })} />
            </Field>
          </div>
          <Field label="Product tax classes" required error={errors.productTaxClassIds?.message}>
            <Controller control={form.control} name="productTaxClassIds" rules={{ validate: (v) => v.length > 0 || "Pick at least one" }} render={({ field }) => <MultiSelect options={classes("PRODUCT")} value={field.value} onChange={field.onChange} />} />
          </Field>
          <Field label="Customer tax classes" hint="Leave empty to apply to every customer." error={errors.customerTaxClassIds?.message}>
            <Controller control={form.control} name="customerTaxClassIds" render={({ field }) => <MultiSelect options={classes("CUSTOMER")} value={field.value} onChange={field.onChange} placeholder="All customers" />} />
          </Field>
          <Field label="Rates" required error={errors.taxRateIds?.message}>
            <Controller control={form.control} name="taxRateIds" rules={{ validate: (v) => v.length > 0 || "Pick at least one" }} render={({ field }) => <MultiSelect options={rates} value={field.value} onChange={field.onChange} />} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {rule ? "Save rule" : "Create rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- rates

type ImportResult = { created: number; updated: number; failed: string[] };

const RatesTab = ({ data, write }: { data: Taxes; write: boolean }) => {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TaxRate | "new" | null>(null);
  const [deleting, setDeleting] = useState<TaxRate | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const rates = [...(data.taxRates ?? [])].sort((a, b) => (a.countryCode ?? "").localeCompare(b.countryCode ?? "") || (a.code ?? "").localeCompare(b.code ?? ""));
  const remove = useAction((id: string) => request(TaxRateDelete, { id }).then((r) => unwrap(r.taxRateDelete)), {
    success: "Rate deleted",
    invalidate: INVALIDATE,
    onSuccess: () => setDeleting(null),
  });

  const exportCsv = () =>
    downloadText(`tax-rates-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([CSV_HEADER, ...rates.map((r) => [r.code, r.name, r.countryCode, r.regionCode ?? "", r.postalCodePattern ?? "", r.rate])]));

  /** Create rates with new codes and update existing ones; each row stands alone. */
  const importCsv = async (input: File) => {
    setImporting(true);
    const outcome: ImportResult = { created: 0, updated: 0, failed: [] };
    try {
      const rows = parseCsv(await input.text());
      const body = rows[0]?.[0]?.trim().toLowerCase() === "code" ? rows.slice(1) : rows;
      const byCode = new Map(rates.map((r) => [r.code, r]));
      for (const [index, row] of body.entries()) {
        const [code = "", name = "", country = "", region = "", postal = "", rate = ""] = row.map((cell) => cell.trim());
        const line = `Line ${index + (body === rows ? 1 : 2)}`;
        const percent = Number(rate);
        if (!code || !/^[A-Za-z]{2}$/.test(country) || !Number.isFinite(percent)) {
          outcome.failed.push(`${line}: needs a code, a two-letter country and a numeric rate`);
          continue;
        }
        try {
          const existing = byCode.get(code);
          if (existing) {
            if (existing.countryCode !== country.toUpperCase()) throw new Error(`${code} is in ${existing.countryCode}; a rate's country cannot change`);
            const input = { name: name || existing.name, regionCode: region || null, postalCodePattern: postal || null, rate: percent };
            unwrap((await request(TaxRateUpdate, { id: existing.id, input })).taxRateUpdate);
            outcome.updated++;
          } else {
            unwrap((await request(TaxRateCreate, { input: { code, name: name || code, countryCode: country.toUpperCase(), regionCode: region || null, postalCodePattern: postal || null, rate: percent } })).taxRateCreate);
            outcome.created++;
          }
        } catch (error) {
          outcome.failed.push(`${line} (${code}): ${error instanceof Error ? error.message : "failed"}`);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the file");
    } finally {
      setImporting(false);
      await queryClient.invalidateQueries({ queryKey: ["settings-taxes"] });
      setImported(outcome);
    }
  };

  return (
    <SettingsCard
      title="Tax rates"
      description="Rates apply by country, optionally narrowed to a region code or postal code pattern such as 9* or 10115."
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!rates.length}>
            <Download />
            Export CSV
          </Button>
          {write ? (
            <>
              <input
                ref={file}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  e.target.value = "";
                  if (chosen) void importCsv(chosen);
                }}
              />
              <Button size="sm" variant="outline" loading={importing} onClick={() => file.current?.click()}>
                {importing ? null : <Upload />}
                Import CSV
              </Button>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                Add rate
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {rates.length === 0 ? (
        <EmptyState title="No tax rates" description={`Add rates one by one or import a CSV with the columns ${CSV_HEADER.join(", ")}.`} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Postal codes</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.map((rate) => (
              <TableRow key={rate.id}>
                <TableCell className="font-mono text-xs">{rate.code}</TableCell>
                <TableCell>{rate.name}</TableCell>
                <TableCell>{countryName(rate.countryCode)}</TableCell>
                <TableCell className="text-muted-foreground">{rate.regionCode || "Any"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{rate.postalCodePattern || "Any"}</TableCell>
                <TableCell className="tabular text-right font-medium">{rate.rate}%</TableCell>
                <TableCell>{write ? <RowActions onEdit={() => setEditing(rate)} onDelete={() => setDeleting(rate)} /> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing !== null ? <RateDialog key={editing === "new" ? "new" : editing.id} rate={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete rate ${deleting?.code ?? ""}?`}
        description="It is also removed from every tax rule that uses it."
        destructive
        confirmLabel="Delete rate"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
      <Dialog open={!!imported} onOpenChange={(open) => !open && setImported(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import finished</DialogTitle>
            <DialogDescription>
              {imported?.created ?? 0} created · {imported?.updated ?? 0} updated · {imported?.failed.length ?? 0} failed
            </DialogDescription>
          </DialogHeader>
          {imported?.failed.length ? (
            <Alert variant="warning" title="Rows that were skipped">
              <ul className="max-h-60 list-disc space-y-0.5 overflow-y-auto pl-4">
                {imported.failed.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setImported(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
};

type RateForm = { code: string; name: string; countryCode: string; regionCode: string; postalCodePattern: string; rate: string };

const RateDialog = ({ rate, onClose }: { rate: TaxRate | null; onClose: () => void }) => {
  const form = useForm<RateForm>({
    defaultValues: {
      code: rate?.code ?? "",
      name: rate?.name ?? "",
      countryCode: rate?.countryCode ?? "",
      regionCode: rate?.regionCode ?? "",
      postalCodePattern: rate?.postalCodePattern ?? "",
      rate: rate?.rate !== undefined && rate?.rate !== null ? String(rate.rate) : "",
    },
  });
  const save = useAction(
    async (v: RateForm) => {
      // An empty field sends null, which clears it: the rate then applies to any region or postal code.
      const common = { name: v.name.trim(), rate: Number(v.rate), regionCode: v.regionCode.trim() || null, postalCodePattern: v.postalCodePattern.trim() || null };
      if (rate) return unwrap((await request(TaxRateUpdate, { id: rate.id, input: common })).taxRateUpdate);
      return unwrap((await request(TaxRateCreate, { input: { ...common, code: v.code.trim(), countryCode: v.countryCode } })).taxRateCreate);
    },
    { success: rate ? "Rate saved" : "Rate created", invalidate: INVALIDATE, onSuccess: onClose, onError: (error) => reportError(error, form) },
  );
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{rate ? `Edit rate ${rate.code}` : "New tax rate"}</DialogTitle>
          {rate ? <DialogDescription>Code and country are fixed once created.</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required error={errors.code?.message}>
            <Input disabled={!!rate} className="font-mono" placeholder="US-CA" {...form.register("code", { required: !rate && "Required" })} />
          </Field>
          <Field label="Name" required error={errors.name?.message}>
            <Input placeholder="California sales tax" {...form.register("name", { required: "Required" })} />
          </Field>
          <Field label="Country" required error={errors.countryCode?.message}>
            <Controller
              control={form.control}
              name="countryCode"
              rules={{ required: !rate && "Required" }}
              render={({ field }) => <Combobox options={COUNTRY_OPTIONS} value={field.value} onChange={field.onChange} placeholder="Pick a country" disabled={!!rate} />}
            />
          </Field>
          <Field label="Rate (%)" required error={errors.rate?.message}>
            <Input inputMode="decimal" {...form.register("rate", { required: "Required", validate: (v) => (Number(v) >= 0 && Number(v) <= 100) || "Between 0 and 100" })} />
          </Field>
          <Field label="Region code" hint="e.g. CA or BY; empty for the whole country." error={errors.regionCode?.message}>
            <Input className="uppercase" {...form.register("regionCode")} />
          </Field>
          <Field label="Postal code pattern" hint="Glob: 9* or 10115; empty for all." error={errors.postalCodePattern?.message}>
            <Input className="font-mono" {...form.register("postalCodePattern")} />
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {rate ? "Save rate" : "Create rate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- classes

const ClassesTab = ({ data, write }: { data: Taxes; write: boolean }) => {
  const [editing, setEditing] = useState<TaxClass | "new" | null>(null);
  const [deleting, setDeleting] = useState<TaxClass | null>(null);
  const remove = useAction((id: string) => request(TaxClassDelete, { id }).then((r) => unwrap(r.taxClassDelete)), {
    success: "Tax class deleted",
    invalidate: INVALIDATE,
    onSuccess: () => setDeleting(null),
  });
  const classes = [...(data.taxClasses ?? [])].sort((a, b) => (a.kind ?? "").localeCompare(b.kind ?? "") || (a.name ?? "").localeCompare(b.name ?? ""));
  return (
    <SettingsCard
      title="Tax classes"
      description="Product classes go on products and product types; customer classes go on customer groups."
      action={
        write ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus />
            Add class
          </Button>
        ) : null
      }
    >
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            <TableHead>Code</TableHead>
            <TableHead>Applies to</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {classes.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell className="font-mono text-xs">{c.code}</TableCell>
              <TableCell>
                <Badge variant={c.kind === "PRODUCT" ? "info" : "secondary"}>{c.kind === "PRODUCT" ? "Products" : "Customers"}</Badge>
              </TableCell>
              <TableCell>{write ? <RowActions onEdit={() => setEditing(c)} onDelete={() => setDeleting(c)} /> : null}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing !== null ? <ClassDialog key={editing === "new" ? "new" : editing.id} taxClass={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "class"}?`}
        description="Classes still assigned to products, product types, customer groups, channels or shipping methods cannot be deleted; the reason is shown if so."
        destructive
        confirmLabel="Delete class"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </SettingsCard>
  );
};

type ClassForm = { code: string; name: string; kind: "PRODUCT" | "CUSTOMER" };

const ClassDialog = ({ taxClass, onClose }: { taxClass: TaxClass | null; onClose: () => void }) => {
  const form = useForm<ClassForm>({ defaultValues: { code: taxClass?.code ?? "", name: taxClass?.name ?? "", kind: taxClass?.kind ?? "PRODUCT" } });
  const save = useAction(
    async (v: ClassForm) => {
      if (taxClass) return unwrap((await request(TaxClassUpdate, { id: taxClass.id, name: v.name.trim() })).taxClassUpdate);
      return unwrap((await request(TaxClassCreate, { input: { code: v.code.trim(), name: v.name.trim(), kind: v.kind } })).taxClassCreate);
    },
    { success: taxClass ? "Tax class renamed" : "Tax class created", invalidate: INVALIDATE, onSuccess: onClose, onError: (error) => reportError(error, form, taxClass ? [] : ["input"]) },
  );
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{taxClass ? `Rename ${taxClass.name}` : "New tax class"}</DialogTitle>
          {taxClass ? <DialogDescription>Code and kind are fixed once created.</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          {!taxClass ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Code" required hint="Lowercase letters, digits, - and _" error={errors.code?.message}>
                <Input className="font-mono" {...form.register("code", { required: "Required" })} />
              </Field>
              <Field label="Applies to" required>
                <NativeSelect {...form.register("kind")}>
                  <option value="PRODUCT">Products</option>
                  <option value="CUSTOMER">Customers</option>
                </NativeSelect>
              </Field>
            </div>
          ) : null}
          <Field label="Name" required error={errors.name?.message}>
            <Input {...form.register("name", { required: "Required" })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {taxClass ? "Save" : "Create class"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
