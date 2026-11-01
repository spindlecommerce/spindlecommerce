import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Minus, PackagePlus, Plus, RotateCcw, ShoppingBag, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/form";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Checkbox } from "@/components/ui/controls";
import { Alert, EmptyState, Separator } from "@/components/ui/feedback";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type VariablesOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useAction, useDebounced, useListSearch, useReference } from "@/lib/hooks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { cn, humanize } from "@/lib/utils";
import { AddressFields } from "./detail";

const CustomerSearch = graphql(`
  query DraftCustomerSearch($q: String) {
    customers(query: $q, first: 10) {
      edges {
        node {
          id
          email
          firstName
          lastName
        }
      }
    }
  }
`);

const CustomerQuery = graphql(`
  query DraftCustomer($id: ID!) {
    node(id: $id) {
      ... on Customer {
        id
        email
        firstName
        lastName
        group {
          name
        }
        addresses {
          id
          isDefaultShipping
          isDefaultBilling
          address {
            firstName
            lastName
            company
            line1
            line2
            city
            region
            regionCode
            postalCode
            countryCode
            phone
          }
        }
      }
    }
  }
`);

const VariantSearch = graphql(`
  query DraftVariantSearch($q: String) {
    productVariants(query: $q, first: 12) {
      edges {
        node {
          id
          sku
          name
          isActive
          quantityAvailable
          product {
            status
          }
        }
      }
    }
  }
`);

const QuoteQuery = graphql(`
  query DraftQuote($input: OrderDraftInput!) {
    orderDraftQuote(input: $input) {
      currencyCode
      requiresShipping
      missing
      selectedShippingMethodCode
      lines {
        sku
        name
        quantity
        salableQuantity
        unitPrice {
          amount
          currencyCode
        }
        total {
          amount
          currencyCode
        }
        discount {
          amount
          currencyCode
        }
        issue {
          code
          message
        }
        variant {
          id
        }
      }
      subtotal {
        amount
        currencyCode
      }
      discountTotal {
        amount
        currencyCode
      }
      shipping {
        amount
        currencyCode
      }
      tax {
        amount
        currencyCode
      }
      total {
        amount
        currencyCode
      }
      discounts {
        name
        couponCode
        amount {
          amount
          currencyCode
        }
      }
      shippingRates {
        code
        name
        minDeliveryDays
        maxDeliveryDays
        price {
          amount
          currencyCode
        }
      }
      paymentMethods {
        code
        name
        instructions
      }
      coupons {
        code
        applied
        reason
      }
    }
  }
`);

