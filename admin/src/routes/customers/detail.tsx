import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ClipboardList, KeyRound, LogOut, MapPinPlus, MoreHorizontal, Pencil, Star, Trash2, UserX } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { Field, FormSection, reportError } from "@/components/form";
import { JsonView } from "@/components/inputs";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { PluginWidgets } from "@/components/plugin-widgets";
import { SaveBar, useProblemFocus, useSaveShortcut } from "@/components/save-bar";
import { BooleanBadge, StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Switch } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf, type VariablesOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatAmount, formatDate, formatDateTime, formatMoney, relativeTime } from "@/lib/format";
import { useAction, useReference } from "@/lib/hooks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { Address, AddressFields } from "@/routes/orders/detail";
import { customerName } from "./list";

const toCustomerId = (param: string) => (param.startsWith("gid://") ? param : `gid://ecom/Customer/${param}`);

const RECENT_ORDERS = 50;

export const CustomerQuery = graphql(`
  query Customer($id: ID!, $withOrders: Boolean!) {
    node(id: $id) {
      ... on Customer {
        id
        email
        firstName
        lastName
        phone
        dateOfBirth
        isActive
        acceptsMarketing
        note
        metadata
        createdAt
        updatedAt
        lastLoginAt
        emailVerifiedAt
        group {
          id
          code
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
        orders(first: 50) @include(if: $withOrders) {
          totalCount
          edges {
            node {
              id
              number
              placedAt
              status
              paymentStatus
              fulfillmentStatus
              totals {
                total {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`);

type Customer = Extract<NonNullable<ResultOf<typeof CustomerQuery>["node"]>, { email?: unknown }>;
type CustomerAddress = NonNullable<Customer["addresses"]>[number];

