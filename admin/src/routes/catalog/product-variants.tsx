import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Boxes, MoreHorizontal, Pencil, Plus, Save, Table2, Tag, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form";
import { SAVE_SHORTCUT, useProblemFocus } from "@/components/save-bar";
import { BooleanBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelect } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { Alert, EmptyState, Kbd } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Sheet, SheetContent } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatMoney, formatNumber } from "@/lib/format";
import { useAction, useAdminCurrency, useReference } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import {
  combinations,
  comboKey,
  fromLocalInput,
  SKU_PATTERN,
  skuFor,
  StockLevelAdjust,
  StockLevelSet,
  toLocalInput,
  VariantCreate,
  VariantDelete,
  VariantPricesQuery,
  VariantPricesSet,
  VariantUpdate,
  type EditorAttribute,
  type EditorProduct,
  type EditorVariant,
  type VariantCreateInput,
  type VariantPriceInput,
} from "./product-data";
import { CATALOG_KEYS, Swatch } from "./shared";

type Axis = Pick<EditorAttribute, "code" | "label" | "options">;

const optionsOf = (variant: EditorVariant) => Object.fromEntries((variant.selectedOptions ?? []).map((o) => [o.attribute ?? "", o.value ?? ""]));
const onHand = (variant: EditorVariant) => (variant.stockLevels ?? []).reduce((sum, l) => sum + (l.quantity ?? 0), 0);

/** Keyed by path below the argument root: "sku", "prices.0.amount". */
const fieldErrorsOf = (error: unknown, root: string[] = ["input"]) => {
  if (!(error instanceof MutationError)) return {};
  return Object.fromEntries(
    error.fieldErrors.map((e) => [(root.every((r, i) => e.path[i] === r) ? e.path.slice(root.length) : e.path).join("."), e.message]),
  ) as Record<string, string>;
};

/** "OXF-WHITE-S" with options white and s → "OXF". */
const baseOf = (variant: EditorVariant | undefined) => {
  if (!variant?.sku) return "";
  const values = new Set((variant.selectedOptions ?? []).map((o) => (o.value ?? "").toUpperCase()));
  return variant.sku
    .split("-")
    .filter((part) => !values.has(part.toUpperCase()))
    .join("-");
};

const pricesFrom = (variant: EditorVariant | undefined): VariantPriceInput[] =>
  (variant?.prices ?? []).flatMap((p) =>
    p.channel?.id && p.currencyCode && p.amount?.amount
      ? [
          {
            channelId: p.channel.id,
            currencyCode: p.currencyCode,
            amount: p.amount.amount,
            compareAtAmount: p.compareAtAmount?.amount ?? null,
            costAmount: p.costAmount?.amount ?? null,
            customerGroupId: p.customerGroupId ?? null,
            minQuantity: p.minQuantity ?? 1,
            startsAt: p.startsAt ?? null,
            endsAt: p.endsAt ?? null,
          },
        ]
      : [],
  );

// ---------------------------------------------------------------- existing products