const CreateOrder = graphql(
  `
    mutation CreateOrder($input: OrderDraftInput!) {
      orderCreate(input: $input) {
        __typename
        ... on OrderPayload {
          order {
            number
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type DraftInput = VariablesOf<typeof QuoteQuery>["input"];
type AddressForm = { firstName: string; lastName: string; company: string; line1: string; line2: string; city: string; region: string; regionCode: string; postalCode: string; countryCode: string; phone: string };
type DraftLine = { variantId: string; label: string; quantity: number };

const EMPTY_ADDRESS: AddressForm = { firstName: "", lastName: "", company: "", line1: "", line2: "", city: "", region: "", regionCode: "", postalCode: "", countryCode: "", phone: "" };
const REQUIRED: (keyof AddressForm)[] = ["firstName", "lastName", "line1", "city", "postalCode", "countryCode"];

/** The address if every required field is filled, without empty optional fields. */
const completeAddress = (a: AddressForm | undefined) => {
  if (!a || REQUIRED.some((k) => !a[k]?.trim())) return null;
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v?.trim()).map(([k, v]) => [k, k === "countryCode" ? v.trim().toUpperCase() : v.trim()])) as DraftInput["shippingAddress"];
};

const MISSING: Record<string, string> = {
  LINES: "Add at least one item",
  LINE_ISSUES: "Fix the items marked as unavailable or short on stock",
  EMAIL: "Choose a customer or enter an email",
  SHIPPING_ADDRESS: "Enter a shipping address",
  SHIPPING_METHOD: "Choose a shipping method",
  BILLING_ADDRESS: "Enter a billing address",
  PAYMENT_METHOD: "Choose a payment method",
};

// ---------------------------------------------------------------- draft kept for a reload

type Draft = {
  channelId: string;
  currency: string;
  customerId: string;
  email: string;
  lines: DraftLine[];
  shipping: AddressForm;
  billing: AddressForm;
  sameAsShipping: boolean;
  shippingMethodCode: string;
  paymentMethodCode: string;
  couponCodes: string[];
  note: string;
};

const DRAFT_KEY = "ecom-admin:order-draft";

const readDraft = (): Draft | null => {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as Draft | null;
    return draft && typeof draft === "object" && Array.isArray(draft.lines) ? draft : null;
  } catch {
    return null;
  }
};

const writeDraft = (draft: Draft | null) => {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage full or blocked: the draft isn't kept.
  }
};

export const CreateOrderPage = () => {
  // "Start over" forgets the draft and remounts the form empty.
  const [session, setSession] = useState(0);
  return (
    <CreateOrderForm
      key={session}
      onStartOver={() => {
        writeDraft(null);
        setSession((n) => n + 1);
      }}
    />
  );
};

const CreateOrderForm = ({ onStartOver }: { onStartOver: () => void }) => {
  const navigate = useNavigate();
  const [search] = useListSearch();
  const { channels, defaultChannelId } = useReference();
  // Opened from a customer's page: that customer is preselected, which is not an edit by itself.
  const urlCustomer = search.q?.startsWith("gid://ecom/Customer/") ? search.q : "";
  const [restored] = useState(() => {
    const draft = readDraft();
    return draft && (!urlCustomer || draft.customerId === urlCustomer) ? draft : null;
  });
  const [channelId, setChannelId] = useState(restored?.channelId ?? "");
  const [currency, setCurrency] = useState(restored?.currency ?? "");
  const [customerId, setCustomerId] = useState(restored?.customerId ?? urlCustomer);
  const [email, setEmail] = useState(restored?.email ?? "");
  const [lines, setLines] = useState<DraftLine[]>(restored?.lines ?? []);
  const [sameAsShipping, setSameAsShipping] = useState(restored?.sameAsShipping ?? true);
  const [shippingMethodCode, setShippingMethodCode] = useState(restored?.shippingMethodCode ?? "");
  const [paymentMethodCode, setPaymentMethodCode] = useState(restored?.paymentMethodCode ?? "");
  const [couponInput, setCouponInput] = useState("");
  const [couponCodes, setCouponCodes] = useState<string[]>(restored?.couponCodes ?? []);
  const [note, setNote] = useState(restored?.note ?? "");
  const [customerQuery, setCustomerQuery] = useState("");
  const [variantQuery, setVariantQuery] = useState("");

  const shippingForm = useForm<AddressForm>({ defaultValues: EMPTY_ADDRESS });
  const billingForm = useForm<AddressForm>({ defaultValues: EMPTY_ADDRESS });
  const shippingValues = useWatch({ control: shippingForm.control });
  const billingValues = useWatch({ control: billingForm.control });

  // A restored draft's addresses count as typed (dirty), unlike a customer's saved addresses.
  const [hydrated, setHydrated] = useState(!restored);
  useEffect(() => {
    if (!restored) return;
    shippingForm.reset({ ...EMPTY_ADDRESS, ...restored.shipping }, { keepDefaultValues: true });
    billingForm.reset({ ...EMPTY_ADDRESS, ...restored.billing }, { keepDefaultValues: true });
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Once anything is entered, guard it on leaving and keep it for a reload until placed or discarded.
  const dirty =
    lines.length > 0 ||
    email.trim() !== "" ||
    (customerId !== "" && customerId !== urlCustomer) ||
    shippingForm.formState.isDirty ||
    billingForm.formState.isDirty ||
    couponCodes.length > 0 ||
    note.trim() !== "";
  const finished = useRef(false);
  const unsaved = useUnsavedChanges(dirty, {
    description: "The customer, items and addresses entered for this order will be lost.",
    onDiscard: () => {
      finished.current = true;
      writeDraft(null);
    },
  });
  useEffect(() => {
    if (!hydrated || finished.current) return;
    writeDraft(
      dirty
        ? { channelId, currency, customerId, email, lines, shipping: shippingValues as AddressForm, billing: billingValues as AddressForm, sameAsShipping, shippingMethodCode, paymentMethodCode, couponCodes, note }
        : null,
    );
  }, [hydrated, dirty, channelId, currency, customerId, email, lines, shippingValues, billingValues, sameAsShipping, shippingMethodCode, paymentMethodCode, couponCodes, note]);

  useEffect(() => {
    if (!channelId && defaultChannelId) setChannelId(defaultChannelId);
  }, [defaultChannelId, channelId]);
  const channel = channels.find((c) => c.id === channelId);
  // Listed first in the country pickers: where the channel ships.
  const channelCountries = channel?.countries?.flatMap((c) => (c.code ? [c.code] : []));
  const shipCountry = (shippingValues as AddressForm).countryCode?.trim().toUpperCase();
  const shipsThere = !shipCountry || !channel || (channel.countries ?? []).some((c) => c.code === shipCountry);

  const customerSearch = useQuery({ queryKey: ["draft-customers", useDebounced(customerQuery)], queryFn: () => request(CustomerSearch, { q: customerQuery || null }) });
  const customer = useQuery({ queryKey: ["draft-customer", customerId], queryFn: () => request(CustomerQuery, { id: customerId }), enabled: !!customerId });
  const customerNode = customer.data?.node && "email" in customer.data.node ? customer.data.node : null;
  const variants = useQuery({ queryKey: ["draft-variants", useDebounced(variantQuery)], queryFn: () => request(VariantSearch, { q: variantQuery || null }) });

  // Pre-fill addresses from the customer's defaults, except over a restored draft's own addresses.
  const prefilledFor = useRef(restored?.customerId ?? "");
  useEffect(() => {
    if (!customerNode || prefilledFor.current === customerNode.id) return;
    prefilledFor.current = customerNode.id;
    const pick = (flag: "isDefaultShipping" | "isDefaultBilling") => customerNode.addresses?.find((a) => a[flag])?.address ?? customerNode.addresses?.[0]?.address;
    const toForm = (a: ReturnType<typeof pick>) => ({ ...EMPTY_ADDRESS, ...Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, v ?? ""])) }) as AddressForm;
    if (pick("isDefaultShipping")) shippingForm.reset(toForm(pick("isDefaultShipping")));
    if (pick("isDefaultBilling")) billingForm.reset(toForm(pick("isDefaultBilling")));
  }, [customerNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const input: DraftInput | null = useMemo(() => {
    if (!channelId) return null;
    // The API rejects addresses the channel does not ship to; leave it out and say why on the form.
    const shippingAddress = shipsThere ? completeAddress(shippingValues as AddressForm) : null;
    return {
      channelId,
      currency: currency || null,
      customerId: customerId || null,
      email: customerId ? null : email.trim() || null,
      lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      shippingAddress,
      billingSameAsShipping: sameAsShipping,
      billingAddress: sameAsShipping ? null : completeAddress(billingValues as AddressForm),
      shippingMethodCode: shippingMethodCode || null,
      paymentMethodCode: paymentMethodCode || null,
      couponCodes,
      note: note.trim() || null,
    };
  }, [channelId, currency, customerId, email, lines, shippingValues, billingValues, sameAsShipping, shippingMethodCode, paymentMethodCode, couponCodes, note, shipsThere]);
  const debouncedInput = useDebounced(input, 300);
  const quote = useQuery({
    queryKey: ["draft-quote", debouncedInput],
    queryFn: () => request(QuoteQuery, { input: { ...debouncedInput!, note: null } }),
    enabled: !!debouncedInput,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const q = quote.data?.orderDraftQuote;

  // Keep the chosen methods valid as the quote changes.
  useEffect(() => {
    if (!q) return;
    if (shippingMethodCode && !q.shippingRates?.some((r) => r.code === shippingMethodCode)) setShippingMethodCode("");
    if (!shippingMethodCode && q.shippingRates?.length === 1) setShippingMethodCode(q.shippingRates[0]!.code!);
    if (paymentMethodCode && !q.paymentMethods?.some((m) => m.code === paymentMethodCode)) setPaymentMethodCode("");
  }, [q, shippingMethodCode, paymentMethodCode]);

  const create = useAction(() => request(CreateOrder, { input: input! }).then((r) => unwrap(r.orderCreate)), {
    invalidate: [["orders"], ["dashboard"]],
    onSuccess: (result) => {
      toast.success(`Order ${result.order?.number} created`);
      finished.current = true;
      writeDraft(null);
      unsaved.release();
      void navigate({ to: "/orders/$number", params: { number: result.order!.number! } });
    },
    onError: (error) => toast.error(error instanceof MutationError ? error.message : "The order could not be created", { description: error instanceof MutationError && error.details.missing ? `Missing: ${(error.details.missing as string[]).map(humanize).join(", ")}` : undefined }),
  });

  const addVariant = (id: string) => {
    const node = variants.data?.productVariants?.edges?.find((e) => e?.node?.id === id)?.node;
    if (!node) return;
    setLines((current) => (current.some((l) => l.variantId === id) ? current.map((l) => (l.variantId === id ? { ...l, quantity: l.quantity + 1 } : l)) : [...current, { variantId: id, label: `${node.name} (${node.sku})`, quantity: 1 }]));
    setVariantQuery("");
  };
  const quoteLine = (variantId: string) => q?.lines?.find((l) => l.variant?.id === variantId);
  const ready = !!q && (q.missing?.length ?? 1) === 0 && !quote.isFetching;

  return (
    <Page>
      <PageHeader back={{ to: "/orders", label: "Orders" }} title="Create order" description="Place an order for a customer or guest. Prices, promotions, tax and stock come from the same checkout the storefront uses." />
      {restored ? (
        <Alert
          variant="info"
          className="mb-6"
          title="Draft restored"
          action={
            <Button variant="outline" size="sm" onClick={onStartOver}>
              <RotateCcw />
              Start over
            </Button>
          }
        >
          The order you were entering in this tab is back as you left it.
        </Alert>
      ) : null}
      <TwoColumn
        main={
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserRound className="size-4 text-muted-foreground" /> Customer
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Channel">
                  <Select value={channelId} onValueChange={(v) => { setChannelId(v); setCurrency(""); }} options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} />
                </Field>
                <Field label="Currency">
                  <Select value={currency} onValueChange={setCurrency} allowEmpty emptyLabel={`Default (${channel?.defaultCurrency ?? ""})`} placeholder={`Default (${channel?.defaultCurrency ?? ""})`} options={(channel?.currencies ?? []).map((c) => ({ value: c, label: c }))} />
                </Field>
                <Field label="Existing customer" className="sm:col-span-2">
                  <div onInput={(e) => setCustomerQuery((e.target as HTMLInputElement).value ?? "")}>
                    <Combobox
                      clearable
                      value={customerId}
                      onChange={setCustomerId}
                      placeholder="Search by name or email…"
                      options={[
                        ...(customerNode ? [{ value: customerNode.id, label: `${customerNode.firstName} ${customerNode.lastName}`, hint: customerNode.email ?? "" }] : []),
                        ...(customerSearch.data?.customers?.edges ?? []).flatMap((e) => (e?.node && e.node.id !== customerNode?.id ? [{ value: e.node.id, label: `${e.node.firstName} ${e.node.lastName}`, hint: e.node.email ?? "" }] : [])),
                      ]}
                    />
                  </div>
                </Field>
                {customerId ? (
                  <p className="text-[13px] text-muted-foreground sm:col-span-2">
                    Order confirmation goes to {customerNode?.email}
                    {customerNode?.group ? ` · ${customerNode.group.name} pricing` : ""}.
                  </p>
                ) : (
                  <Field label="Guest email" className="sm:col-span-2" hint="For a guest order, without an account.">
                    <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
                  </Field>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShoppingBag className="size-4 text-muted-foreground" /> Items
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                <div onInput={(e) => setVariantQuery((e.target as HTMLInputElement).value ?? "")}>
                  <Combobox
                    value=""
                    onChange={addVariant}
                    placeholder="Add a product by name or SKU…"
                    options={(variants.data?.productVariants?.edges ?? []).flatMap((e) =>
                      e?.node ? [{ value: e.node.id, label: e.node.name ?? e.node.sku ?? "", hint: `${e.node.sku}${e.node.quantityAvailable !== null ? ` · ${e.node.quantityAvailable} available` : ""}${e.node.product?.status !== "ACTIVE" ? " · not active" : ""}` }] : [],
                    )}
                  />
                </div>
              </CardContent>
              {lines.length ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Item</TableHead>
                      <TableHead className="w-36 text-center">Quantity</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => {
                      const ql = quoteLine(line.variantId);
                      return (
                        <TableRow key={line.variantId} className="hover:bg-transparent">
                          <TableCell>
                            <span className="font-medium">{ql?.name ?? line.label}</span>
                            <p className="text-xs text-muted-foreground">
                              {ql?.sku}
                              {ql ? ` · ${ql.salableQuantity} available` : ""}
                            </p>
                            {ql?.issue ? (
                              <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                                <AlertTriangle className="size-3" />
                                {ql.issue.message}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-center gap-1">
                              <Button variant="outline" size="icon-sm" aria-label="Decrease" onClick={() => setLines(lines.map((l) => (l.variantId === line.variantId ? { ...l, quantity: Math.max(1, l.quantity - 1) } : l)))}>
                                <Minus />
                              </Button>
                              <Input type="number" min={1} value={line.quantity} className="h-8 w-14 text-center" onChange={(e) => setLines(lines.map((l) => (l.variantId === line.variantId ? { ...l, quantity: Math.max(1, Number(e.target.value) || 1) } : l)))} />
                              <Button variant="outline" size="icon-sm" aria-label="Increase" onClick={() => setLines(lines.map((l) => (l.variantId === line.variantId ? { ...l, quantity: l.quantity + 1 } : l)))}>
                                <Plus />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="tabular text-right">{formatMoney(ql?.unitPrice)}</TableCell>
                          <TableCell className="tabular text-right">
                            {formatMoney(ql?.total)}
                            {Number(ql?.discount?.amount) > 0 ? <p className="text-xs text-success">−{formatMoney(ql?.discount)}</p> : null}
                          </TableCell>
                          <TableCell>
                            <Button variant="ghost" size="icon-sm" aria-label="Remove item" onClick={() => setLines(lines.filter((l) => l.variantId !== line.variantId))}>
                              <Trash2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState icon={PackagePlus} title="No items yet" description="Search for a product above." className="py-8" />
              )}
            </Card>

            {q?.requiresShipping !== false ? (
              <Card>
                <CardHeader>
                  <CardTitle>Shipping address</CardTitle>
                  {customerNode?.addresses?.length ? (
                    <Select
                      value=""
                      onValueChange={(id) => {
                        const a = customerNode.addresses?.find((x) => x.id === id)?.address;
                        if (a) shippingForm.reset({ ...EMPTY_ADDRESS, ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v ?? ""])) } as AddressForm);
                      }}
                      placeholder="Use a saved address"
                      className="w-56"
                      options={customerNode.addresses.map((x) => ({ value: x.id, label: `${x.address?.line1}, ${x.address?.city}` }))}
                    />
                  ) : null}
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {!shipsThere ? (
                    <Alert variant="warning">
                      {channel?.name} does not ship to {shipCountry}. Ships to: {(channel?.countries ?? []).map((c) => c.code).join(", ")}.
                    </Alert>
                  ) : null}
                  <AddressFields form={shippingForm} countries={channelCountries} />
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Billing address</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {q?.requiresShipping !== false ? (
                  <Label className="font-normal">
                    <Checkbox checked={sameAsShipping} onCheckedChange={(v) => setSameAsShipping(v === true)} />
                    Same as shipping address
                  </Label>
                ) : null}
                {!sameAsShipping || q?.requiresShipping === false ? <AddressFields form={billingForm} countries={channelCountries} /> : null}
              </CardContent>
            </Card>

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Shipping method</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2" role="radiogroup" aria-label="Shipping method">
                  {q?.requiresShipping === false ? (
                    <p className="text-[13px] text-muted-foreground">Nothing to ship.</p>
                  ) : q?.shippingRates?.length ? (
                    q.shippingRates.map((rate) => (
                      <Choice key={rate.code} selected={shippingMethodCode === rate.code} onSelect={() => setShippingMethodCode(rate.code!)} title={rate.name ?? rate.code ?? ""} detail={rate.minDeliveryDays !== null ? `${rate.minDeliveryDays}–${rate.maxDeliveryDays} days` : undefined} aside={formatMoney(rate.price)} />
                    ))
                  ) : (
                    <p className="text-[13px] text-muted-foreground">Enter a shipping address to see rates.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Payment method</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2" role="radiogroup" aria-label="Payment method">
                  {q?.paymentMethods?.length ? (
                    q.paymentMethods.map((m) => <Choice key={m.code} selected={paymentMethodCode === m.code} onSelect={() => setPaymentMethodCode(m.code!)} title={m.name ?? m.code ?? ""} detail={m.instructions ?? undefined} />)
                  ) : (
                    <p className="text-[13px] text-muted-foreground">Enter a billing country to see methods.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Coupons and note</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const code = couponInput.trim().toUpperCase();
                    if (code && !couponCodes.includes(code)) setCouponCodes([...couponCodes, code]);
                    setCouponInput("");
                  }}
                >
                  <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value)} placeholder="Coupon code" className="max-w-xs uppercase" />
                  <Button type="submit" variant="outline">
                    Apply
                  </Button>
                </form>
                {couponCodes.length ? (
                  <div className="flex flex-wrap gap-2">
                    {couponCodes.map((code) => {
                      const status = q?.coupons?.find((c) => c.code === code);
                      return (
                        <Badge key={code} variant={status?.applied ? "success" : "warning"} className="gap-1.5 py-1">
                          {code}
                          {status && !status.applied ? <span className="font-normal">· {status.reason}</span> : null}
                          <button type="button" aria-label={`Remove ${code}`} onClick={() => setCouponCodes(couponCodes.filter((c) => c !== code))}>
                            ×
                          </button>
                        </Badge>
                      );
                    })}
                  </div>
                ) : null}
                <Field label="Note" hint="Added to the order timeline, visible to staff only.">
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Phone order, customer asked for gift wrap" />
                </Field>
              </CardContent>
            </Card>
          </>
        }
        side={
          <Card className="lg:sticky lg:top-20">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
              {quote.isFetching ? <span className="text-xs text-muted-foreground">Updating…</span> : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {quote.error ? <Alert variant="destructive">{quote.error instanceof Error ? quote.error.message : "Could not price the draft"}</Alert> : null}
              <dl className="space-y-1.5 text-[13px]">
                <SummaryRow label="Subtotal" value={formatMoney(q?.subtotal)} />
                {(q?.discounts ?? []).map((d) => (
                  <SummaryRow key={d.name} label={d.name ?? "Discount"} value={`−${formatMoney(d.amount)}`} tone="text-success" />
                ))}
                <SummaryRow label="Shipping" value={formatMoney(q?.shipping)} />
                <SummaryRow label="Tax" value={formatMoney(q?.tax)} />
                <Separator className="my-2" />
                <SummaryRow label="Total" value={formatMoney(q?.total)} strong />
              </dl>
              {q?.missing?.length ? (
                <ul className="space-y-1 rounded-lg bg-muted/60 p-3 text-[13px]">
                  {q.missing.map((m) => (
                    <li key={m} className="flex items-center gap-2 text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-warning" />
                      {MISSING[m] ?? humanize(m)}
                    </li>
                  ))}
                </ul>
              ) : q ? (
                <p className="flex items-center gap-2 text-[13px] text-success">
                  <CheckCircle2 className="size-4" /> Ready to place
                </p>
              ) : null}
              <Button size="lg" disabled={!ready} loading={create.isPending} onClick={() => create.mutate(undefined)}>
                Create order
              </Button>
              <p className="text-xs text-muted-foreground">Payment is recorded with the chosen method; offline methods leave it pending until you capture it.</p>
            </CardContent>
          </Card>
        }
      />
      {unsaved.dialog}
    </Page>
  );
};

const SummaryRow = ({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) => (
  <div className={cn("flex justify-between gap-3", strong && "text-base font-semibold")}>
    <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
    <dd className={cn("tabular", tone)}>{value}</dd>
  </div>
);

const Choice = ({ selected, onSelect, title, detail, aside }: { selected: boolean; onSelect: () => void; title: string; detail?: string; aside?: string }) => (
  <button type="button" role="radio" aria-checked={selected} aria-label={aside ? `${title}, ${aside}` : title} onClick={onSelect} className={cn("flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors", selected ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-accent")}>
    <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border", selected && "border-primary")}>{selected ? <span className="size-2 rounded-full bg-primary" /> : null}</span>
    <span className="flex-1">
      <span className="block text-[13px] font-medium">{title}</span>
      {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
    </span>
    {aside ? <span className="tabular text-[13px]">{aside}</span> : null}
  </button>
);
