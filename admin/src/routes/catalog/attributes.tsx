import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ListTree, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { LocalizedInput } from "@/components/inputs";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Sheet, SheetContent } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useReference } from "@/lib/hooks";
import { toLocalizedList } from "@/lib/utils";
import { ATTRIBUTE_TYPES, CATALOG_KEYS, Swatch, swatchColor, useAttributeDefinitions, type AttributeDefinition, type AttributeType } from "./shared";

const AttributeCreate = graphql(
  `
    mutation AttributeDefinitionCreate($input: AttributeDefinitionInput!) {
      attributeDefinitionCreate(input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const AttributeUpdate = graphql(
  `
    mutation AttributeDefinitionUpdate($id: ID!, $input: AttributeDefinitionUpdateInput!) {
      attributeDefinitionUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const AttributeDelete = graphql(
  `
    mutation AttributeDefinitionDelete($id: ID!) {
      attributeDefinitionDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const CODE = /^[a-z][a-z0-9_]{0,59}$/;
const OPTION_CODE = /^[a-z0-9_-]{1,60}$/;
const hasOptions = (type: AttributeType) => type === "SELECT" || type === "MULTISELECT";
const typeLabel = (type: AttributeType | null) => ATTRIBUTE_TYPES.find((t) => t.value === type)?.label ?? type ?? "";

type OptionForm = { code: string; labels: Record<string, string>; swatch: string; isNew: boolean };
type AttributeForm = {
  code: string;
  type: AttributeType;
  labels: Record<string, string>;
  isLocalized: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
  isRequired: boolean;
  unit: string;
  position: string;
  options: OptionForm[];
};

/** Per-locale text from the API, whose list entries are nullable. */
const recordOf = (list: readonly { locale: string | null; value: string | null }[] | null | undefined) =>
  Object.fromEntries((list ?? []).flatMap((l) => (l.locale ? [[l.locale, l.value ?? ""]] : []))) as Record<string, string>;

const formOf = (definition: AttributeDefinition | null, nextPosition: number): AttributeForm => ({
  code: definition?.code ?? "",
  type: (definition?.type ?? "TEXT") as AttributeType,
  labels: recordOf(definition?.labels),
  isLocalized: !!definition?.isLocalized,
  isFilterable: !!definition?.isFilterable,
  isSearchable: !!definition?.isSearchable,
  isRequired: !!definition?.isRequired,
  unit: definition?.unit ?? "",
  position: String(definition?.position ?? nextPosition),
  options: (definition?.options ?? []).map((o) => ({ code: o.code ?? "", labels: recordOf(o.labels), swatch: o.swatch ?? "", isNew: false })),
});

export const AttributesPage = () => {
  const { can } = useAuth();
  const write = can("catalog:write");
  const queryClient = useQueryClient();
  const { definitions, isLoading } = useAttributeDefinitions();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ definition: AttributeDefinition | null } | null>(null);
  const [deleting, setDeleting] = useState<AttributeDefinition | null>(null);
  const refresh = () =>
    Promise.all([CATALOG_KEYS.attributes, CATALOG_KEYS.reference, ["product-types-full"], CATALOG_KEYS.productTypes].map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  const sorted = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...definitions]
      .filter((d) => !q || d.code?.includes(q) || d.label?.toLowerCase().includes(q))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.code ?? "").localeCompare(b.code ?? ""));
  }, [definitions, filter]);

  const remove = useAction(async (id: string) => unwrap((await request(AttributeDelete, { id })).attributeDefinitionDelete), {
    success: "Attribute deleted",
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <Page>
      <PageHeader
        title="Attributes"
        description="Typed product specifications. Select attributes can be variant options; filterable ones become storefront filters."
        actions={
          write ? (
            <Button onClick={() => setEditing({ definition: null })}>
              <Plus />
              Add attribute
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by code or label" className="h-8 pl-8" />
          </div>
          <span className="ml-auto text-[13px] text-muted-foreground">{definitions.length} attributes</span>
        </div>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState icon={ListTree} title={filter ? "No matching attributes" : "No attributes yet"} description="Attributes describe products: brand, material, size, colour." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Attribute</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Options</TableHead>
                <TableHead>Behaviour</TableHead>
                <TableHead className="text-right">Position</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((d) => (
                <TableRow key={d.id} className={write ? "cursor-pointer" : undefined} onClick={() => write && setEditing({ definition: d })}>
                  <TableCell>
                    <span className="font-medium">{d.label}</span>
                    <p className="font-mono text-xs text-muted-foreground">{d.code}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{typeLabel(d.type as AttributeType)}</Badge>
                    {d.unit ? <span className="ml-1.5 text-xs text-muted-foreground">{d.unit}</span> : null}
                  </TableCell>
                  <TableCell>
                    {(d.options ?? []).length ? (
                      <div className="flex max-w-xs flex-wrap items-center gap-1">
                        {(d.options ?? []).slice(0, 6).map((o) => (
                          <Badge key={o.code} variant="outline" className="rounded-md">
                            <Swatch swatch={o.swatch} />
                            {o.label}
                          </Badge>
                        ))}
                        {(d.options ?? []).length > 6 ? <span className="text-xs text-muted-foreground">+{(d.options ?? []).length - 6}</span> : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {d.isFilterable ? <Badge variant="info">Filterable</Badge> : null}
                      {d.isSearchable ? <Badge variant="secondary">Searchable</Badge> : null}
                      {d.isRequired ? <Badge variant="warning">Required</Badge> : null}
                      {d.isLocalized ? <Badge variant="outline">Per language</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">{d.position}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {write ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.code}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setEditing({ definition: d })}>
                            <Pencil />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={() => setDeleting(d)}>
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {editing ? (
        <AttributeSheet
          key={editing.definition?.id ?? "new"}
          definition={editing.definition}
          nextPosition={Math.max(0, ...definitions.map((d) => d.position ?? 0)) + 1}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the ${deleting?.label ?? deleting?.code ?? ""} attribute?`}
        description="Only attributes no product type uses can be deleted. Values stored on products are not shown anywhere afterwards."
        destructive
        confirmLabel="Delete attribute"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  );
};