/** Changes here save at once, separately from the product form. */
export const VariantsCard = ({ product, refresh }: { product: EditorProduct; refresh: () => Promise<unknown> }) => {
  const { can } = useAuth();
  const write = can("catalog:write");
  const stockWrite = can("inventory:write");
  const axes = (product.productType?.variantAttributes ?? []).filter((a): a is typeof a & { code: string } => !!a.code);
  const variants = useMemo(() => [...(product.variants ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), [product.variants]);
  const [editing, setEditing] = useState<{ variant: EditorVariant | null } | null>(null);
  const [pricing, setPricing] = useState<EditorVariant | null>(null);
  const [stocking, setStocking] = useState<EditorVariant | null>(null);
  const [deleting, setDeleting] = useState<EditorVariant | null>(null);
  const [generating, setGenerating] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  // Prices in the admin's currency; refreshed with the product (same key prefix).
  const admin = useAdminCurrency();
  const shown = useQuery({
    queryKey: [...CATALOG_KEYS.product(product.id), "prices", admin.key],
    queryFn: ({ signal }) => request(VariantPricesQuery, { id: product.id, channel: admin.channel || null, currency: admin.currency }, { signal }),
    enabled: !admin.loading,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === product.id ? previous : undefined),
  });
  const priceOf = (variant: EditorVariant) => shown.data?.product?.variants?.find((v) => v.id === variant.id)?.price ?? null;
  const remove = useAction((id: string) => request(VariantDelete, { id }).then((r) => unwrap(r.productVariantDelete)), {
    success: "Variant deleted",
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const canAdd = write && (axes.length > 0 || variants.length === 0);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Variants</CardTitle>
          <CardDescription>{axes.length ? `Variants differ by ${axes.map((a) => a.label ?? a.code).join(", ")}.` : "This product type has no variant options, so the product has a single variant."}</CardDescription>
        </div>
        {write || stockWrite ? (
          <div className="flex flex-wrap justify-end gap-2">
            {variants.length ? (
              <Button size="sm" variant="outline" onClick={() => setGridOpen(true)}>
                <Table2 />
                {write && stockWrite ? "Edit prices & stock" : write ? "Edit prices" : "Edit stock"}
              </Button>
            ) : null}
            {write && axes.length ? (
              <Button size="sm" variant="outline" onClick={() => setGenerating(true)}>
                <Wand2 />
                Generate
              </Button>
            ) : null}
            {canAdd ? (
              <Button size="sm" variant="outline" onClick={() => setEditing({ variant: null })}>
                <Plus />
                Add variant
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      {variants.length === 0 ? (
        <EmptyState icon={Boxes} title="No variants" description="Add a variant to give the product a SKU and a price." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Variant</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {variants.map((v) => (
              <TableRow key={v.id} className="hover:bg-transparent">
                <TableCell>
                  {(v.selectedOptions ?? []).length ? (
                    <div className="flex flex-wrap gap-1">
                      {(v.selectedOptions ?? []).map((o) => (
                        <Badge key={o.attribute} variant="secondary" className="rounded-md">
                          <Swatch swatch={o.swatch} />
                          {o.label}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">Default</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{v.sku}</TableCell>
                <TableCell className="tabular text-right">
                  {shown.data ? formatMoney(priceOf(v)) : null}
                  {(v.prices ?? []).length > 1 ? <p className="text-[11px] text-muted-foreground">{(v.prices ?? []).length} price points</p> : null}
                </TableCell>
                <TableCell className="tabular text-right">
                  {v.trackInventory ? (
                    <>
                      <span className={cn(onHand(v) <= 0 && "font-medium text-destructive")}>{formatNumber(onHand(v))}</span>
                      <p className="text-[11px] text-muted-foreground">{formatNumber(v.quantityAvailable)} available</p>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not tracked</span>
                  )}
                </TableCell>
                <TableCell>
                  <BooleanBadge value={v.isActive} />
                </TableCell>
                <TableCell>
                  {write || stockWrite ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${v.sku}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {write ? (
                          <>
                            <DropdownMenuItem onSelect={() => setEditing({ variant: v })}>
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setPricing(v)}>
                              <Tag />
                              Prices
                            </DropdownMenuItem>
                          </>
                        ) : null}
                        {stockWrite ? (
                          <DropdownMenuItem onSelect={() => setStocking(v)}>
                            <Boxes />
                            Stock
                          </DropdownMenuItem>
                        ) : null}
                        {write && variants.length > 1 ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onSelect={() => setDeleting(v)}>
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <VariantSheet
        open={!!editing}
        variant={editing?.variant ?? null}
        product={product}
        axes={axes}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void refresh();
        }}
      />
      {pricing ? <PricesSheet variant={pricing} onClose={() => setPricing(null)} onSaved={() => void refresh()} /> : null}
      {stocking ? <StockSheet variant={stocking} onClose={() => setStocking(null)} onSaved={() => void refresh()} /> : null}
      {generating ? <GenerateDialog product={product} axes={axes} variants={variants} onClose={() => setGenerating(false)} onDone={() => void refresh()} /> : null}
      {gridOpen ? <PriceStockSheet variants={variants} canPrice={write} canStock={stockWrite} onClose={() => setGridOpen(false)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete variant ${deleting?.sku ?? ""}?`}
        description="Its prices and stock levels are deleted. Past orders keep their own copy."
        destructive
        confirmLabel="Delete variant"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Card>
  );
};

type VariantForm = { options: Record<string, string>; sku: string; barcode: string; weightGrams: string; position: string; isActive: boolean; trackInventory: boolean; allowBackorder: boolean; copyPricesFrom: string };

const variantForm = (variant: EditorVariant | null, siblings: readonly EditorVariant[]): VariantForm => ({
  options: variant ? optionsOf(variant) : {},
  sku: variant?.sku ?? "",
  barcode: variant?.barcode ?? "",
  weightGrams: variant?.weightGrams != null ? String(variant.weightGrams) : (siblings[0]?.weightGrams != null ? String(siblings[0].weightGrams) : ""),
  position: String(variant?.position ?? siblings.length),
  isActive: variant?.isActive ?? true,
  trackInventory: variant?.trackInventory ?? true,
  allowBackorder: variant?.allowBackorder ?? false,
  copyPricesFrom: variant ? "" : (siblings[0]?.id ?? ""),
});

const VariantSheet = ({ open, variant, product, axes, onClose, onSaved }: { open: boolean; variant: EditorVariant | null; product: EditorProduct; axes: (Axis & { code: string })[]; onClose: () => void; onSaved: () => void }) => {
  const siblings = product.variants ?? [];
  const [values, setValues] = useState(() => variantForm(variant, siblings));
  // What the sheet opened with, to tell whether anything was edited.
  const [initial, setInitial] = useState(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      const fresh = variantForm(variant, siblings);
      setValues(fresh);
      setInitial(fresh);
      setErrors({});
    }
    // Reset only when the sheet opens for another variant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant?.id]);
  const set = <K extends keyof VariantForm>(key: K, value: VariantForm[K]) => setValues((v) => ({ ...v, [key]: value }));

  const save = useAction(
    async () => {
      const local: Record<string, string> = {};
      if (!SKU_PATTERN.test(values.sku.trim())) local.sku = "Use letters, digits and . _ - / (up to 64)";
      for (const axis of axes) if (!values.options[axis.code]) local[`attributes.${axis.code}`] = "Required";
      if (Object.keys(local).length) {
        setErrors(local);
        throw new Error("Check the highlighted fields");
      }
      const common = {
        sku: values.sku.trim(),
        options: axes.length ? axes.map((a) => ({ attribute: a.code, value: values.options[a.code]! })) : null,
        barcode: values.barcode.trim() || null,
        weightGrams: values.weightGrams.trim() ? Number(values.weightGrams) : null,
        position: Number(values.position) || 0,
        isActive: values.isActive,
        trackInventory: values.trackInventory,
        allowBackorder: values.allowBackorder,
      };
      if (variant) return unwrap((await request(VariantUpdate, { id: variant.id, input: common })).productVariantUpdate);
      const template = siblings.find((s) => s.id === values.copyPricesFrom);
      const input: VariantCreateInput = { ...common, prices: template ? pricesFrom(template) : null };
      return unwrap((await request(VariantCreate, { productId: product.id, input })).productVariantCreate);
    },
    {
      success: variant ? "Variant saved" : "Variant added",
      onSuccess: onSaved,
      onError: (error) => {
        setErrors((current) => ({ ...current, ...fieldErrorsOf(error) }));
        toast.error(error instanceof Error ? error.message : "Could not save the variant");
      },
    },
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby={undefined} dirty={JSON.stringify(values) !== JSON.stringify(initial)}>
        <div>
          <h2 className="text-base font-semibold">{variant ? `Edit ${variant.sku}` : "Add variant"}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{product.name}</p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          {axes.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {axes.map((axis) => (
                <Field key={axis.code} label={axis.label ?? axis.code} required error={errors[`attributes.${axis.code}`]}>
                  <NativeSelect value={values.options[axis.code] ?? ""} onChange={(e) => set("options", { ...values.options, [axis.code]: e.target.value })}>
                    <option value="">Choose…</option>
                    {(axis.options ?? []).map((o) => (
                      <option key={o.code} value={o.code ?? ""}>
                        {o.label ?? o.code}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              ))}
            </div>
          ) : null}
          {errors.attributes ? <Alert variant="destructive">{errors.attributes}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SKU" required error={errors.sku} className="sm:col-span-2">
              <Input className="font-mono" value={values.sku} onChange={(e) => set("sku", e.target.value)} aria-invalid={!!errors.sku} />
            </Field>
            <Field label="Barcode" hint="GTIN, EAN or UPC" error={errors.barcode}>
              <Input value={values.barcode} onChange={(e) => set("barcode", e.target.value)} />
            </Field>
            <Field label="Weight (grams)" error={errors.weightGrams}>
              <Input type="number" min={0} value={values.weightGrams} onChange={(e) => set("weightGrams", e.target.value)} />
            </Field>
            <Field label="Position" hint="Lower sorts first" error={errors.position}>
              <Input type="number" value={values.position} onChange={(e) => set("position", e.target.value)} />
            </Field>
            {!variant && siblings.length ? (
              <Field label="Copy prices from" hint="Edit them afterwards under Prices.">
                <NativeSelect value={values.copyPricesFrom} onChange={(e) => set("copyPricesFrom", e.target.value)}>
                  <option value="">Don't set prices</option>
                  {siblings.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.sku}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <Label className="justify-between font-normal">
              Active (can be bought)
              <Switch checked={values.isActive} onCheckedChange={(v) => set("isActive", v)} />
            </Label>
            <Label className="justify-between font-normal">
              Track inventory
              <Switch checked={values.trackInventory} onCheckedChange={(v) => set("trackInventory", v)} />
            </Label>
            <Label className="justify-between font-normal">
              Allow orders when out of stock
              <Switch checked={values.allowBackorder} disabled={!values.trackInventory} onCheckedChange={(v) => set("allowBackorder", v)} />
            </Label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {variant ? "Save variant" : "Add variant"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
};

// ---------------------------------------------------------------- price points

type PriceRow = { channelId: string; currencyCode: string; amount: string; compareAtAmount: string; costAmount: string; customerGroupId: string; minQuantity: string; startsAt: string; endsAt: string };

const priceRows = (variant: EditorVariant): PriceRow[] =>
  (variant.prices ?? []).map((p) => ({
    channelId: p.channel?.id ?? "",
    currencyCode: p.currencyCode ?? "",
    amount: p.amount?.amount ?? "",
    compareAtAmount: p.compareAtAmount?.amount ?? "",
    costAmount: p.costAmount?.amount ?? "",
    customerGroupId: p.customerGroupId ?? "",
    minQuantity: String(p.minQuantity ?? 1),
    startsAt: toLocalInput(p.startsAt),
    endsAt: toLocalInput(p.endsAt),
  }));

const kindOf = (row: PriceRow, groups: readonly { id: string; name: string | null }[]) => {
  const parts: string[] = [];
  if (row.customerGroupId) parts.push(`${groups.find((g) => g.id === row.customerGroupId)?.name ?? "Group"} price`);
  if (Number(row.minQuantity) > 1) parts.push(`tier from ${row.minQuantity}`);
  if (row.startsAt || row.endsAt) parts.push("scheduled");
  return parts.length ? parts.join(", ") : "List price";
};

/** Every price point of one variant: list, special, tier and customer-group prices. */
const PricesSheet = ({ variant, onClose, onSaved }: { variant: EditorVariant; onClose: () => void; onSaved: () => void }) => {
  const { channels, customerGroups } = useReference();
  const [initial] = useState(() => priceRows(variant));
  const [rows, setRows] = useState<PriceRow[]>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = (index: number, patch: Partial<PriceRow>) => setRows((all) => all.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const currenciesOf = (channelId: string) => channels.find((c) => c.id === channelId)?.currencies ?? [];
  const addRow = () => {
    const channel = channels[0];
    setRows((all) => [...all, { channelId: channel?.id ?? "", currencyCode: channel?.defaultCurrency ?? "", amount: "", compareAtAmount: "", costAmount: "", customerGroupId: "", minQuantity: "1", startsAt: "", endsAt: "" }]);
  };

  const save = useAction(
    async () => {
      const prices: VariantPriceInput[] = rows.map((r) => ({
        channelId: r.channelId,
        currencyCode: r.currencyCode,
        amount: r.amount.trim(),
        compareAtAmount: r.compareAtAmount.trim() || null,
        costAmount: r.costAmount.trim() || null,
        customerGroupId: r.customerGroupId || null,
        minQuantity: Number(r.minQuantity) || 1,
        startsAt: fromLocalInput(r.startsAt),
        endsAt: fromLocalInput(r.endsAt),
      }));
      return unwrap((await request(VariantPricesSet, { variantId: variant.id, prices })).productVariantPricesSet);
    },
    {
      success: "Prices saved",
      onSuccess: () => {
        onSaved();
        onClose();
      },
      onError: (error) => {
        setErrors(fieldErrorsOf(error, []));
        toast.error(error instanceof Error ? error.message : "Could not save prices");
      },
    },
  );

  const rowError = (index: number) =>
    Object.entries(errors)
      .filter(([path]) => path.startsWith(`prices.${index}`))
      .map(([path, message]) => `${path.split(".").at(-1)}: ${message}`)
      .join("; ");

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:w-[44rem] sm:max-w-[44rem]" aria-describedby={undefined} dirty={JSON.stringify(rows) !== JSON.stringify(initial)}>
        <div>
          <h2 className="text-base font-semibold">Prices for {variant.sku}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            A list price has no customer group, a minimum quantity of 1 and no dates. Add rows for tier prices (minimum quantity), customer-group prices and scheduled sale prices. The lowest applicable price wins.
          </p>
        </div>
        {rows.length === 0 ? <Alert variant="warning">Without a price in a channel's currency, the variant cannot be bought there.</Alert> : null}
        <div className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <div key={index} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{kindOf(row, customerGroups)}</span>
                <Button variant="ghost" size="icon-sm" onClick={() => setRows((all) => all.filter((_, i) => i !== index))} aria-label="Remove price">
                  <Trash2 />
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label="Channel">
                  <NativeSelect
                    value={row.channelId}
                    onChange={(e) => {
                      const currencies = currenciesOf(e.target.value);
                      update(index, { channelId: e.target.value, currencyCode: currencies.includes(row.currencyCode) ? row.currencyCode : (currencies[0] ?? "") });
                    }}
                  >
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Currency">
                  <NativeSelect value={row.currencyCode} onChange={(e) => update(index, { currencyCode: e.target.value })}>
                    {currenciesOf(row.channelId).map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Price">
                  <Input inputMode="decimal" value={row.amount} onChange={(e) => update(index, { amount: e.target.value })} placeholder="0.00" />
                </Field>
                <Field label="Compare at" hint="Struck-through price">
                  <Input inputMode="decimal" value={row.compareAtAmount} onChange={(e) => update(index, { compareAtAmount: e.target.value })} />
                </Field>
                <Field label="Cost" hint="For margins">
                  <Input inputMode="decimal" value={row.costAmount} onChange={(e) => update(index, { costAmount: e.target.value })} />
                </Field>
                <Field label="Customer group">
                  <NativeSelect value={row.customerGroupId} onChange={(e) => update(index, { customerGroupId: e.target.value })}>
                    <option value="">Everyone</option>
                    {customerGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Minimum quantity">
                  <Input type="number" min={1} value={row.minQuantity} onChange={(e) => update(index, { minQuantity: e.target.value })} />
                </Field>
                <div />
                <Field label="Starts" className="sm:col-span-2">
                  <Input type="datetime-local" value={row.startsAt} onChange={(e) => update(index, { startsAt: e.target.value })} />
                </Field>
                <Field label="Ends" className="sm:col-span-2">
                  <Input type="datetime-local" value={row.endsAt} onChange={(e) => update(index, { endsAt: e.target.value })} />
                </Field>
              </div>
              {rowError(index) ? <p className="mt-2 text-xs text-destructive">{rowError(index)}</p> : null}
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" className="self-start" onClick={addRow}>
          <Plus />
          Add price
        </Button>
        <div className="mt-auto flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save prices
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};

// ---------------------------------------------------------------- stock

/** On-hand quantity per location: set a counted quantity or adjust by a delta. */
const StockSheet = ({ variant, onClose, onSaved }: { variant: EditorVariant; onClose: () => void; onSaved: () => void }) => {
  const { stockLocations } = useReference();
  const [levels, setLevels] = useState<Record<string, number>>(() => Object.fromEntries((variant.stockLevels ?? []).map((l) => [l.location?.id ?? "", l.quantity ?? 0])));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const set = useAction(
    (input: { locationId: string; quantity: number }) => request(StockLevelSet, { variantId: variant.id, ...input }).then((r) => ({ locationId: input.locationId, result: unwrap(r.stockLevelSet) })),
    {
      success: "Stock updated",
      onSuccess: ({ locationId, result }) => {
        setLevels((l) => ({ ...l, [locationId]: result.stockLevel?.quantity ?? 0 }));
        setCounts((c) => ({ ...c, [locationId]: "" }));
        onSaved();
      },
    },
  );
  const adjust = useAction(
    (input: { locationId: string; delta: number }) => request(StockLevelAdjust, { variantId: variant.id, ...input }).then((r) => ({ locationId: input.locationId, result: unwrap(r.stockLevelAdjust) })),
    {
      success: "Stock adjusted",
      onSuccess: ({ locationId, result }) => {
        setLevels((l) => ({ ...l, [locationId]: result.stockLevel?.quantity ?? 0 }));
        setDeltas((d) => ({ ...d, [locationId]: "" }));
        onSaved();
      },
    },
  );
  const pending = [...Object.values(counts), ...Object.values(deltas)].some((value) => value.trim());
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby={undefined} dirty={pending}>
        <div>
          <h2 className="text-base font-semibold">Stock for {variant.sku}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Set the counted quantity, or adjust for receipts, damage and shrinkage. Open orders reserve stock separately.</p>
        </div>
        {!variant.trackInventory ? <Alert variant="info">This variant does not track inventory, so it is always available.</Alert> : null}
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Location</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead>Set to</TableHead>
              <TableHead>Adjust by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stockLocations.map((location) => (
              <TableRow key={location.id} className="hover:bg-transparent">
                <TableCell>
                  {location.name}
                  {!location.isActive ? <p className="text-[11px] text-muted-foreground">inactive</p> : null}
                </TableCell>
                <TableCell className="tabular text-right font-medium">{formatNumber(levels[location.id] ?? 0)}</TableCell>
                <TableCell>
                  <form
                    className="flex gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const quantity = Number(counts[location.id]);
                      if (counts[location.id]?.trim() && Number.isInteger(quantity) && quantity >= 0) set.mutate({ locationId: location.id, quantity });
                    }}
                  >
                    <Input type="number" min={0} className="h-8 w-20" value={counts[location.id] ?? ""} onChange={(e) => setCounts({ ...counts, [location.id]: e.target.value })} aria-label={`Count at ${location.name}`} />
                    <Button type="submit" size="sm" variant="outline" disabled={!counts[location.id]?.trim()}>
                      Set
                    </Button>
                  </form>
                </TableCell>
                <TableCell>
                  <form
                    className="flex gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const delta = Number(deltas[location.id]);
                      if (Number.isInteger(delta) && delta !== 0) adjust.mutate({ locationId: location.id, delta });
                    }}
                  >
                    <Input type="number" className="h-8 w-20" placeholder="±" value={deltas[location.id] ?? ""} onChange={(e) => setDeltas({ ...deltas, [location.id]: e.target.value })} aria-label={`Adjustment at ${location.name}`} />
                    <Button type="submit" size="sm" variant="outline" disabled={!Number(deltas[location.id])}>
                      Apply
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="mt-auto flex justify-end border-t pt-4">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};

// ---------------------------------------------------------------- prices and stock of every variant

/** As typed: prices and compare-at prices keyed by `channelId|currency`, counts by location id. */
type GridRow = { prices: Record<string, string>; compareAt: Record<string, string>; stock: Record<string, string> };
type GridField = keyof GridRow;
type GridJob = { kind: "prices"; variant: EditorVariant; keys: string[] } | { kind: "stock"; variant: EditorVariant; locationId: string };

const priceKey = (channelId: string, currency: string) => `${channelId}|${currency}`;

/** Not a group, tier or scheduled price. */
const isListPrice = (p: { customerGroupId?: string | null; minQuantity?: number | null; startsAt?: string | null; endsAt?: string | null }) => !p.customerGroupId && (p.minQuantity ?? 1) <= 1 && !p.startsAt && !p.endsAt;

const gridRowOf = (variant: EditorVariant): GridRow => {
  const prices: Record<string, string> = {};
  const compareAt: Record<string, string> = {};
  for (const p of variant.prices ?? []) {
    if (!p.channel?.id || !p.currencyCode || !isListPrice(p)) continue;
    const key = priceKey(p.channel.id, p.currencyCode);
    if (key in prices) continue;
    prices[key] = p.amount?.amount ?? "";
    compareAt[key] = p.compareAtAmount?.amount ?? "";
  }
  const stock = Object.fromEntries((variant.stockLevels ?? []).flatMap((l) => (l.location?.id ? [[l.location.id, String(l.quantity ?? 0)]] : [])));
  return { prices, compareAt, stock };
};

const DECIMAL = /^\d+(\.\d+)?$/;
/** "19,90 " → "19.90" */
const amountOf = (value: string | undefined) => (value ?? "").trim().replace(",", ".");
const sameValue = (field: GridField, a: string | undefined, b: string | undefined) => {
  const [x, y] = field === "stock" ? [(a ?? "").trim(), (b ?? "").trim()] : [amountOf(a), amountOf(b)];
  return x === y || (x !== "" && y !== "" && Number(x) === Number(y));
};

/** Why a cell can't be saved, or null. A changed compare-at price needs a price beside it. */
const cellProblem = (field: GridField, row: GridRow, saved: GridRow, key: string) => {
  if (field === "stock") {
    const count = (row.stock[key] ?? "").trim();
    if (!count) return (saved.stock[key] ?? "").trim() ? "Enter a count" : null;
    return /^\d+$/.test(count) ? null : "A whole number of 0 or more";
  }
  if (field === "compareAt" && !amountOf(row.prices[key])) return amountOf(row.compareAt[key]) && !sameValue(field, row.compareAt[key], saved.compareAt[key]) ? "Add a price too" : null;
  const amount = amountOf(row[field][key]);
  return amount && !DECIMAL.test(amount) ? "A price such as 19.99" : null;
};

const cellChanged = (field: GridField, row: GridRow, saved: GridRow, key: string) =>
  field === "compareAt" ? !!amountOf(row.prices[key]) && !sameValue(field, row.compareAt[key], saved.compareAt[key]) : !sameValue(field, row[field][key], saved[field][key]);

/**
 * The variant's price points with the list prices in `keys` replaced. The API replaces every price
 * point, so the others go back unchanged; an emptied list price is removed.
 */
const mergedPrices = (variant: EditorVariant, row: GridRow, keys: readonly string[]) => {
  const current = pricesFrom(variant);
  const edited = new Set(keys);
  const kept = current.filter((p) => !(isListPrice(p) && edited.has(priceKey(p.channelId, p.currencyCode))));
  const added = keys.flatMap((key) => {
    const amount = amountOf(row.prices[key]);
    if (!amount) return [];
    const [channelId, currencyCode] = key.split("|") as [string, string];
    const before = current.find((p) => isListPrice(p) && priceKey(p.channelId, p.currencyCode) === key);
    const price: VariantPriceInput = { channelId, currencyCode, amount, compareAtAmount: amountOf(row.compareAt[key]) || null, costAmount: before?.costAmount ?? null, customerGroupId: null, minQuantity: 1, startsAt: null, endsAt: null };
    return [{ key, price }];
  });
  return { prices: [...kept, ...added.map((a) => a.price)], keptCount: kept.length, addedKeys: added.map((a) => a.key) };
};

const variantLabel = (variant: EditorVariant) => (variant.selectedOptions ?? []).map((o) => o.label ?? o.value).join(" / ") || "Default";

/** List prices and on-hand counts of every variant in one grid, with Fill down. */
const PriceStockSheet = ({ variants, canPrice, canStock, onClose, onSaved }: { variants: readonly EditorVariant[]; canPrice: boolean; canStock: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) => {
  const { channels, stockLocations } = useReference();
  const [initial] = useState(() => Object.fromEntries(variants.map((v) => [v.id, gridRowOf(v)])) as Record<string, GridRow>);
  // `saved` is what the server has; `values` is what the grid shows.
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [fill, setFill] = useState<GridRow>({ prices: {}, compareAt: {}, stock: {} });
  const [showCompareAt, setShowCompareAt] = useState(() => Object.values(initial).some((row) => Object.values(row.compareAt).some(Boolean)));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string[]>>({});
  const table = useRef<HTMLTableElement>(null);
  const running = !!progress;

  const priceColumns = canPrice ? channels.flatMap((c) => (c.currencies ?? []).map((currency) => ({ key: priceKey(c.id, currency), label: `${(c.code ?? "").toUpperCase()} · ${currency}` }))) : [];
  const columns: { field: GridField; key: string; header: string; label: string }[] = [
    ...priceColumns.flatMap((c) => [
      { field: "prices" as const, key: c.key, header: `Price ${c.label}`, label: `Price ${c.label}` },
      ...(showCompareAt ? [{ field: "compareAt" as const, key: c.key, header: `Compare at ${c.label}`, label: `Compare-at price ${c.label}` }] : []),
    ]),
    ...(canStock ? stockLocations.map((l) => ({ field: "stock" as const, key: l.id, header: `On hand ${l.code ?? l.name ?? ""}`, label: `On hand at ${l.name ?? l.code ?? ""}` })) : []),
  ];
  const savedRow = (v: EditorVariant) => saved[v.id] ?? gridRowOf(v);
  const valueRow = (v: EditorVariant) => values[v.id] ?? savedRow(v);
  const update = (variantId: string, field: GridField, key: string, value: string) =>
    setValues((all) => {
      const row = all[variantId] ?? saved[variantId] ?? { prices: {}, compareAt: {}, stock: {} };
      return { ...all, [variantId]: { ...row, [field]: { ...row[field], [key]: value } } };
    });

  // Every change, as the saves it needs: one price set per variant, one count per cell.
  const jobs: GridJob[] = variants.flatMap((v) => {
    const row = valueRow(v);
    const base = savedRow(v);
    const keys = priceColumns.map((c) => c.key).filter((key) => cellChanged("prices", row, base, key) || cellChanged("compareAt", row, base, key));
    const locations = canStock ? stockLocations.filter((l) => cellChanged("stock", row, base, l.id)) : [];
    return [...(keys.length ? [{ kind: "prices" as const, variant: v, keys }] : []), ...locations.map((l) => ({ kind: "stock" as const, variant: v, locationId: l.id }))];
  });
  // Every editable cell, shown or not: compare-at prices typed before hiding them still count.
  const cells: { field: GridField; key: string }[] = [
    ...priceColumns.flatMap((c) => [
      { field: "prices" as const, key: c.key },
      { field: "compareAt" as const, key: c.key },
    ]),
    ...(canStock ? stockLocations.map((l) => ({ field: "stock" as const, key: l.id })) : []),
  ];
  const count = (test: (field: GridField, row: GridRow, base: GridRow, key: string) => unknown) => variants.reduce((n, v) => n + cells.filter((c) => test(c.field, valueRow(v), savedRow(v), c.key)).length, 0);
  const changedCells = count(cellChanged);
  const problems = count(cellProblem);
  const goToFirstProblem = useProblemFocus(() => table.current);

  const nameOf = (field: GridField, key: string) => (field === "stock" ? (stockLocations.find((l) => l.id === key)?.name ?? "Stock") : (priceColumns.find((c) => c.key === key)?.label ?? key));

  const run = async () => {
    if (running || !jobs.length) return;
    if (problems) {
      if (variants.some((v) => priceColumns.some((c) => cellProblem("compareAt", valueRow(v), savedRow(v), c.key)))) setShowCompareAt(true);
      goToFirstProblem();
      return;
    }
    const work = jobs;
    const errors: Record<string, string[]> = {};
    const done: GridJob[] = [];
    setRowErrors({});
    setProgress({ done: 0, total: work.length });
    for (const [index, job] of work.entries()) {
      const row = valueRow(job.variant);
      try {
        if (job.kind === "prices") {
          const merged = mergedPrices(job.variant, row, job.keys);
          try {
            unwrap((await request(VariantPricesSet, { variantId: job.variant.id, prices: merged.prices })).productVariantPricesSet);
          } catch (error) {
            // Name the column a field error is about (paths are input.prices.<index>.<field>).
            if (!(error instanceof MutationError) || !error.fieldErrors.length) throw error;
            const where = (path: string[]) => {
              const index = Number(path[path.indexOf("prices") + 1]);
              return Number.isInteger(index) && index >= merged.keptCount ? nameOf("prices", merged.addedKeys[index - merged.keptCount] ?? "") : "Other prices";
            };
            throw new Error(error.fieldErrors.map((e) => `${where(e.path)}: ${e.message}`).join("; "));
          }
        } else {
          unwrap((await request(StockLevelSet, { variantId: job.variant.id, locationId: job.locationId, quantity: Number(row.stock[job.locationId]) })).stockLevelSet);
        }
        done.push(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Not saved";
        (errors[job.variant.id] ??= []).push(job.kind === "stock" ? `${nameOf("stock", job.locationId)}: ${message}` : message);
      }
      setProgress({ done: index + 1, total: work.length });
    }

    setProgress(null);
    const failed = work.length - done.length;
    const priceSets = done.filter((j) => j.kind === "prices").length;
    const counts = done.length - priceSets;
    const summary = [priceSets ? `prices of ${priceSets} variant${priceSets === 1 ? "" : "s"}` : null, counts ? `${counts} stock count${counts === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
    if (!failed) {
      toast.success(`Saved ${summary}`);
      onClose();
      void onSaved();
      return;
    }

    // Saved values become the baseline. A removed list price takes its compare-at price with it.
    const nextSaved = { ...saved };
    const nextValues = { ...values };
    for (const job of done) {
      const row = valueRow(job.variant);
      const base = nextSaved[job.variant.id] ?? gridRowOf(job.variant);
      if (job.kind === "stock") {
        nextSaved[job.variant.id] = { ...base, stock: { ...base.stock, [job.locationId]: row.stock[job.locationId] ?? "" } };
        continue;
      }
      const prices = { ...base.prices };
      const compareAt = { ...base.compareAt };
      const shown = { ...row.compareAt };
      for (const key of job.keys) {
        prices[key] = row.prices[key] ?? "";
        compareAt[key] = amountOf(row.prices[key]) ? (row.compareAt[key] ?? "") : "";
        shown[key] = compareAt[key];
      }
      nextSaved[job.variant.id] = { ...base, prices, compareAt };
      nextValues[job.variant.id] = { ...row, compareAt: shown };
    }
    setSaved(nextSaved);
    setValues(nextValues);
    setRowErrors(errors);
    toast.error(`${failed} of ${work.length} changes were not saved`, { description: done.length ? `Saved ${summary}. The rest are marked in red.` : "They are marked in red." });
    // Retries merge into the variants' latest price points.
    if (done.length) await onSaved();
  };

  /** Escape in a changed cell puts back its saved value, like a spreadsheet. */
  const revertFocusedCell = () => {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement) || !table.current?.contains(input)) return false;
    const { variant: variantId, field, key } = input.dataset;
    const variant = variants.find((v) => v.id === variantId);
    if (!variant || !field || key === undefined) return false;
    const before = savedRow(variant)[field as GridField][key] ?? "";
    if ((valueRow(variant)[field as GridField][key] ?? "") === before) return false;
    update(variant.id, field as GridField, key, before);
    return true;
  };

  /** Enter and Shift+Enter move down and up a column, like a spreadsheet; ⌘S saves. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      void run();
      return;
    }
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.column) return;
    event.preventDefault();
    const next = table.current?.querySelector<HTMLInputElement>(`input[data-column="${CSS.escape(input.dataset.column)}"][data-row="${Number(input.dataset.row) + (event.shiftKey ? -1 : 1)}"]`);
    next?.focus();
    next?.select();
  };

  const applyFill = () =>
    setValues((all) => {
      const next = { ...all };
      for (const v of variants) {
        const row = next[v.id] ?? savedRow(v);
        const take = (field: GridField) => Object.fromEntries(Object.entries(fill[field]).filter(([key, value]) => value.trim() && columns.some((c) => c.field === field && c.key === key)));
        next[v.id] = { prices: { ...row.prices, ...take("prices") }, compareAt: { ...row.compareAt, ...take("compareAt") }, stock: { ...row.stock, ...take("stock") } };
      }
      return next;
    });

  const title = canPrice && canStock ? "Prices and stock" : canPrice ? "Prices" : "Stock";
  return (
    <Sheet open onOpenChange={(open) => !open && !running && onClose()}>
      <SheetContent
        className="max-w-none sm:w-[min(80rem,calc(100vw-2rem))]"
        aria-describedby={undefined}
        // Closing asks before dropping changes; nothing closes it while saving.
        dirty={changedCells > 0 && !running}
        onEscapeKeyDown={(event) => {
          if (revertFocusedCell() || running) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (running) event.preventDefault();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4" onKeyDown={onKeyDown}>
          <div className="pr-8">
            <h2 className="text-base font-semibold">{title} of every variant</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {canPrice ? "List prices per channel and currency; group, tier and scheduled prices stay as they are (edit those under a variant's Prices). Empty a price to remove it. " : ""}
              {canStock ? "On-hand counts per location. " : ""}
              Enter moves down a column, <Kbd>{SAVE_SHORTCUT}</Kbd> saves.
            </p>
          </div>
          {canPrice && priceColumns.length ? (
            <Label className="w-fit font-normal">
              <Switch checked={showCompareAt} onCheckedChange={setShowCompareAt} disabled={running} />
              Show compare-at prices
            </Label>
          ) : null}
          <div className="min-h-0 overflow-auto rounded-lg border">
            <table ref={table} className="w-full text-[13px]">
              <thead className="sticky top-0 z-20 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium">Variant</th>
                  {columns.map((c) => (
                    <th key={`${c.field}:${c.key}`} className="px-2 py-2 text-left font-medium whitespace-nowrap">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {variants.length > 1 ? (
                  <tr className="bg-accent/30">
                    <td className="sticky left-0 z-10 bg-accent px-3 py-1.5">
                      <Button type="button" size="sm" variant="outline" disabled={running} onClick={applyFill}>
                        <ArrowDownToLine />
                        Fill down
                      </Button>
                    </td>
                    {columns.map((c) => (
                      <td key={`${c.field}:${c.key}`} className="px-2 py-1.5">
                        <Input
                          className={cn("h-8 tabular", c.field === "stock" ? "w-20" : "w-24")}
                          inputMode={c.field === "stock" ? "numeric" : "decimal"}
                          value={fill[c.field][c.key] ?? ""}
                          onChange={(e) => setFill({ ...fill, [c.field]: { ...fill[c.field], [c.key]: e.target.value } })}
                          disabled={running}
                          aria-label={`${c.label} for every variant`}
                          data-row={-1}
                          data-column={`${c.field}:${c.key}`}
                        />
                      </td>
                    ))}
                  </tr>
                ) : null}
                {variants.map((v, index) => {
                  const row = valueRow(v);
                  const base = savedRow(v);
                  const errors = rowErrors[v.id];
                  return (
                    <tr key={v.id} className={cn(errors && "bg-destructive/5")}>
                      <td className="sticky left-0 z-10 max-w-64 bg-popover px-3 py-1.5">
                        <p className="truncate font-medium">{variantLabel(v)}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {v.sku}
                          {canStock && !v.trackInventory ? <span className="font-sans"> · stock not tracked</span> : null}
                        </p>
                        {errors ? (
                          <ul className="mt-1 space-y-0.5 text-xs whitespace-normal text-destructive">
                            {errors.map((e, i) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                      {columns.map((c) => {
                        const problem = cellProblem(c.field, row, base, c.key);
                        const changed = cellChanged(c.field, row, base, c.key);
                        return (
                          <td key={`${c.field}:${c.key}`} className="px-2 py-1.5">
                            <Input
                              className={cn("h-8 tabular", c.field === "stock" ? "w-20" : "w-24", changed && !problem && "border-primary/70 bg-primary/5")}
                              inputMode={c.field === "stock" ? "numeric" : "decimal"}
                              value={row[c.field][c.key] ?? ""}
                              placeholder={c.field === "stock" ? "0" : "—"}
                              onChange={(e) => update(v.id, c.field, c.key, e.target.value)}
                              disabled={running}
                              aria-label={`${c.label}, ${v.sku}`}
                              aria-invalid={problem ? true : undefined}
                              title={problem ?? (changed ? `Was ${base[c.field][c.key] || "empty"}` : undefined)}
                              data-variant={v.id}
                              data-field={c.field}
                              data-key={c.key}
                              data-row={index}
                              data-column={`${c.field}:${c.key}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {columns.length === 0 ? <Alert variant="info">There are no channels with currencies or stock locations to edit yet.</Alert> : null}
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="min-w-0 flex-1 text-[13px] text-muted-foreground" aria-live="polite">
              {progress ? (
                <div className="flex max-w-xs flex-col gap-1.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
                  </div>
                  <span>
                    Saving {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                  </span>
                </div>
              ) : problems ? (
                <span className="text-destructive">
                  {problems} cell{problems === 1 ? "" : "s"} to fix
                </span>
              ) : changedCells ? (
                `${changedCells} change${changedCells === 1 ? "" : "s"}, highlighted`
              ) : (
                "No changes yet"
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={running} onClick={onClose}>
                {changedCells ? "Cancel" : "Close"}
              </Button>
              <Button type="button" loading={running} disabled={!jobs.length} onClick={() => void run()}>
                {running ? null : <Save />}
                {changedCells ? `Save ${changedCells} change${changedCells === 1 ? "" : "s"}` : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

// ---------------------------------------------------------------- generate variants

/** Create the option combinations a product does not have yet. */
const GenerateDialog = ({ product, axes, variants, onClose, onDone }: { product: EditorProduct; axes: (Axis & { code: string })[]; variants: readonly EditorVariant[]; onClose: () => void; onDone: () => void }) => {
  const { stockLocations } = useReference();
  const codes = axes.map((a) => a.code);
  const used = (code: string) => [...new Set(variants.flatMap((v) => (v.selectedOptions ?? []).filter((o) => o.attribute === code).map((o) => o.value ?? "")))];
  const [selected, setSelected] = useState<Record<string, string[]>>(() => Object.fromEntries(codes.map((c) => [c, used(c)])));
  const [base, setBase] = useState(() => baseOf(variants[0]) || skuFor((product.name ?? "item").slice(0, 10), []));
  const [template, setTemplate] = useState(variants[0]?.id ?? "");
  const [locationId, setLocationId] = useState(stockLocations[0]?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; failures: string[] } | null>(null);
  const [opened] = useState(() => JSON.stringify([selected, base, template, locationId, quantity]));
  const dirty = !progress && JSON.stringify([selected, base, template, locationId, quantity]) !== opened;

  const existing = new Set(variants.map((v) => comboKey(codes, optionsOf(v))));
  const combos = combinations(axes.map((a) => ({ code: a.code, values: selected[a.code] ?? [] }))).filter((c) => !existing.has(comboKey(codes, c)));
  const labelOf = (code: string, value: string) => axes.find((a) => a.code === code)?.options?.find((o) => o.code === value)?.label ?? value;
  const source = variants.find((v) => v.id === template);

  const run = async () => {
    setProgress({ done: 0, total: combos.length, failures: [] });
    const failures: string[] = [];
    for (const [index, options] of combos.entries()) {
      const sku = skuFor(base, codes.map((c) => options[c] ?? ""));
      try {
        const input: VariantCreateInput = {
          sku,
          options: codes.map((c) => ({ attribute: c, value: options[c]! })),
          position: variants.length + index,
          weightGrams: source?.weightGrams ?? null,
          trackInventory: source?.trackInventory ?? true,
          allowBackorder: source?.allowBackorder ?? false,
          prices: source ? pricesFrom(source) : null,
          stock: quantity.trim() && locationId ? [{ locationId, quantity: Number(quantity) }] : null,
        };
        unwrap((await request(VariantCreate, { productId: product.id, input })).productVariantCreate);
      } catch (error) {
        failures.push(`${sku}: ${error instanceof Error ? error.message : "failed"}`);
      }
      setProgress({ done: index + 1, total: combos.length, failures: [...failures] });
    }
    onDone();
    const created = combos.length - failures.length;
    if (created) toast.success(`${created} variant${created === 1 ? "" : "s"} created`);
    if (!failures.length) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !progress && onClose()}>
      <DialogContent wide dirty={dirty}>
        <DialogHeader>
          <DialogTitle>Generate variants</DialogTitle>
          <DialogDescription>Choose the option values to sell; every missing combination becomes a variant.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {axes.map((axis) => (
            <Field key={axis.code} label={axis.label ?? axis.code}>
              <MultiSelect
                options={(axis.options ?? []).map((o) => ({ value: o.code ?? "", label: o.label ?? o.code ?? "", icon: <Swatch swatch={o.swatch} /> }))}
                value={selected[axis.code] ?? []}
                onChange={(value) => setSelected({ ...selected, [axis.code]: value })}
              />
            </Field>
          ))}
          <Field label="SKU prefix" hint={`e.g. ${skuFor(base, codes.map((c) => selected[c]?.[0] ?? "X"))}`}>
            <Input className="font-mono" value={base} onChange={(e) => setBase(e.target.value)} />
          </Field>
          <Field label="Copy prices and weight from">
            <NativeSelect value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Nothing (set prices later)</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.sku}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Initial stock" hint="Optional, at one location">
            <div className="flex gap-2">
              <Input type="number" min={0} className="w-24" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              <NativeSelect value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {stockLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </Field>
        </div>
        <div className="max-h-56 overflow-y-auto rounded-lg border">
          {combos.length === 0 ? (
            <p className="p-4 text-center text-[13px] text-muted-foreground">Every chosen combination already exists.</p>
          ) : (
            <ul className="divide-y text-[13px]">
              {combos.map((c) => (
                <li key={comboKey(codes, c)} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>{codes.map((code) => labelOf(code, c[code] ?? "")).join(" / ")}</span>
                  <span className="font-mono text-xs text-muted-foreground">{skuFor(base, codes.map((code) => c[code] ?? ""))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {progress ? (
          <div className="space-y-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress.done} of {progress.total}
            </p>
            {progress.failures.length ? (
              <Alert variant="destructive" title={`${progress.failures.length} could not be created`}>
                <ul className="list-disc pl-4">
                  {progress.failures.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!progress && progress.done < progress.total}>
            {progress && progress.done === progress.total ? "Close" : "Cancel"}
          </Button>
          <Button loading={!!progress && progress.done < progress.total} disabled={!combos.length || !base.trim() || (!!progress && progress.done === progress.total)} onClick={() => void run()}>
            <Wand2 />
            Create {combos.length} variant{combos.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- new products

export type NewVariantRow = {
  key: string;
  options: Record<string, string>;
  sku: string;
  skuEdited: boolean;
  weightGrams: string;
  barcode: string;
  /** Amount per `${channelId}|${currency}`. */
  prices: Record<string, string>;
  /** Quantity per location id. */
  stock: Record<string, string>;
};

export const newVariantInputs = (rows: readonly NewVariantRow[], axisCodes: readonly string[]): VariantCreateInput[] =>
  rows.map((r, index) => ({
    sku: r.sku.trim(),
    options: axisCodes.length ? axisCodes.map((code) => ({ attribute: code, value: r.options[code] ?? "" })) : null,
    position: index,
    weightGrams: r.weightGrams.trim() ? Number(r.weightGrams) : null,
    barcode: r.barcode.trim() || null,
    prices: Object.entries(r.prices)
      .filter(([, amount]) => amount.trim())
      .map(([key, amount]) => {
        const [channelId, currencyCode] = key.split("|") as [string, string];
        return { channelId, currencyCode, amount: amount.trim() };
      }),
    stock: Object.entries(r.stock)
      .filter(([, quantity]) => quantity.trim())
      .map(([locationId, quantity]) => ({ locationId, quantity: Number(quantity) })),
  }));

const blankRow = (key: string, options: Record<string, string>, sku: string): NewVariantRow => ({ key, options, sku, skuEdited: false, weightGrams: "", barcode: "", prices: {}, stock: {} });

/** By row key. SKUs count as duplicates regardless of case. */
export const skuProblems = (rows: readonly NewVariantRow[]): Record<string, string> => {
  const uses = new Map<string, number>();
  for (const row of rows) {
    const sku = row.sku.trim().toUpperCase();
    if (sku) uses.set(sku, (uses.get(sku) ?? 0) + 1);
  }
  return Object.fromEntries(
    rows.flatMap((row) => {
      const sku = row.sku.trim();
      if (!sku) return [[row.key, "Enter a SKU"]];
      if (!SKU_PATTERN.test(sku)) return [[row.key, "Letters, digits and . _ - / only"]];
      if ((uses.get(sku.toUpperCase()) ?? 0) > 1) return [[row.key, "Another variant has this SKU"]];
      return [];
    }),
  );
};

/** Pick option values per axis, then fill in each variant's SKU, prices and opening stock. */
export const NewVariantsEditor = ({
  axes,
  rows,
  onChange,
  nameHint,
  skuErrors = {},
}: {
  axes: (Axis & { code: string })[];
  rows: NewVariantRow[];
  onChange: (rows: NewVariantRow[]) => void;
  nameHint: string;
  skuErrors?: Record<string, string>;
}) => {
  const { channels, stockLocations } = useReference();
  const codes = axes.map((a) => a.code);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [base, setBase] = useState("");
  const [fill, setFill] = useState<{ prices: Record<string, string>; stock: Record<string, string>; weightGrams: string }>({ prices: {}, stock: {}, weightGrams: "" });
  const effectiveBase = base || skuFor(nameHint.slice(0, 12) || "item", []);
  const priceColumns = channels.flatMap((c) => (c.currencies ?? []).map((currency) => ({ key: `${c.id}|${currency}`, label: `${(c.code ?? "").toUpperCase()} · ${currency}` })));

  const regenerate = (nextSelected: Record<string, string[]>, nextBase: string) => {
    const combos = codes.length ? combinations(axes.map((a) => ({ code: a.code, values: nextSelected[a.code] ?? [] }))) : [{}];
    const usable = codes.length && codes.some((c) => !(nextSelected[c] ?? []).length) ? [] : combos;
    onChange(
      usable.map((options) => {
        const key = comboKey(codes, options);
        const sku = skuFor(nextBase, codes.map((c) => options[c] ?? ""));
        const previous = rows.find((r) => r.key === key);
        return previous ? { ...previous, sku: previous.skuEdited ? previous.sku : sku } : blankRow(key, options, sku);
      }),
    );
  };

  // A product without variant options has exactly one variant.
  useEffect(() => {
    if (!codes.length && rows.length !== 1) regenerate({}, effectiveBase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes.length]);

  // While the prefix is automatic, SKUs follow the product name as it is typed.
  useEffect(() => {
    if (!base && rows.length) regenerate(selected, effectiveBase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveBase]);

  const update = (key: string, patch: Partial<NewVariantRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const labelOf = (code: string, value: string) => axes.find((a) => a.code === code)?.options?.find((o) => o.code === value)?.label ?? value;

  return (
    <div className="flex flex-col gap-4">
      {codes.length ? (
        // With no variants yet, Save goes to the option pickers rather than the SKU prefix.
        <div className="grid gap-3 sm:grid-cols-2" data-problem-focus="">
          {axes.map((axis) => (
            <Field key={axis.code} label={axis.label ?? axis.code} required>
              <MultiSelect
                options={(axis.options ?? []).map((o) => ({ value: o.code ?? "", label: o.label ?? o.code ?? "", icon: <Swatch swatch={o.swatch} /> }))}
                value={selected[axis.code] ?? []}
                onChange={(value) => {
                  const next = { ...selected, [axis.code]: value };
                  setSelected(next);
                  regenerate(next, effectiveBase);
                }}
                placeholder={`Choose ${(axis.label ?? axis.code).toLowerCase()} values`}
              />
            </Field>
          ))}
        </div>
      ) : null}
      <Field label="SKU prefix" hint="Variant SKUs are the prefix plus each option, unless you edit one." className="max-w-xs">
        <Input
          className="font-mono"
          value={base}
          placeholder={effectiveBase}
          onChange={(e) => {
            setBase(e.target.value);
            regenerate(selected, e.target.value || skuFor(nameHint.slice(0, 12) || "item", []));
          }}
        />
      </Field>
      {rows.length === 0 ? (
        <Alert variant="info">Choose at least one value for every option to create variants.</Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                {codes.length ? <th className="px-3 py-2 text-left font-medium">Variant</th> : null}
                <th className="px-3 py-2 text-left font-medium">SKU</th>
                {priceColumns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                    Price {c.label}
                  </th>
                ))}
                {stockLocations.map((l) => (
                  <th key={l.id} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                    Stock {l.code}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Weight (g)</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length > 1 ? (
                <tr className="bg-accent/30">
                  {codes.length ? <td className="px-3 py-2 text-xs font-medium text-muted-foreground">Apply to all</td> : null}
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onChange(
                          rows.map((r) => ({
                            ...r,
                            prices: { ...r.prices, ...Object.fromEntries(Object.entries(fill.prices).filter(([, v]) => v.trim())) },
                            stock: { ...r.stock, ...Object.fromEntries(Object.entries(fill.stock).filter(([, v]) => v.trim())) },
                            weightGrams: fill.weightGrams.trim() ? fill.weightGrams : r.weightGrams,
                          })),
                        )
                      }
                    >
                      Fill down
                    </Button>
                  </td>
                  {priceColumns.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      <Input className="h-8 w-24" inputMode="decimal" value={fill.prices[c.key] ?? ""} onChange={(e) => setFill({ ...fill, prices: { ...fill.prices, [c.key]: e.target.value } })} aria-label={`All prices ${c.label}`} />
                    </td>
                  ))}
                  {stockLocations.map((l) => (
                    <td key={l.id} className="px-3 py-2">
                      <Input className="h-8 w-20" type="number" min={0} value={fill.stock[l.id] ?? ""} onChange={(e) => setFill({ ...fill, stock: { ...fill.stock, [l.id]: e.target.value } })} aria-label={`All stock ${l.code}`} />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <Input className="h-8 w-20" type="number" min={0} value={fill.weightGrams} onChange={(e) => setFill({ ...fill, weightGrams: e.target.value })} aria-label="All weights" />
                  </td>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr key={row.key}>
                  {codes.length ? <td className="px-3 py-2 whitespace-nowrap">{codes.map((code) => labelOf(code, row.options[code] ?? "")).join(" / ")}</td> : null}
                  <td className="px-3 py-2">
                    <Input
                      className={cn("h-8 w-44 font-mono text-xs", row.sku && !SKU_PATTERN.test(row.sku) && "border-destructive")}
                      value={row.sku}
                      onChange={(e) => update(row.key, { sku: e.target.value, skuEdited: true })}
                      aria-label={codes.length ? `SKU for ${codes.map((code) => labelOf(code, row.options[code] ?? "")).join(" / ")}` : "SKU"}
                      aria-invalid={skuErrors[row.key] ? true : undefined}
                      aria-describedby={skuErrors[row.key] ? `sku-problem-${row.key.replace(/\s+/g, "_")}` : undefined}
                    />
                    {skuErrors[row.key] ? (
                      <p id={`sku-problem-${row.key.replace(/\s+/g, "_")}`} className="mt-1 text-[11px] text-destructive">
                        {skuErrors[row.key]}
                      </p>
                    ) : null}
                  </td>
                  {priceColumns.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      <Input className="h-8 w-24" inputMode="decimal" placeholder="0.00" value={row.prices[c.key] ?? ""} onChange={(e) => update(row.key, { prices: { ...row.prices, [c.key]: e.target.value } })} aria-label={`Price ${c.label}`} />
                    </td>
                  ))}
                  {stockLocations.map((l) => (
                    <td key={l.id} className="px-3 py-2">
                      <Input className="h-8 w-20" type="number" min={0} value={row.stock[l.id] ?? ""} onChange={(e) => update(row.key, { stock: { ...row.stock, [l.id]: e.target.value } })} aria-label={`Stock ${l.code}`} />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <Input className="h-8 w-20" type="number" min={0} value={row.weightGrams} onChange={(e) => update(row.key, { weightGrams: e.target.value })} aria-label="Weight in grams" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
