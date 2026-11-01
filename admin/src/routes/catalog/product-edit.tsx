import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, CopyPlus, Package, Save, Shapes, Trash2, Truck, Undo2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { LocalizedInput } from "@/components/inputs";
import { LocalizedRichText } from "@/components/rich-text";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { PluginWidgets } from "@/components/plugin-widgets";
import { SaveBar, useProblemFocus, useSaveShortcut } from "@/components/save-bar";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelect } from "@/components/ui/combobox";
import { Checkbox, Switch } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Label, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/overlay";
import type { FieldError } from "@/lib/api";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, languageName } from "@/lib/format";
import { copyText, useAction, useReference } from "@/lib/hooks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { cn, slugify } from "@/lib/utils";
import { AttributeInput, attributeInputs, initialAttributeValue, isEmptyAttribute, type AttributeFormValue } from "./attribute-inputs";
import {
  ProductCreate,
  ProductDelete,
  ProductDuplicate,
  ProductEditorQuery,
  ProductTypesFullQuery,
  ProductUpdate,
  type EditorAttribute,
  type EditorProduct,
  type FullProductType,
  type ProductCreateInput,
  type ProductUpdateInput,
} from "./product-data";
import { PageDesignCard } from "./page-design";
import { MediaEditor, type MediaRow } from "./product-media";
import { newVariantInputs, NewVariantsEditor, skuProblems, VariantsCard, type NewVariantRow } from "./product-variants";
import { CATALOG_KEYS, gid, PRODUCT_STATUSES, useCategoryOptions, type ProductStatus } from "./shared";

type ListingValue = { listed: boolean; isPublished: boolean; visibleInListings: boolean };

type FormValues = {
  status: ProductStatus;
  /** The product's own tax class; "" follows its product type's. */
  taxClassId: string;
  name: Record<string, string>;
  description: Record<string, string>;
  slug: Record<string, string>;
  metaTitle: Record<string, string>;
  metaDescription: Record<string, string>;
  attributes: Record<string, AttributeFormValue>;
  categoryIds: string[];
  listings: Record<string, ListingValue>;
  media: MediaRow[];
  /** New products only. */
  variants: NewVariantRow[];
  /** Saved translations to delete on save; they are hidden from the text fields meanwhile. */
  removedLocales: string[];
};

type ProductTypeShape = Pick<FullProductType, "id" | "code" | "name" | "isShippable" | "taxClass"> & { attributes?: EditorAttribute[] | null; variantAttributes?: EditorAttribute[] | null };

const pick = (product: EditorProduct, field: "name" | "slug" | "description" | "metaTitle" | "metaDescription") =>
  Object.fromEntries((product.translations ?? []).map((t) => [t.locale ?? "", t[field] ?? ""]));

const valuesOf = (product: EditorProduct, channelIds: readonly string[], defaultLocale: string): FormValues => {
  const stored = (product.attributeValues ?? {}) as Record<string, unknown>;
  return {
    status: (product.status ?? "DRAFT") as ProductStatus,
    taxClassId: product.taxClass?.id ?? "",
    name: pick(product, "name"),
    description: pick(product, "description"),
    slug: pick(product, "slug"),
    metaTitle: pick(product, "metaTitle"),
    metaDescription: pick(product, "metaDescription"),
    attributes: Object.fromEntries((product.productType?.attributes ?? []).flatMap((def) => (def.code ? [[def.code, initialAttributeValue(def, stored[def.code], defaultLocale)]] : []))),
    categoryIds: (product.categories ?? []).map((c) => c.id),
    listings: Object.fromEntries(
      channelIds.map((channelId) => {
        const listing = (product.channelListings ?? []).find((l) => l.channel?.id === channelId);
        return [channelId, { listed: !!listing, isPublished: listing?.isPublished ?? true, visibleInListings: listing?.visibleInListings ?? true }];
      }),
    ),
    media: [...(product.media ?? [])]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((m) => ({
        url: m.url ?? "",
        alt: Object.fromEntries((m.alts ?? []).map((a) => [a.locale ?? "", a.value ?? ""])),
        variantSku: m.variant?.sku ?? "",
        kind: (m.kind ?? "IMAGE") as MediaRow["kind"],
      })),
    variants: [],
    removedLocales: [],
  };
};