const AttributeSheet = ({ definition, nextPosition, onClose, onSaved }: { definition: AttributeDefinition | null; nextPosition: number; onClose: () => void; onSaved: () => void }) => {
  const { locales, defaultLocale } = useReference();
  const form = useForm<AttributeForm>({ defaultValues: formOf(definition, nextPosition) });
  const options = useFieldArray({ control: form.control, name: "options" });
  const type = form.watch("type");
  const creating = !definition;

  const save = useAction(
    async (values: AttributeForm) => {
      const optionInputs = hasOptions(values.type) ? values.options.map((o) => ({ code: o.code.trim(), labels: toLocalizedList(o.labels), swatch: o.swatch.trim() || null })) : [];
      const common = {
        labels: toLocalizedList(values.labels),
        isFilterable: values.isFilterable,
        isSearchable: values.isSearchable,
        isRequired: values.isRequired,
        unit: values.unit.trim() || null,
        position: Number(values.position) || 0,
        options: optionInputs,
      };
      if (definition) return unwrap((await request(AttributeUpdate, { id: definition.id, input: common })).attributeDefinitionUpdate);
      return unwrap((await request(AttributeCreate, { input: { ...common, code: values.code.trim(), type: values.type, isLocalized: values.isLocalized && (values.type === "TEXT" || values.type === "RICH_TEXT") } })).attributeDefinitionCreate);
    },
    { success: creating ? "Attribute created" : "Attribute saved", onSuccess: onSaved, onError: (error) => reportError(error, form, ["input"]) },
  );

  const submit = form.handleSubmit((values) => {
    let ok = true;
    if (creating && !CODE.test(values.code.trim())) {
      form.setError("code", { message: "Start with a letter; use lowercase letters, digits and underscores" });
      ok = false;
    }
    if (!values.labels[defaultLocale]?.trim()) {
      form.setError("labels", { message: `Enter a label in ${defaultLocale}` });
      ok = false;
    }
    if (hasOptions(values.type)) {
      if (!values.options.length) {
        toast.error("Select attributes need at least one option");
        ok = false;
      }
      const codes = values.options.map((o) => o.code.trim());
      values.options.forEach((o, i) => {
        if (!OPTION_CODE.test(o.code.trim())) {
          form.setError(`options.${i}.code`, { message: "Lowercase letters, digits, - and _" });
          ok = false;
        } else if (codes.indexOf(o.code.trim()) !== i) {
          form.setError(`options.${i}.code`, { message: "Duplicate code" });
          ok = false;
        }
      });
    }
    if (ok) save.mutate(values);
  });

  const errors = form.formState.errors;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:w-[40rem] sm:max-w-[40rem]" aria-describedby={undefined} dirty={form.formState.isDirty}>
        <div>
          <h2 className="text-base font-semibold">{creating ? "Add attribute" : `Edit ${definition.label ?? definition.code}`}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{creating ? "Code, type and per-language values are fixed once created." : `Code ${definition.code} · ${typeLabel(definition.type as AttributeType)}`}</p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {creating ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Code" required hint="Used in the API and filters, e.g. material" error={errors.code?.message}>
                <Input className="font-mono" {...form.register("code")} />
              </Field>
              <Field label="Type" required>
                <NativeSelect {...form.register("type")}>
                  {ATTRIBUTE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          ) : null}
          <Field label="Label" required error={(errors.labels as { message?: string } | undefined)?.message}>
            <Controller control={form.control} name="labels" render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={locales} />} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Unit" hint="Shown after numbers, e.g. cm or g">
              <Input {...form.register("unit")} disabled={type !== "NUMBER"} />
            </Field>
            <Field label="Position" hint="Order in filters and on product pages">
              <Input type="number" {...form.register("position")} />
            </Field>
          </div>
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <Controller
              control={form.control}
              name="isFilterable"
              render={({ field }) => (
                <Label className="justify-between font-normal">
                  <span>
                    <span className="block">Filterable</span>
                    <span className="text-xs text-muted-foreground">Shown as a facet in storefront search and category pages</span>
                  </span>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </Label>
              )}
            />
            <Controller
              control={form.control}
              name="isSearchable"
              render={({ field }) => (
                <Label className="justify-between font-normal">
                  <span>
                    <span className="block">Searchable</span>
                    <span className="text-xs text-muted-foreground">Values are matched by full-text search</span>
                  </span>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </Label>
              )}
            />
            <Controller
              control={form.control}
              name="isRequired"
              render={({ field }) => (
                <Label className="justify-between font-normal">
                  <span>
                    <span className="block">Required</span>
                    <span className="text-xs text-muted-foreground">Products of types with this attribute must set it</span>
                  </span>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </Label>
              )}
            />
            <Controller
              control={form.control}
              name="isLocalized"
              render={({ field }) => (
                <Label className="justify-between font-normal">
                  <span>
                    <span className="block">Value per language</span>
                    <span className="text-xs text-muted-foreground">{creating ? "Text attributes only; fixed after creation" : "Fixed after creation"}</span>
                  </span>
                  <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!creating || (type !== "TEXT" && type !== "RICH_TEXT")} />
                </Label>
              )}
            />
          </div>

          {hasOptions(type) ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Options</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => options.append({ code: "", labels: {}, swatch: "", isNew: true })}>
                  <Plus />
                  Add option
                </Button>
              </div>
              {!creating ? <p className="text-xs text-muted-foreground">Existing option codes cannot change, because products store them. Removing an option leaves products that use it without a valid value.</p> : null}
              {options.fields.length === 0 ? <p className="rounded-lg border border-dashed p-4 text-center text-[13px] text-muted-foreground">No options yet.</p> : null}
              {options.fields.map((field, index) => {
                const swatch = form.watch(`options.${index}.swatch`);
                return (
                  <div key={field.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[9rem_1fr_auto]">
                    <Field label="Code" error={errors.options?.[index]?.code?.message}>
                      <Input className="font-mono" {...form.register(`options.${index}.code`)} disabled={!field.isNew} />
                    </Field>
                    <Field label="Label">
                      <Controller control={form.control} name={`options.${index}.labels`} render={({ field: f }) => <LocalizedInput value={f.value} onChange={f.onChange} locales={locales} />} />
                    </Field>
                    <div className="flex items-end gap-1">
                      <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => options.move(index, index - 1)} aria-label="Move up">
                        <ArrowUp />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" disabled={index === options.fields.length - 1} onClick={() => options.move(index, index + 1)} aria-label="Move down">
                        <ArrowDown />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => options.remove(index)} aria-label="Remove option">
                        <Trash2 />
                      </Button>
                    </div>
                    <Field label="Swatch" hint="A colour, or any text for image swatches" className="sm:col-span-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          aria-label="Pick a colour"
                          className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
                          value={swatchColor(swatch) ?? "#000000"}
                          onChange={(e) => form.setValue(`options.${index}.swatch`, e.target.value, { shouldDirty: true })}
                        />
                        <Input className="font-mono" placeholder="#1d4ed8" {...form.register(`options.${index}.swatch`)} />
                      </div>
                    </Field>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {creating ? "Create attribute" : "Save attribute"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
};
