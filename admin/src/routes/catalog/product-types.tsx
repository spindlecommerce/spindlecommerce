import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, Plus, Shapes, Trash2 } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MultiSelect } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Sheet, SheetContent } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatNumber } from "@/lib/format";
import { useAction, useReference } from "@/lib/hooks";
import { CATALOG_KEYS, useAttributeDefinitions } from "./shared";

const ProductTypesQuery = graphql(`
  query ProductTypesAdmin {
    productTypes {
      id
      code
      name
      isShippable
      productCount
      taxClass {
        id
        name
      }
      attributes {
        id
        code
        label
      }
      variantAttributes {
        id
        code
        label
      }
    }
  }
`);

type ProductType = NonNullable<ResultOf<typeof ProductTypesQuery>["productTypes"]>[number];

const ProductTypeCreate = graphql(
  `
    mutation ProductTypeCreate($input: ProductTypeInput!) {
      productTypeCreate(input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const ProductTypeUpdate = graphql(
  `
    mutation ProductTypeUpdate($id: ID!, $input: ProductTypeUpdateInput!) {
      productTypeUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const ProductTypeDelete = graphql(
  `
    mutation ProductTypeDelete($id: ID!) {
      productTypeDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const CODE = /^[a-z][a-z0-9_]{0,59}$/;

type TypeForm = { code: string; name: string; attributeCodes: string[]; variantAttributeCodes: string[]; isShippable: boolean; taxClassId: string };

const codes = (list: readonly { code: string | null }[] | null | undefined) => (list ?? []).flatMap((a) => (a.code ? [a.code] : []));

const AttributeChips = ({ list, variant }: { list: readonly { code: string | null; label: string | null }[] | null | undefined; variant: "secondary" | "outline" }) =>
  (list ?? []).length ? (
    <div className="flex max-w-sm flex-wrap gap-1">
      {(list ?? []).map((a) => (
        <Badge key={a.code} variant={variant} className="rounded-md">
          {a.label ?? a.code}
        </Badge>
      ))}
    </div>
  ) : (
    <span className="text-muted-foreground">—</span>
  );

export const ProductTypesPage = () => {
  const { can } = useAuth();
  const write = can("catalog:write");
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: CATALOG_KEYS.productTypes, queryFn: () => request(ProductTypesQuery) });
  const types = query.data?.productTypes ?? [];
  const [editing, setEditing] = useState<{ type: ProductType | null } | null>(null);
  const [deleting, setDeleting] = useState<ProductType | null>(null);
  const refresh = () => Promise.all([CATALOG_KEYS.productTypes, CATALOG_KEYS.reference, ["product-types-full"]].map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  const remove = useAction(async (id: string) => unwrap((await request(ProductTypeDelete, { id })).productTypeDelete), {
    success: "Product type deleted",
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <Page>
      <PageHeader
        title="Product types"
        description="Which attributes a product has and which options its variants differ by."
        actions={
          write ? (
            <Button onClick={() => setEditing({ type: null })}>
              <Plus />
              Add product type
            </Button>
          ) : null
        }
      />
      <Card className="overflow-hidden">
        {query.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : types.length === 0 ? (
          <EmptyState icon={Shapes} title="No product types yet" description="A product type, such as Apparel, groups the attributes its products share." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Type</TableHead>
                <TableHead>Variant options</TableHead>
                <TableHead>Attributes</TableHead>
                <TableHead>Shipping</TableHead>
                <TableHead>Tax class</TableHead>
                <TableHead className="text-right">Products</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((t) => {
                const count = t.productCount ?? 0;
                return (
                  <TableRow key={t.id} className={write ? "cursor-pointer" : undefined} onClick={() => write && setEditing({ type: t })}>
                    <TableCell>
                      <span className="font-medium">{t.name}</span>
                      <p className="font-mono text-xs text-muted-foreground">{t.code}</p>
                    </TableCell>
                    <TableCell>
                      {(t.variantAttributes ?? []).length ? <AttributeChips list={t.variantAttributes} variant="secondary" /> : <span className="text-muted-foreground">Single variant</span>}
                    </TableCell>
                    <TableCell>
                      <AttributeChips list={t.attributes} variant="outline" />
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.isShippable ? "secondary" : "info"}>{t.isShippable ? "Physical" : "Not shipped"}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.taxClass?.name ?? "—"}</TableCell>
                    <TableCell className="text-right tabular" onClick={(e) => e.stopPropagation()}>
                      {count ? (
                        <Link to="/products" search={{ type: t.id }} className="hover:underline">
                          {formatNumber(count)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {write ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onSelect={() => setEditing({ type: t })}>
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link to="/products" search={{ type: t.id }}>
                                <Shapes />
                                View products
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive disabled={count > 0} onSelect={() => setDeleting(t)}>
                              <Trash2 />
                              Delete
                              {count > 0 ? <span className="ml-auto pl-4 text-xs">in use</span> : null}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {editing ? (
        <TypeSheet
          key={editing.type?.id ?? "new"}
          type={editing.type}
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
        title={`Delete the ${deleting?.name ?? ""} product type?`}
        description="No product uses it. Its attributes stay available to other product types."
        destructive
        confirmLabel="Delete product type"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  );
};

const TypeSheet = ({ type, onClose, onSaved }: { type: ProductType | null; onClose: () => void; onSaved: () => void }) => {
  const { taxClasses } = useReference();
  const { definitions } = useAttributeDefinitions();
  const creating = !type;
  const form = useForm<TypeForm>({
    defaultValues: {
      code: type?.code ?? "",
      name: type?.name ?? "",
      attributeCodes: codes(type?.attributes),
      variantAttributeCodes: codes(type?.variantAttributes),
      isShippable: type?.isShippable ?? true,
      taxClassId: type?.taxClass?.id ?? "",
    },
  });
  const variantCodes = form.watch("variantAttributeCodes");
  const options = definitions.map((d) => ({ value: d.code ?? "", label: d.label ?? d.code ?? "", hint: d.code ?? undefined }));
  const selectOptions = definitions.filter((d) => d.type === "SELECT").map((d) => ({ value: d.code ?? "", label: d.label ?? d.code ?? "", hint: d.code ?? undefined }));

  const save = useAction(
    async (values: TypeForm) => {
      const attributeCodes = values.attributeCodes.filter((c) => !values.variantAttributeCodes.includes(c));
      if (type) {
        return unwrap(
          (await request(ProductTypeUpdate, { id: type.id, input: { name: values.name.trim(), attributeCodes, isShippable: values.isShippable, taxClassId: values.taxClassId || null } })).productTypeUpdate,
        );
      }
      return unwrap(
        (
          await request(ProductTypeCreate, {
            input: { code: values.code.trim(), name: values.name.trim(), attributeCodes, variantAttributeCodes: values.variantAttributeCodes, isShippable: values.isShippable, taxClassId: values.taxClassId || null },
          })
        ).productTypeCreate,
      );
    },
    { success: creating ? "Product type created" : "Product type saved", onSuccess: onSaved, onError: (error) => reportError(error, form, ["input"]) },
  );

  const submit = form.handleSubmit((values) => {
    if (creating && !CODE.test(values.code.trim())) return form.setError("code", { message: "Start with a letter; use lowercase letters, digits and underscores" });
    if (!values.name.trim()) return form.setError("name", { message: "Required" });
    save.mutate(values);
  });

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby={undefined} dirty={form.formState.isDirty}>
        <div>
          <h2 className="text-base font-semibold">{creating ? "Add product type" : `Edit ${type.name}`}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {type ? `Used by ${formatNumber(type.productCount ?? 0)} product${type.productCount === 1 ? "" : "s"}. ` : null}
            Need another attribute?{" "}
            <Link to="/attributes" className="text-primary hover:underline">
              Manage attributes
            </Link>
          </p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required error={form.formState.errors.name?.message}>
              <Input {...form.register("name")} placeholder="Apparel" />
            </Field>
            <Field label="Code" required hint={creating ? "Fixed once created" : undefined} error={form.formState.errors.code?.message}>
              <Input className="font-mono" {...form.register("code")} disabled={!creating} placeholder="apparel" />
            </Field>
          </div>
          <Field label="Variant options" hint={creating ? "Select attributes the variants differ by, e.g. colour and size. Fixed once created." : "Fixed once created, because variants are built from them."}>
            <Controller
              control={form.control}
              name="variantAttributeCodes"
              render={({ field }) => <MultiSelect options={selectOptions} value={field.value} onChange={field.onChange} placeholder="None: one variant per product" disabled={!creating} />}
            />
          </Field>
          <Field label="Attributes" hint="Product-level specifications, e.g. brand and material.">
            <Controller
              control={form.control}
              name="attributeCodes"
              render={({ field }) => <MultiSelect options={options.filter((o) => !variantCodes.includes(o.value))} value={field.value.filter((c) => !variantCodes.includes(c))} onChange={field.onChange} placeholder="No attributes" />}
            />
          </Field>
          <Field label="Tax class" hint="Applies to every product of this type that does not choose its own.">
            <NativeSelect {...form.register("taxClassId")}>
              <option value="">None</option>
              {taxClasses
                .filter((t) => t.kind === "PRODUCT")
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Controller
            control={form.control}
            name="isShippable"
            render={({ field }) => (
              <Label className="justify-between rounded-lg border p-3 font-normal">
                <span>
                  <span className="block font-medium">Shipped</span>
                  <span className="text-xs text-muted-foreground">Turn off for digital goods, gift cards and services: no shipping address or method is asked for.</span>
                </span>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </Label>
            )}
          />
          {!creating && (type.variantAttributes ?? []).length === 0 ? <Alert variant="info">Products of this type have a single variant.</Alert> : null}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {creating ? "Create product type" : "Save product type"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
};