const blankValues = (type: ProductTypeShape, channelIds: readonly string[]): FormValues => ({
  status: "DRAFT",
  taxClassId: "",
  name: {},
  description: {},
  slug: {},
  metaTitle: {},
  metaDescription: {},
  attributes: Object.fromEntries((type.attributes ?? []).flatMap((def) => (def.code ? [[def.code, initialAttributeValue(def, undefined, "")]] : []))),
  categoryIds: [],
  listings: Object.fromEntries(channelIds.map((id) => [id, { listed: true, isPublished: true, visibleInListings: true }])),
  media: [],
  variants: [],
  removedLocales: [],
});

const translationsOf = (values: FormValues, locales: readonly string[]) =>
  locales
    .filter((locale) => !values.removedLocales.includes(locale) && values.name[locale]?.trim())
    .map((locale) => ({
      locale,
      name: values.name[locale]!.trim(),
      slug: values.slug[locale]?.trim() ? slugify(values.slug[locale]!) : null,
      description: values.description[locale]?.trim() ? values.description[locale]! : null,
      metaTitle: values.metaTitle[locale]?.trim() || null,
      metaDescription: values.metaDescription[locale]?.trim() || null,
    }));

const listingsOf = (values: FormValues) =>
  Object.entries(values.listings)
    .filter(([, l]) => l.listed)
    .map(([channelId, l]) => ({ channelId, isPublished: l.isPublished, visibleInListings: l.isPublished && l.visibleInListings }));

/** Saving media replaces it all, so alt text goes back in every locale it was loaded in. */
const mediaOf = (values: FormValues) =>
  values.media
    .filter((m) => m.url.trim())
    .map((m, position) => ({
      url: m.url.trim(),
      kind: m.kind,
      position,
      alt: Object.entries(m.alt).flatMap(([locale, value]) => (locale && value.trim() ? [{ locale, value: value.trim() }] : [])),
      ...(m.variantSku ? { variantSku: m.variantSku } : {}),
    }));

/** "input.translations.0.name" → "name (fr): …"; `sent` maps translation indexes to locales. */
const describe = (error: FieldError, sent: readonly string[]) => {
  const [, area, index, field] = error.path;
  const label = (() => {
    if (area === "translations") return `${field ?? "Name"} (${sent[Number(index)] ?? index})`;
    if (area === "removeTranslations") return "Languages";
    if (area === "variants") return `Variant ${Number(index) + 1}${field ? ` ${field}` : ""}`;
    if (area === "media") return `Media ${Number(index) + 1}${field ? ` ${field}` : ""}`;
    if (area === "attributes") return `Attribute ${index ?? ""}`;
    return error.path.slice(1).join(".") || "Product";
  })();
  return `${label}: ${error.message}`;
};

// ---------------------------------------------------------------- page

export const ProductEditPage = () => {
  const params = useParams({ strict: false }) as { id?: string };
  if (!params.id) return <NewProduct />;
  const id = gid("Product", params.id);
  return <EditProduct key={id} id={id} />;
};

const EditorSkeleton = () => (
  <Page>
    <Skeleton className="mb-6 h-8 w-72" />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Skeleton className="h-[32rem] w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  </Page>
);