const CreateMutation = graphql(
  `
    mutation CustomerCreate($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        __typename
        ... on CustomerPayload {
          customer {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const UpdateMutation = graphql(
  `
    mutation CustomerUpdate($id: ID!, $input: CustomerUpdateInput!) {
      customerUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const AddressCreateMutation = graphql(
  `
    mutation CustomerAddressCreate($customerId: ID, $input: CustomerAddressInput!) {
      customerAddressCreate(customerId: $customerId, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const AddressUpdateMutation = graphql(
  `
    mutation CustomerAddressUpdate($customerId: ID, $id: ID!, $input: CustomerAddressInput!) {
      customerAddressUpdate(customerId: $customerId, id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const AddressDeleteMutation = graphql(
  `
    mutation CustomerAddressDelete($customerId: ID, $id: ID!) {
      customerAddressDelete(customerId: $customerId, id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const ResetMutation = graphql(
  `
    mutation CustomerPasswordResetSend($id: ID!) {
      customerPasswordResetSend(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const RevokeMutation = graphql(
  `
    mutation CustomerSessionsRevoke($id: ID!) {
      customerSessionsRevoke(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const DeleteMutation = graphql(
  `
    mutation CustomerDelete($id: ID!) {
      customerDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** Empty inputs mean "not set"; the API treats omitted fields as unchanged. */
const filled = <T extends Record<string, unknown>>(values: T) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === ""))) as Partial<T>;

export const CustomerPage = () => {
  const { id } = useParams({ strict: false }) as { id?: string };
  return id ? <EditCustomer key={id} id={toCustomerId(id)} /> : <CreateCustomer />;
};

// ---------------------------------------------------------------- create

type CreateForm = { firstName: string; lastName: string; email: string; phone: string; groupId: string; note: string; acceptsMarketing: boolean; password: string; sendReset: boolean };

const CreateCustomer = () => {
  const navigate = useNavigate();
  const { customerGroups } = useReference();
  const form = useForm<CreateForm>({ defaultValues: { firstName: "", lastName: "", email: "", phone: "", groupId: "", note: "", acceptsMarketing: false, password: "", sendReset: true } });
  const password = form.watch("password");
  const unsaved = useUnsavedChanges(form.formState.isDirty, { description: "The customer has not been created yet; what you entered will be lost." });
  const create = useAction(
    async (values: CreateForm) => {
      const result = unwrap(
        (
          await request(CreateMutation, {
            input: {
              email: values.email.trim(),
              firstName: values.firstName.trim(),
              lastName: values.lastName.trim(),
              acceptsMarketing: values.acceptsMarketing,
              ...filled({ phone: values.phone, groupId: values.groupId, note: values.note, password: values.password }),
            },
          })
        ).customerCreate,
      );
      const customerId = result.customer!.id;
      if (!values.password && values.sendReset) unwrap((await request(ResetMutation, { id: customerId })).customerPasswordResetSend);
      return { customerId, invited: !values.password && values.sendReset };
    },
    {
      success: (r) => (r.invited ? "Customer created and invited to set a password" : "Customer created"),
      invalidate: [["customers"]],
      onSuccess: (r) => {
        unsaved.release();
        void navigate({ to: "/customers/$id", params: { id: r.customerId } });
      },
      onError: (error) => reportError(error, form),
    },
  );
  const err = (name: keyof CreateForm) => form.formState.errors[name]?.message;

  return (
    <Page>
      <PageHeader back={{ to: "/customers", label: "Customers" }} title="Add customer" description="Create an account on the customer's behalf, for example after a phone order." />
      <form onSubmit={form.handleSubmit((v) => create.mutate(v))}>
        <TwoColumn
          main={
            <Card>
              <CardContent className="grid gap-5 pt-5">
                <FormSection title="Profile">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="First name" required error={err("firstName")}>
                      <Input autoFocus {...form.register("firstName", { required: "Required" })} />
                    </Field>
                    <Field label="Last name" required error={err("lastName")}>
                      <Input {...form.register("lastName", { required: "Required" })} />
                    </Field>
                    <Field label="Email" required error={err("email")}>
                      <Input type="email" autoComplete="off" {...form.register("email", { required: "Required" })} />
                    </Field>
                    <Field label="Phone" error={err("phone")}>
                      <Input type="tel" {...form.register("phone")} />
                    </Field>
                  </div>
                </FormSection>
                <FormSection title="Sign-in" description="Leave the password empty to let the customer choose one.">
                  <Field label="Password" hint="At least 10 characters." error={err("password")}>
                    <Input type="password" autoComplete="new-password" {...form.register("password")} />
                  </Field>
                  {!password ? (
                    <Label className="font-normal">
                      <Controller control={form.control} name="sendReset" render={({ field }) => <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />} />
                      Email the customer a link to set their password
                    </Label>
                  ) : null}
                </FormSection>
              </CardContent>
            </Card>
          }
          side={
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Account</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <Field label="Customer group" hint="Decides prices and tax class. Defaults to General.">
                    <NativeSelect {...form.register("groupId")}>
                      <option value="">Default group</option>
                      {customerGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Label className="justify-between font-normal">
                    Accepts marketing
                    <Controller control={form.control} name="acceptsMarketing" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
                  </Label>
                  <Field label="Staff note" hint="Visible to staff only.">
                    <Textarea rows={3} {...form.register("note")} />
                  </Field>
                </CardContent>
              </Card>
              <Button type="submit" loading={create.isPending} className="self-end">
                Create customer
              </Button>
            </>
          }
        />
      </form>
      {unsaved.dialog}
    </Page>
  );
};

// ---------------------------------------------------------------- edit

const EditCustomer = ({ id }: { id: string }) => {
  const { can } = useAuth();
  const canOrders = can("orders:read");
  const query = useQuery({ queryKey: ["customer", id], queryFn: ({ signal }) => request(CustomerQuery, { id, withOrders: canOrders }, { signal }) });

  if (query.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  }
  const customer = query.data?.node && "email" in query.data.node ? (query.data.node as Customer) : null;
  if (!customer) {
    return (
      <Page>
        <EmptyState
          title="Customer not found"
          description={query.error instanceof Error ? query.error.message : "The customer may have been deleted."}
          action={
            <Button asChild variant="outline">
              <Link to="/customers">Back to customers</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return <CustomerDetail customer={customer} />;
};

type ProfileForm = { firstName: string; lastName: string; email: string; phone: string; dateOfBirth: string };
type AccountForm = { isActive: boolean; groupId: string; acceptsMarketing: boolean; note: string };

const PROFILE_FIELDS: readonly string[] = ["firstName", "lastName", "email", "phone", "dateOfBirth"] satisfies (keyof ProfileForm)[];
const ACCOUNT_FIELDS: readonly string[] = ["isActive", "groupId", "acceptsMarketing", "note"] satisfies (keyof AccountForm)[];

const profileValues = (customer: Customer): ProfileForm => ({ firstName: customer.firstName ?? "", lastName: customer.lastName ?? "", email: customer.email ?? "", phone: customer.phone ?? "", dateOfBirth: customer.dateOfBirth ?? "" });
const accountValues = (customer: Customer): AccountForm => ({ isActive: customer.isActive ?? true, groupId: customer.group?.id ?? "", acceptsMarketing: customer.acceptsMarketing ?? false, note: customer.note ?? "" });

/** The profile and account cards are edited together and saved with one customerUpdate. */
const CustomerDetail = ({ customer }: { customer: Customer }) => {
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = customer.id;
  const canOrders = can("orders:read");
  const write = can("customers:write");
  const [dialog, setDialog] = useState<"revoke" | "delete" | null>(null);
  const [editing, setEditing] = useState<CustomerAddress | "new" | null>(null);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["customer", id] }), queryClient.invalidateQueries({ queryKey: ["customers"] })]);

  const profile = useForm<ProfileForm>({ values: profileValues(customer), shouldFocusError: false });
  const account = useForm<AccountForm>({ values: accountValues(customer), shouldFocusError: false });
  const profileDirty = profile.formState.isDirty;
  const accountDirty = account.formState.isDirty;
  const dirty = write && (profileDirty || accountDirty);
  const unsaved = useUnsavedChanges(dirty);
  const cardsRef = useRef<HTMLDivElement>(null);
  const goToFirstProblem = useProblemFocus(() => cardsRef.current);

  /** Field errors go to the card that has the field; the rest are listed in the toast. */
  const fail = (error: unknown) => {
    if (!(error instanceof MutationError) || !error.fieldErrors.length) return reportError(error);
    const unplaced: string[] = [];
    for (const fieldError of error.fieldErrors) {
      const [root, field] = fieldError.path;
      if (root === "input" && field && PROFILE_FIELDS.includes(field)) profile.setError(field as keyof ProfileForm, { message: fieldError.message });
      else if (root === "input" && field && ACCOUNT_FIELDS.includes(field)) account.setError(field as keyof AccountForm, { message: fieldError.message });
      else unplaced.push(`${fieldError.path.join(".")}: ${fieldError.message}`);
    }
    toast.error(error.message, { description: unplaced.length ? unplaced.join("\n") : undefined });
    goToFirstProblem();
  };

  const save = useAction(
    (sent: { profile: ProfileForm | null; account: AccountForm | null }) =>
      request(UpdateMutation, {
        id,
        input: {
          // Empty clears: the admin API treats an explicit null phone, date of birth or note as "remove".
          ...(sent.profile ? { firstName: sent.profile.firstName.trim(), lastName: sent.profile.lastName.trim(), email: sent.profile.email.trim(), phone: sent.profile.phone.trim() || null, dateOfBirth: sent.profile.dateOfBirth || null } : {}),
          ...(sent.account ? { isActive: sent.account.isActive, acceptsMarketing: sent.account.acceptsMarketing, note: sent.account.note.trim() || null, ...filled({ groupId: sent.account.groupId }) } : {}),
        },
      }).then((r) => unwrap(r.customerUpdate)),
    {
      success: "Customer saved",
      onSuccess: (_result, sent) => {
        // What was sent is now saved; edits made while saving stay unsaved.
        if (sent.profile) profile.reset(sent.profile, { keepValues: true });
        if (sent.account) account.reset(sent.account, { keepValues: true });
        void refresh();
      },
      onError: fail,
    },
  );

  const submit = async () => {
    if (!write || save.isPending) return;
    const sent: { profile: ProfileForm | null; account: AccountForm | null } = { profile: null, account: null };
    let valid = true;
    if (profileDirty) await profile.handleSubmit((v) => void (sent.profile = v), () => void (valid = false))();
    if (accountDirty) await account.handleSubmit((v) => void (sent.account = v), () => void (valid = false))();
    if (!valid) return goToFirstProblem();
    if (sent.profile || sent.account) save.mutate(sent);
  };
  useSaveShortcut(() => void submit(), dirty);

  const discard = () => {
    profile.reset();
    account.reset();
  };

  const reset = useAction(() => request(ResetMutation, { id }).then((r) => unwrap(r.customerPasswordResetSend)), { success: "Password reset email requested" });
  const revoke = useAction(() => request(RevokeMutation, { id }).then((r) => unwrap(r.customerSessionsRevoke)), {
    success: "Signed out on every device",
    onSuccess: () => setDialog(null),
  });
  const remove = useAction(() => request(DeleteMutation, { id }).then((r) => unwrap(r.customerDelete)), {
    success: "Customer deleted",
    invalidate: [["customers"]],
    onSuccess: () => {
      unsaved.release();
      queryClient.removeQueries({ queryKey: ["customer", id] });
      void navigate({ to: "/customers" });
    },
  });

  const orders = (customer.orders?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
  const spend = new Map<string, number>();
  for (const order of orders) {
    if (order.status === "CANCELED" || !order.totals?.total?.currencyCode) continue;
    const currency = order.totals.total.currencyCode;
    spend.set(currency, (spend.get(currency) ?? 0) + Number(order.totals.total.amount ?? 0));
  }
  const totalOrders = customer.orders?.totalCount ?? 0;
  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return (
    <Page>
      <PageHeader
        back={{ to: "/customers", label: "Customers" }}
        title={customerName(customer)}
        badges={
          <>
            <BooleanBadge value={customer.isActive} on="Active" off="Disabled" />
            {customer.group ? <Badge variant="secondary">{customer.group.name}</Badge> : null}
          </>
        }
        description={`${customer.email} · customer since ${formatDate(customer.createdAt)}`}
        actions={
          <>
            {can("orders:write") ? (
              <Button variant="outline" asChild>
                <Link to="/orders/new" search={{ q: customer.id }}>
                  <ClipboardList />
                  Create order
                </Link>
              </Button>
            ) : null}
            {write ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem disabled={!customer.isActive} onSelect={() => reset.mutate(undefined)}>
                    <KeyRound />
                    Send password reset
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog("revoke")}>
                    <LogOut />
                    Sign out everywhere
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setDialog("delete")}>
                    <Trash2 />
                    Delete customer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />

      <div ref={cardsRef} className="contents">
        <TwoColumn
          main={
            <>
              <ProfileCard form={profile} write={write} onSubmit={onFormSubmit} />

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Addresses</CardTitle>
                    <CardDescription>Saved for checkout. Defaults are pre-selected for the customer.</CardDescription>
                  </div>
                  {write ? (
                    <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
                      <MapPinPlus />
                      Add address
                    </Button>
                  ) : null}
                </CardHeader>
                <CardContent>
                  {(customer.addresses ?? []).length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">No saved addresses.</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(customer.addresses ?? []).map((a) => (
                        <AddressCard key={a.id} customerId={customer.id} address={a} write={write} onEdit={() => setEditing(a)} onChanged={refresh} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {canOrders ? (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Orders</CardTitle>
                      <CardDescription>
                        {totalOrders} order{totalOrders === 1 ? "" : "s"} in total.
                      </CardDescription>
                    </div>
                    {totalOrders > 0 ? (
                      <Button variant="ghost" size="sm" asChild>
                        <Link to="/orders" search={{ q: customer.email ?? undefined }}>
                          View all
                        </Link>
                      </Button>
                    ) : null}
                  </CardHeader>
                  {orders.length === 0 ? (
                    <CardContent className="text-[13px] text-muted-foreground">No orders yet.</CardContent>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Order</TableHead>
                          <TableHead>Placed</TableHead>
                          <TableHead>Payment</TableHead>
                          <TableHead>Fulfillment</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {orders.slice(0, 10).map((o) => (
                          <TableRow key={o.id} className="cursor-pointer" onClick={() => void navigate({ to: "/orders/$number", params: { number: o.number! } })}>
                            <TableCell>
                              <Link to="/orders/$number" params={{ number: o.number! }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                                {o.number}
                              </Link>
                              {o.status === "CANCELED" ? <span className="ml-2 text-xs text-muted-foreground">canceled</span> : null}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{relativeTime(o.placedAt)}</TableCell>
                            <TableCell>
                              <StatusBadge value={o.paymentStatus} />
                            </TableCell>
                            <TableCell>
                              <StatusBadge value={o.fulfillmentStatus} />
                            </TableCell>
                            <TableCell className="tabular text-right">{formatMoney(o.totals?.total)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Card>
              ) : null}
            </>
          }
          side={
            <>
              <AccountCard form={account} customer={customer} write={write} onSubmit={onFormSubmit} />
              <Card>
                <CardHeader>
                  <CardTitle>Activity</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl>
                    {canOrders ? (
                      <>
                        <Detail label="Orders">{totalOrders}</Detail>
                        <Detail label={totalOrders > RECENT_ORDERS ? `Spent (last ${RECENT_ORDERS})` : "Total spent"}>
                          {spend.size ? [...spend].map(([currency, amount]) => formatAmount(amount, currency)).join(" · ") : "—"}
                        </Detail>
                        <Detail label="Last order">{orders[0] ? formatDate(orders[0].placedAt) : "—"}</Detail>
                      </>
                    ) : null}
                    <Detail label="Last sign-in">{customer.lastLoginAt ? formatDateTime(customer.lastLoginAt) : "Never"}</Detail>
                    <Detail label="Email verified">{customer.emailVerifiedAt ? formatDate(customer.emailVerifiedAt) : "No"}</Detail>
                    <Detail label="Updated">{formatDateTime(customer.updatedAt)}</Detail>
                  </dl>
                </CardContent>
              </Card>
              {customer.metadata && Object.keys(customer.metadata as object).length ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Metadata</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <JsonView value={customer.metadata} />
                  </CardContent>
                </Card>
              ) : null}
              <PluginWidgets zone="customer.detail" id={customer.id} />
            </>
          }
        />
      </div>

      {dirty ? <SaveBar status={`Unsaved changes in ${[profileDirty ? "Profile" : null, accountDirty ? "Account" : null].filter(Boolean).join(" and ")}`} saving={save.isPending} onSave={() => void submit()} onDiscard={discard} /> : null}

      {editing ? <AddressDialog customerId={customer.id} address={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={dialog === "revoke"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Sign out everywhere?"
        description="Ends every storefront session of this customer. They will need to sign in again on each device."
        confirmLabel="Sign out"
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate(undefined)}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete ${customerName(customer)}?`}
        description="The account, saved addresses, carts and sessions are removed. Orders are kept, with their own copy of the email and addresses, but no longer linked to an account. This cannot be undone."
        destructive
        confirmLabel="Delete customer"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
      {unsaved.dialog}
    </Page>
  );
};

const ProfileCard = ({ form, write, onSubmit }: { form: UseFormReturn<ProfileForm>; write: boolean; onSubmit: (event: FormEvent) => void }) => {
  const err = (name: keyof ProfileForm) => form.formState.errors[name]?.message;
  const invalid = (name: keyof ProfileForm) => (err(name) ? true : undefined);
  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!write} className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required error={err("firstName")}>
              <Input aria-invalid={invalid("firstName")} {...form.register("firstName", { required: "Required" })} />
            </Field>
            <Field label="Last name" required error={err("lastName")}>
              <Input aria-invalid={invalid("lastName")} {...form.register("lastName", { required: "Required" })} />
            </Field>
            <Field label="Email" required hint="Changing it changes how the customer signs in." error={err("email")}>
              <Input type="email" aria-invalid={invalid("email")} {...form.register("email", { required: "Required" })} />
            </Field>
            <Field label="Phone" error={err("phone")}>
              <Input type="tel" aria-invalid={invalid("phone")} {...form.register("phone")} />
            </Field>
            <Field label="Date of birth" error={err("dateOfBirth")}>
              <Input type="date" aria-invalid={invalid("dateOfBirth")} {...form.register("dateOfBirth")} />
            </Field>
          </fieldset>
        </CardContent>
        {/* Lets Enter in a field save both cards, like the save bar. */}
        <button type="submit" className="sr-only" aria-hidden tabIndex={-1} />
      </form>
    </Card>
  );
};

const AccountCard = ({ form, customer, write, onSubmit }: { form: UseFormReturn<AccountForm>; customer: Customer; write: boolean; onSubmit: (event: FormEvent) => void }) => {
  const { customerGroups } = useReference();
  const active = form.watch("isActive");
  const err = (name: keyof AccountForm) => form.formState.errors[name]?.message;
  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!write} className="grid gap-4">
            <Label className="justify-between font-normal">
              <span>
                Can sign in
                <span className="block text-xs text-muted-foreground">Disabling also signs the customer out.</span>
              </span>
              <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!write} />} />
            </Label>
            {!active && customer.isActive ? <Alert variant="warning">Saving disables the account and ends its sessions.</Alert> : null}
            <Field label="Customer group" hint="Decides prices, promotions and tax class." error={err("groupId")}>
              <NativeSelect aria-invalid={err("groupId") ? true : undefined} {...form.register("groupId")}>
                {customerGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Label className="justify-between font-normal">
              Accepts marketing
              <Controller control={form.control} name="acceptsMarketing" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!write} />} />
            </Label>
            <Field label="Staff note" hint="Visible to staff only." error={err("note")}>
              <Textarea rows={3} aria-invalid={err("note") ? true : undefined} {...form.register("note")} />
            </Field>
          </fieldset>
        </CardContent>
      </form>
    </Card>
  );
};

type AddressFormValues = Record<string, string | boolean> & { isDefaultShipping: boolean; isDefaultBilling: boolean };
type AddressInput = VariablesOf<typeof AddressUpdateMutation>["input"]["address"];
const ADDRESS_KEYS = ["firstName", "lastName", "company", "line1", "line2", "city", "region", "regionCode", "postalCode", "countryCode", "phone"] as const;

/** An API address input from a stored address or form values, without blank optional fields. */
const toAddressInput = (source: Record<string, unknown> | null | undefined): AddressInput =>
  filled(Object.fromEntries(ADDRESS_KEYS.map((k) => [k, typeof source?.[k] === "string" ? (source[k] as string).trim() : (source?.[k] ?? "")]))) as unknown as AddressInput;

const AddressCard = ({ customerId, address, write, onEdit, onChanged }: { customerId: string; address: CustomerAddress; write: boolean; onEdit: () => void; onChanged: () => Promise<unknown> }) => {
  const [confirm, setConfirm] = useState(false);
  const setDefault = useAction(
    (kind: "isDefaultShipping" | "isDefaultBilling") =>
      request(AddressUpdateMutation, { customerId, id: address.id, input: { address: toAddressInput(address.address), [kind]: true } }).then((r) => unwrap(r.customerAddressUpdate)),
    { success: "Default address updated", onSuccess: () => void onChanged() },
  );
  const remove = useAction(() => request(AddressDeleteMutation, { customerId, id: address.id }).then((r) => unwrap(r.customerAddressDelete)), {
    success: "Address deleted",
    onSuccess: () => {
      setConfirm(false);
      void onChanged();
    },
  });
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap gap-1.5">
        {address.isDefaultShipping ? <Badge variant="info">Default shipping</Badge> : null}
        {address.isDefaultBilling ? <Badge variant="info">Default billing</Badge> : null}
      </div>
      <Address address={address.address} />
      {write ? (
        <div className="mt-auto flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil />
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Address actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={!!address.isDefaultShipping} onSelect={() => setDefault.mutate("isDefaultShipping")}>
                <Star />
                Make default shipping
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!!address.isDefaultBilling} onSelect={() => setDefault.mutate("isDefaultBilling")}>
                <Star />
                Make default billing
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
                <UserX />
                Delete address
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this address?" description="Orders that used it keep their own copy." destructive confirmLabel="Delete" loading={remove.isPending} onConfirm={() => remove.mutate(undefined)} />
    </div>
  );
};


const AddressDialog = ({ customerId, address, onClose, onSaved }: { customerId: string; address: CustomerAddress | null; onClose: () => void; onSaved: () => Promise<unknown> }) => {
  const initial = Object.fromEntries(ADDRESS_KEYS.map((k) => [k, (address?.address as Record<string, string | null> | null | undefined)?.[k] ?? ""]));
  const form = useForm<AddressFormValues>({ defaultValues: { ...initial, isDefaultShipping: address?.isDefaultShipping ?? false, isDefaultBilling: address?.isDefaultBilling ?? false } });
  const save = useAction(
    async (values: AddressFormValues) => {
      const input = { address: toAddressInput(values), isDefaultShipping: values.isDefaultShipping, isDefaultBilling: values.isDefaultBilling };
      if (address) return unwrap((await request(AddressUpdateMutation, { customerId, id: address.id, input })).customerAddressUpdate);
      return unwrap((await request(AddressCreateMutation, { customerId, input })).customerAddressCreate);
    },
    {
      success: address ? "Address saved" : "Address added",
      onSuccess: () => {
        onClose();
        void onSaved();
      },
      onError: (error) => reportError(error, form, ["input"]),
    },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{address ? "Edit address" : "Add address"}</DialogTitle>
          <DialogDescription>Saved to the customer's address book.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <AddressFields form={form} />
          <div className="flex flex-wrap gap-5">
            <Label className="font-normal">
              <Controller control={form.control} name="isDefaultShipping" render={({ field }) => <Checkbox checked={!!field.value} onCheckedChange={(v) => field.onChange(v === true)} />} />
              Default shipping address
            </Label>
            <Label className="font-normal">
              <Controller control={form.control} name="isDefaultBilling" render={({ field }) => <Checkbox checked={!!field.value} onCheckedChange={(v) => field.onChange(v === true)} />} />
              Default billing address
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {address ? "Save address" : "Add address"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