const EditProduct = ({ id }: { id: string }) => {
  const reference = useReference();
  const query = useQuery({ queryKey: CATALOG_KEYS.product(id), queryFn: ({ signal }) => request(ProductEditorQuery, { id }, { signal }) });
  if (query.isLoading || reference.loading) return <EditorSkeleton />;
  const product = query.data?.product;
  if (!product) {
    return (
      <Page>
        <EmptyState
          icon={Package}
          title="Product not found"
          description={query.error instanceof Error ? query.error.message : "It may have been deleted."}
          action={
            <Button asChild variant="outline">
              <Link to="/products">Back to products</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return <ProductForm mode="edit" product={product} refetch={async () => (await query.refetch()).data?.product ?? null} />;
};

const NewProduct = () => {
  const reference = useReference();
  const types = useQuery({ queryKey: ["product-types-full"], queryFn: () => request(ProductTypesFullQuery), staleTime: 60_000 });
  const [typeId, setTypeId] = useState<string | null>(null);
  if (types.isLoading || reference.loading) return <EditorSkeleton />;
  const list = types.data?.productTypes ?? [];
  const type = list.find((t) => t.id === typeId);
  if (type) return <ProductForm key={type.id} mode="create" productType={type} onChangeType={() => setTypeId(null)} />;
  return (
    <Page>
      <PageHeader back={{ to: "/products", label: "Products" }} title="Add product" description="Start with a product type: it decides the attributes a product has and the options its variants differ by." />
      {list.length === 0 ? (
        <EmptyState
          icon={Shapes}
          title="No product types yet"
          description="Create a product type first, for example Apparel with a size and colour option."
          action={
            <Button asChild>
              <Link to="/product-types">Product types</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((t) => (
            <button key={t.id} type="button" onClick={() => setTypeId(t.id)} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold">{t.name}</span>
                <Badge variant={t.isShippable ? "secondary" : "info"}>{t.isShippable ? "Physical" : "Digital"}</Badge>
              </span>
              <span className="text-[13px] text-muted-foreground">
                {(t.variantAttributes ?? []).length ? `Variants by ${(t.variantAttributes ?? []).map((a) => a.label ?? a.code).join(", ")}` : "One variant"}
              </span>
              {(t.attributes ?? []).length ? <span className="text-xs text-muted-foreground">Attributes: {(t.attributes ?? []).map((a) => a.label ?? a.code).join(", ")}</span> : null}
            </button>
          ))}
        </div>
      )}
    </Page>
  );
};

/** The product's listings, read only: changing them needs the channel list. */
const ListingsSummary = ({ product }: { product: EditorProduct | null }) => (
  <div className="flex flex-col gap-2 text-[13px]">
    {product ? (
      <div className="flex flex-wrap gap-1">
        {(product.channelListings ?? []).length === 0 ? <span className="text-muted-foreground">Not listed in any channel.</span> : null}
        {(product.channelListings ?? []).map((l) => (
          <Badge key={l.channel?.id} variant={l.isPublished ? "success" : "outline"}>
            {l.channel?.name}
            {l.isPublished ? null : " · not published"}
          </Badge>
        ))}
      </div>
    ) : null}
    <p className="text-muted-foreground">
      {product ? "Changing channels needs the settings:read permission, so saving leaves the listings as they are." : "Listing products in channels needs the settings:read permission, so this one starts in none."}
    </p>
  </div>
);

type FormProps =
  | { mode: "edit"; product: EditorProduct; refetch: () => Promise<EditorProduct | null> }
  | { mode: "create"; productType: FullProductType; onChangeType: () => void };

const ProductForm = (props: FormProps) => {
  const { can } = useAuth();
  const write = can("catalog:write");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reference = useReference();
  const categories = useCategoryOptions();
  const product = props.mode === "edit" ? props.product : null;
  const type: ProductTypeShape | null = props.mode === "edit" ? (props.product.productType ?? null) : props.productType;
  const defaultLocale = reference.defaultLocale;
  const locales = useMemo(() => [...new Set([defaultLocale, ...reference.locales, ...(product?.translations ?? []).map((t) => t.locale ?? "")].filter(Boolean))], [defaultLocale, reference.locales, product?.translations]);
  const stored = useMemo(() => (product?.translations ?? []).flatMap((t) => (t.locale ? [t.locale] : [])), [product?.translations]);
  const mediaLocales = useMemo(() => [...new Set([...locales, ...(product?.media ?? []).flatMap((m) => (m.alts ?? []).map((a) => a.locale ?? ""))].filter(Boolean))], [locales, product?.media]);
  const channelIds = reference.channels.map((c) => c.id);
  const definitions = (type?.attributes ?? []).filter((d): d is typeof d & { code: string } => !!d.code);
  const axes = (type?.variantAttributes ?? []).filter((d): d is typeof d & { code: string } => !!d.code);
  const productTaxClasses = reference.taxClasses.filter((t) => t.kind === "PRODUCT");
  const taxClasses = [...productTaxClasses, ...(product?.taxClass && !productTaxClasses.some((t) => t.id === product.taxClass?.id) ? [product.taxClass] : [])];

  const form = useForm<FormValues>({ defaultValues: product ? valuesOf(product, channelIds, defaultLocale) : blankValues(type!, channelIds) });
  const removed = form.watch("removedLocales");
  const editLocales = useMemo(() => locales.filter((l) => !removed.includes(l)), [locales, removed]);
  // Locales in the order translations were last sent, to name the ones the API reports errors for.
  const sent = useRef<string[]>([]);
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = form.formState.isDirty;
  const unsaved = useUnsavedChanges(dirty);
  // Problems found on Save are marked on their fields; the page then goes to the first one.
  const [attempted, setAttempted] = useState(false);
  const problemsRoot = useRef<HTMLDivElement>(null);
  const goToFirstProblem = useProblemFocus(() => problemsRoot.current);

  const fail = (error: unknown) => {
    setServerErrors(error instanceof MutationError ? error.fieldErrors : []);
    reportError(error, form, ["input"]);
  };

  /** Mark every problem on its field, sum them up in one toast and go to the first. */
  const validate = (values: FormValues) => {
    const found: string[] = [];
    let total = 0;
    const problem = (label: string, count = 1) => {
      found.push(label);
      total += count;
    };
    if (!values.name[defaultLocale]?.trim()) {
      form.setError("name", { message: `Enter a name in ${languageName(defaultLocale)}` });
      problem("Name");
    }
    for (const def of definitions) {
      if (!def.isRequired || !isEmptyAttribute(values.attributes[def.code])) continue;
      form.setError(`attributes.${def.code}`, { message: "Required" });
      problem(def.label ?? def.code);
    }
    if (props.mode === "create") {
      setAttempted(true);
      const badSkus = Object.keys(skuProblems(values.variants)).length;
      if (!values.variants.length) {
        form.setError("variants", { message: axes.length ? "Choose option values to create at least one variant." : "Add the variant's SKU." });
        problem("Variants");
      } else if (badSkus) problem(badSkus === 1 ? "1 SKU" : `${badSkus} SKUs`, badSkus);
    }
    if (!total) return true;
    toast.error(`${total} thing${total === 1 ? "" : "s"} to fix`, { id: "product-problems", description: found.join(", ") });
    goToFirstProblem();
    return false;
  };

  const save = useAction(
    async (values: FormValues) => {
      const translations = translationsOf(values, locales);
      sent.current = translations.map((t) => t.locale);
      if (props.mode === "edit") {
        const removeTranslations = values.removedLocales.filter((locale) => stored.includes(locale));
        const input: ProductUpdateInput = {
          status: values.status,
          // Null removes the override, so the product type's class applies.
          taxClassId: values.taxClassId || null,
          translations,
          ...(removeTranslations.length ? { removeTranslations } : {}),
          attributes: attributeInputs(definitions, values.attributes, (props.product.attributeValues ?? {}) as Record<string, unknown>),
          categoryIds: values.categoryIds,
          // The form's listings come from the channel list. Without it they're left out, which keeps the saved ones.
          ...(reference.channelsLoaded ? { channelListings: listingsOf(values) } : {}),
          media: mediaOf(values),
        };
        return unwrap((await request(ProductUpdate, { id: props.product.id, input })).productUpdate);
      }
      const input: ProductCreateInput = {
        productTypeId: props.productType.id,
        status: values.status,
        // Left out, the product follows its type's tax class.
        ...(values.taxClassId ? { taxClassId: values.taxClassId } : {}),
        translations,
        attributes: attributeInputs(definitions, values.attributes),
        categoryIds: values.categoryIds,
        channelListings: listingsOf(values),
        media: mediaOf(values),
        variants: newVariantInputs(values.variants, axes.map((a) => a.code)),
      };
      return unwrap((await request(ProductCreate, { input })).productCreate);
    },
    {
      success: props.mode === "edit" ? "Product saved" : "Product created",
      invalidate: [CATALOG_KEYS.products, CATALOG_KEYS.categories, CATALOG_KEYS.inventory, CATALOG_KEYS.productTypes],
      onError: fail,
      onSuccess: async (payload) => {
        setServerErrors([]);
        if (props.mode === "create") {
          unsaved.release();
          if (payload.product?.id) void navigate({ to: "/products/$id", params: { id: payload.product.id }, replace: true });
          return;
        }
        const fresh = await props.refetch();
        if (fresh) form.reset(valuesOf(fresh, channelIds, defaultLocale));
      },
    },
  );

  const submit = () => void form.handleSubmit((values) => validate(values) && save.mutate(values))();
  useSaveShortcut(submit, write && !save.isPending);

  const duplicate = useAction(async () => unwrap((await request(ProductDuplicate, { id: product!.id })).productDuplicate), {
    success: (r) => `Created ${r.product?.name ?? "a copy"} as a draft`,
    invalidate: [CATALOG_KEYS.products, CATALOG_KEYS.productTypes],
    onSuccess: (r) => {
      if (r.product?.id) void navigate({ to: "/products/$id", params: { id: r.product.id } });
    },
  });

  const remove = useAction(async () => unwrap((await request(ProductDelete, { id: product!.id })).productDelete), {
    success: "Product deleted",
    invalidate: [CATALOG_KEYS.products, CATALOG_KEYS.categories, CATALOG_KEYS.inventory, CATALOG_KEYS.productTypes],
    onSuccess: () => {
      unsaved.release();
      queryClient.removeQueries({ queryKey: CATALOG_KEYS.product(product!.id) });
      void navigate({ to: "/products" });
    },
  });

  const status = form.watch("status");
  const name = form.watch("name");
  const title = props.mode === "edit" ? name[defaultLocale] || props.product.name || "Untitled product" : name[defaultLocale] || "New product";
  const newVariants = form.watch("variants");
  const skus = product ? (product.variants ?? []).flatMap((v) => (v.sku ? [v.sku] : [])) : newVariants.map((v) => v.sku).filter(Boolean);
  // After a Save attempt, new variants' SKU problems show on their rows until fixed.
  const skuErrors = useMemo(() => (attempted ? skuProblems(newVariants) : {}), [attempted, newVariants]);
  const attributeErrors = form.formState.errors.attributes as Record<string, { message?: string }> | undefined;
  const variantsError = (form.formState.errors.variants as { message?: string } | undefined)?.message;

  return (
    <Page>
      <PageHeader
        back={{ to: "/products", label: "Products" }}
        title={title}
        badges={
          <>
            <StatusBadge value={status} />
            {type ? <Badge variant="outline">{type.name}</Badge> : null}
          </>
        }
        description={product ? `Updated ${formatDateTime(product.updatedAt)}` : `New ${type?.name ?? ""} product. It is saved together with its variants, prices and stock.`}
        actions={
          write ? (
            <>
              {product ? (
                <>
                  <Button variant="outline" loading={duplicate.isPending} onClick={() => duplicate.mutate(undefined)}>
                    <CopyPlus />
                    Duplicate
                  </Button>
                  <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Delete
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={props.mode === "create" ? props.onChangeType : undefined}>
                  <Shapes />
                  Change type
                </Button>
              )}
              <Button loading={save.isPending} disabled={product ? !dirty : false} onClick={submit}>
                <Save />
                {product ? "Save" : "Create product"}
              </Button>
            </>
          ) : null
        }
      />

      {serverErrors.length ? (
        <Alert variant="destructive" title="The product was not saved" className="mb-6">
          <ul className="list-disc pl-4">
            {serverErrors.map((e, i) => (
              <li key={i}>{describe(e, sent.current)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div ref={problemsRoot} className="contents">
        <TwoColumn
          main={
            <>
              <Card>
                <CardHeader>
                  <CardTitle>General</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <Field label="Name" required error={(form.formState.errors.name as { message?: string } | undefined)?.message}>
                    <Controller control={form.control} name="name" render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={editLocales} invalid={!!form.formState.errors.name} />} />
                  </Field>
                  <Field label="Description" hint="Shown on the product page. Type ## for a heading or - for a list, or paste Markdown.">
                    <Controller control={form.control} name="description" render={({ field }) => <LocalizedRichText value={field.value} onChange={field.onChange} locales={editLocales} format="html" rows={7} placeholder="What it is, what it is made of, how it fits…" />} />
                  </Field>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Media</CardTitle>
                    <CardDescription>The first image is the main image. Assign media to a SKU to show it for that variant.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <Controller control={form.control} name="media" render={({ field }) => <MediaEditor value={field.value} onChange={field.onChange} skus={skus} locales={mediaLocales} disabled={!write} />} />
                </CardContent>
              </Card>

              {product ? (
                <VariantsCard
                  product={product}
                  refresh={async () => {
                    await queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.product(product.id) });
                    await queryClient.invalidateQueries({ queryKey: CATALOG_KEYS.inventory });
                  }}
                />
              ) : (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Variants</CardTitle>
                      <CardDescription>
                        {axes.length ? `Pick the ${axes.map((a) => (a.label ?? a.code).toLowerCase()).join(" and ")} values to sell; each combination becomes a variant.` : "This product type has no options, so the product has one variant."} Prices are per channel and currency; leave a price empty to skip that currency.
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div data-invalid={variantsError ? "true" : undefined} className="flex flex-col gap-3">
                      {variantsError ? <p className="text-[13px] text-destructive">{variantsError}</p> : null}
                      <Controller control={form.control} name="variants" render={({ field }) => <NewVariantsEditor axes={axes} rows={field.value} onChange={field.onChange} nameHint={name[defaultLocale] ?? ""} skuErrors={skuErrors} />} />
                    </div>
                  </CardContent>
                </Card>
              )}

              {definitions.length ? (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Attributes</CardTitle>
                      <CardDescription>Specifications from the {type?.name} product type, used for filters and comparison.</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-2">
                    {definitions.map((def) => {
                      const error = attributeErrors?.[def.code]?.message;
                      // Lets Save find the problem, and outlines pickers that can't show it themselves.
                      return (
                        <div
                          key={def.code}
                          data-invalid={error ? "true" : undefined}
                          className={cn(def.isLocalized || def.type === "RICH_TEXT" || def.type === "MULTISELECT" ? "sm:col-span-2" : undefined, error && "[&_[aria-haspopup=dialog]]:border-destructive")}
                        >
                          <Field label={def.label ?? def.code} required={!!def.isRequired} error={error}>
                            <Controller control={form.control} name={`attributes.${def.code}`} render={({ field }) => <AttributeInput def={def} value={field.value} onChange={field.onChange} locales={locales} invalid={!!error} />} />
                          </Field>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              ) : null}

              <SeoCard form={form} locales={editLocales} defaultLocale={defaultLocale} />
            </>
          }
          side={
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Status</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <Field label="Status" hint={status === "ACTIVE" ? "Sold in the channels it is published in." : status === "DRAFT" ? "Hidden from customers until active." : "Hidden from customers and kept for history."}>
                    <NativeSelect {...form.register("status")} disabled={!write}>
                      {PRODUCT_STATUSES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Tax class" hint="Choose a class only when this product is taxed differently from the rest of its type.">
                    <NativeSelect {...form.register("taxClassId")} disabled={!write}>
                      <option value="">Product type default ({type?.taxClass?.name ?? "none"})</option>
                      {taxClasses.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-muted-foreground">Product type</span>
                    <Link to="/product-types" className="font-medium hover:underline">
                      {type?.name}
                    </Link>
                  </div>
                  {type && !type.isShippable ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Truck className="size-3.5" /> Not shipped (digital or service)
                    </p>
                  ) : null}
                </CardContent>
              </Card>

              {product ? <LanguagesCard form={form} stored={stored} defaultLocale={defaultLocale} write={write} /> : null}

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Channels</CardTitle>
                    <CardDescription>Where the product is sold. Customers only see active products.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {reference.channelsLoaded ? null : <ListingsSummary product={product} />}
                  <Controller
                    control={form.control}
                    name="listings"
                    render={({ field }) => (
                      <div className="flex flex-col divide-y">
                        {reference.channels.map((channel) => {
                          const listing = field.value[channel.id] ?? { listed: false, isPublished: true, visibleInListings: true };
                          const set = (patch: Partial<ListingValue>) => field.onChange({ ...field.value, [channel.id]: { ...listing, ...patch } });
                          return (
                            <div key={channel.id} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
                              <Label className="font-medium">
                                <Checkbox checked={listing.listed} disabled={!write} onCheckedChange={(v) => set({ listed: v === true })} />
                                {channel.name}
                                {!channel.isActive ? <Badge variant="outline">inactive</Badge> : null}
                              </Label>
                              {listing.listed ? (
                                <div className="ml-6 flex flex-col gap-2 text-[13px]">
                                  <Label className="justify-between font-normal">
                                    Published
                                    <Switch checked={listing.isPublished} disabled={!write} onCheckedChange={(v) => set({ isPublished: v })} />
                                  </Label>
                                  <Label className="justify-between font-normal">
                                    In category pages and search
                                    <Switch checked={listing.isPublished && listing.visibleInListings} disabled={!write || !listing.isPublished} onCheckedChange={(v) => set({ visibleInListings: v })} />
                                  </Label>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Categories</CardTitle>
                </CardHeader>
                <CardContent>
                  <Controller
                    control={form.control}
                    name="categoryIds"
                    render={({ field }) => <MultiSelect options={categories.options} value={field.value} onChange={field.onChange} placeholder="No categories" searchPlaceholder="Search categories…" disabled={!write} />}
                  />
                </CardContent>
              </Card>

              {product ? <PageDesignCard kind="PRODUCT" id={product.id} name={product.name ?? title} /> : null}

              {product ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl>
                      <Detail label="Created">{formatDateTime(product.createdAt)}</Detail>
                      <Detail label="Updated">{formatDateTime(product.updatedAt)}</Detail>
                      <Detail label="ID">
                        <button type="button" className="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground" onClick={() => void copyText(product.id, "Product ID copied")}>
                          <span className="truncate">{product.id}</span>
                          <Copy className="size-3 shrink-0" />
                        </button>
                      </Detail>
                    </dl>
                  </CardContent>
                </Card>
              ) : null}
              {product ? <PluginWidgets zone="product.detail" id={product.id} /> : null}
            </>
          }
        />
      </div>

      {write && (dirty || props.mode === "create") ? (
        <SaveBar
          status={dirty ? "Unsaved changes" : "Not saved yet"}
          saving={save.isPending}
          onSave={submit}
          onDiscard={product && dirty ? () => form.reset() : undefined}
          saveLabel={product ? "Save" : "Create product"}
        />
      ) : null}

      {product ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${title}?`}
          description="Its variants, prices, stock levels and media go too. Past orders keep their own copy. This cannot be undone."
          destructive
          confirmLabel="Delete product"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(undefined)}
        />
      ) : null}
      {unsaved.dialog}
    </Page>
  );
};

/** The default language can't be removed (shoppers fall back to it), nor can the last one. */
const LanguagesCard = ({ form, stored, defaultLocale, write }: { form: UseFormReturn<FormValues>; stored: readonly string[]; defaultLocale: string; write: boolean }) => {
  const [removed, name] = form.watch(["removedLocales", "name"]);
  const added = Object.keys(name).filter((locale) => !stored.includes(locale) && name[locale]?.trim());
  const remaining = stored.filter((locale) => !removed.includes(locale)).length + added.length;
  const setRemoved = (next: string[]) => form.setValue("removedLocales", next, { shouldDirty: true });
  const listed = [...stored, ...added].sort((a, b) => Number(b === defaultLocale) - Number(a === defaultLocale));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Languages</CardTitle>
          <CardDescription>Where a translation is missing, shoppers see {languageName(defaultLocale)}.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {listed.map((locale) => {
            const isRemoved = removed.includes(locale);
            return (
              <li key={locale} className="flex min-h-9 items-center gap-2 py-1.5 text-[13px] first:pt-0 last:pb-0">
                <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{locale}</span>
                <span className={cn("min-w-0 flex-1 truncate", isRemoved && "text-muted-foreground line-through")}>{languageName(locale)}</span>
                {locale === defaultLocale ? <Badge variant="secondary">Default</Badge> : null}
                {stored.includes(locale) ? null : <Badge variant="info">New</Badge>}
                {isRemoved ? (
                  <Button variant="ghost" size="sm" onClick={() => setRemoved(removed.filter((l) => l !== locale))}>
                    <Undo2 />
                    Undo
                  </Button>
                ) : write && stored.includes(locale) && locale !== defaultLocale && remaining > 1 ? (
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setRemoved([...removed, locale])} aria-label={`Remove the ${languageName(locale)} translation`}>
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {removed.length ? <p className="mt-3 text-xs text-muted-foreground">Saving deletes the name, description, URL slug and meta tags in the crossed-out languages.</p> : null}
      </CardContent>
    </Card>
  );
};

const stripTags = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** URL slug and meta tags per locale, with a search-result preview. */
const SeoCard = ({ form, locales, defaultLocale }: { form: UseFormReturn<FormValues>; locales: readonly string[]; defaultLocale: string }) => {
  const [name, slug, metaTitle, metaDescription, description] = form.watch(["name", "slug", "metaTitle", "metaDescription", "description"]);
  const previewTitle = metaTitle[defaultLocale]?.trim() || name[defaultLocale]?.trim() || "Product name";
  const previewDescription = metaDescription[defaultLocale]?.trim() || stripTags(description[defaultLocale] ?? "").slice(0, 160) || "Add a meta description to control the search snippet.";
  const previewSlug = slug[defaultLocale]?.trim() ? slugify(slug[defaultLocale]!) : slugify(name[defaultLocale] ?? "") || "product";
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Search engine listing</CardTitle>
          <CardDescription>Changing a URL slug adds a redirect from the old address.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="truncate text-xs text-muted-foreground">…/{previewSlug}</p>
          <p className={cn("truncate text-[15px] text-info")}>{previewTitle}</p>
          <p className="line-clamp-2 text-[13px] text-muted-foreground">{previewDescription}</p>
        </div>
        <Field label="URL slug" hint="Lowercase words separated by hyphens. Leave empty to generate it from the name.">
          <Controller control={form.control} name="slug" render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={locales} />} />
        </Field>
        <Field label="Meta title">
          <Controller control={form.control} name="metaTitle" render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={locales} />} />
        </Field>
        <Field label="Meta description">
          <Controller control={form.control} name="metaDescription" render={({ field }) => <LocalizedInput value={field.value} onChange={field.onChange} locales={locales} multiline rows={3} />} />
        </Field>
      </CardContent>
    </Card>
  );
};

