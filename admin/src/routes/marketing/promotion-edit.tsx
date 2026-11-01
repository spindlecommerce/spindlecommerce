import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Download, Save, Sparkles, Ticket, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field, reportError } from "@/components/form";
import { MoneyByCurrencyInput } from "@/components/inputs";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { focusProblem, SaveBar, useProblemFocus, useSaveShortcut } from "@/components/save-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelect } from "@/components/ui/combobox";
import { Checkbox, Switch } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { useAction, useReference } from "@/lib/hooks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { cn, downloadText, toCsv } from "@/lib/utils";
import {
  ACTION_FIELDS,
  ACTIONS,
  actionFromStored,
  actionInput,
  describeAction,
  describeCondition,
  emptyAction,
  emptyPredicate,
  rootFromStored,
  conditionInput,
  validateAction,
  validateCondition,
  type ActionKind,
  type ActionState,
  type Condition,
  type RuleProblem,
} from "./promotion-rules";
import { PromotionStateBadge } from "./promotions";
import { ConditionEditor, PredicateEditor, TagInput, useRuleData, type RuleProblems } from "./rule-builder";

const toPromotionId = (param: string) => (param.startsWith("gid://") ? param : `gid://ecom/Promotion/${param}`);

const PromotionQuery = graphql(`
  query Promotion($id: ID!) {
    node(id: $id) {
      ... on Promotion {
        id
        name
        description
        isActive
        requiresCoupon
        priority
        stopFurtherRules
        startsAt
        endsAt
        usageLimit
        usageLimitPerCustomer
        timesUsed
        conditions
        action
        createdAt
        channels {
          id
        }
        customerGroups {
          id
        }
        coupons {
          id
          code
          timesUsed
          usageLimit
          expiresAt
        }
      }
    }
  }
`);

type Promotion = Extract<NonNullable<ResultOf<typeof PromotionQuery>["node"]>, { requiresCoupon?: unknown }>;

const ShippingMethodsQuery = graphql(`
  query PromotionShippingMethods {
    shippingMethods {
      code
      names {
        locale
        value
      }
    }
  }
`);

const CreateMutation = graphql(
  `
    mutation PromotionCreate($input: PromotionInput!) {
      promotionCreate(input: $input) {
        __typename
        ... on PromotionPayload {
          promotion {
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
    mutation PromotionUpdate($id: ID!, $input: PromotionUpdateInput!) {
      promotionUpdate(id: $id, input: $input) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const DeleteMutation = graphql(
  `
    mutation PromotionDelete($id: ID!) {
      promotionDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const DeleteCouponsMutation = graphql(
  `
    mutation CouponsDelete($ids: [ID!]!) {
      couponsDelete(ids: $ids) {
        __typename
        ... on CouponsDeletePayload {
          deletedIds
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const GenerateMutation = graphql(
  `
    mutation CouponsGenerate($promotionId: ID!, $quantity: Int!, $prefix: String, $length: Int, $usageLimit: Int, $expiresAt: DateTime) {
      couponsGenerate(promotionId: $promotionId, quantity: $quantity, prefix: $prefix, length: $length, usageLimit: $usageLimit, expiresAt: $expiresAt) {
        __typename
        ... on CouponsGeneratePayload {
          coupons {
            code
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** ISO date-time ↔ the value of an `<input type="datetime-local">`, in the viewer's time zone. */
const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

/** The rule as the API receives it, to compare with what was last saved. */
const ruleSnapshot = (root: Condition, action: ActionState) => JSON.stringify([conditionInput(root), actionInput(action)]);

type FormValues = {
  name: string;
  description: string;
  isActive: boolean;
  priority: string;
  stopFurtherRules: boolean;
  requiresCoupon: boolean;
  couponCodes: string[];
  startsAt: string;
  endsAt: string;
  usageLimit: string;
  usageLimitPerCustomer: string;
  channelIds: string[];
  customerGroupIds: string[];
};

export const PromotionEditPage = () => {
  const { id } = useParams({ strict: false }) as { id?: string };
  const promotionId = id ? toPromotionId(id) : null;
  const query = useQuery({ queryKey: ["promotion", promotionId], queryFn: ({ signal }) => request(PromotionQuery, { id: promotionId! }, { signal }), enabled: !!promotionId });

  if (promotionId && query.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-64" />
        <Skeleton className="h-[32rem] w-full" />
      </Page>
    );
  }
  const promotion = query.data?.node && "requiresCoupon" in query.data.node ? (query.data.node as Promotion) : null;
  if (promotionId && !promotion) {
    return (
      <Page>
        <EmptyState
          title="Promotion not found"
          description={query.error instanceof Error ? query.error.message : "It may have been deleted."}
          action={
            <Button asChild variant="outline">
              <Link to="/promotions">Back to promotions</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return <PromotionEditor key={promotion?.id ?? "new"} promotion={promotion} />;
};

const PromotionEditor = ({ promotion }: { promotion: Promotion | null }) => {
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { channels, customerGroups, currencies, defaultLocale } = useReference();
  const write = can("promotions:write");
  const editing = !!promotion;

  const initialRoot = useMemo(() => rootFromStored(promotion?.conditions), [promotion]);
  const initialAction = useMemo(() => (promotion ? actionFromStored(promotion.action) : emptyAction()), [promotion]);
  const [root, setRoot] = useState<Condition>(initialRoot);
  const [action, setAction] = useState<ActionState>(initialAction);
  // The rule as last saved, for Discard and to tell whether it changed.
  const [saved, setSaved] = useState(() => ({ root: initialRoot, action: initialAction }));
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Problems show once Save was tried, and then update as the rule is edited.
  const [attempted, setAttempted] = useState(false);
  const data = useRuleData(root, action.target);
  const shippingMethods = useQuery({ queryKey: ["promotion-shipping-methods"], queryFn: () => request(ShippingMethodsQuery), retry: false, staleTime: 5 * 60_000 });

  const form = useForm<FormValues>({
    defaultValues: {
      name: promotion?.name ?? "",
      description: promotion?.description ?? "",
      isActive: promotion?.isActive ?? true,
      priority: String(promotion?.priority ?? 0),
      stopFurtherRules: promotion?.stopFurtherRules ?? false,
      requiresCoupon: promotion?.requiresCoupon ?? false,
      couponCodes: [],
      startsAt: toLocalInput(promotion?.startsAt),
      endsAt: toLocalInput(promotion?.endsAt),
      usageLimit: promotion?.usageLimit ? String(promotion.usageLimit) : "",
      usageLimitPerCustomer: promotion?.usageLimitPerCustomer ? String(promotion.usageLimitPerCustomer) : "",
      channelIds: (promotion?.channels ?? []).map((c) => c.id),
      customerGroupIds: (promotion?.customerGroups ?? []).map((g) => g.id),
    },
    // Save goes to the first problem itself, rule rows included.
    shouldFocusError: false,
  });
  const values = form.watch();
  // Compared as API input, since amounts come back normalized (50 → 50.00).
  const baseline = useMemo(() => ruleSnapshot(saved.root, saved.action), [saved]);
  const dirty = form.formState.isDirty || ruleSnapshot(root, action) !== baseline;
  const unsaved = useUnsavedChanges(write && dirty);

  const formRef = useRef<HTMLFormElement>(null);
  const goToFirstProblem = useProblemFocus(() => formRef.current);
  const ruleProblems = useMemo(() => [...validateCondition(root), ...validateAction(action)], [root, action]);
  const shownRuleProblems = attempted ? ruleProblems : [];
  const problemsByKey = new Map<string, string>();
  for (const p of shownRuleProblems) if (!problemsByKey.has(p.key)) problemsByKey.set(p.key, p.message);
  const { errors } = form.formState;
  // Everything to fix, in the order it appears on the page.
  const summary: RuleProblem[] = attempted
    ? [
        ...(errors.name ? [{ key: "name", where: "Name", message: errors.name.message || "Required" }] : []),
        ...shownRuleProblems,
        ...(errors.endsAt ? [{ key: "endsAt", where: "Ends", message: errors.endsAt.message || "Check the date" }] : []),
      ]
    : [];
  const goTo = (key: string) => {
    const marked = key === "name" || key === "endsAt" ? formRef.current?.querySelector<HTMLElement>(`[name="${key}"]`) : formRef.current?.querySelector<HTMLElement>(`[data-rule-key="${CSS.escape(key)}"]`);
    if (marked) focusProblem(marked);
  };

  const save = useAction(
    async ({ values: v, root: sentRoot, action: sentAction }: { values: FormValues; root: Condition; action: ActionState }) => {
      const number = (s: string) => (s.trim() === "" ? null : Math.max(1, Math.floor(Number(s))));
      const common = {
        name: v.name.trim(),
        isActive: v.isActive,
        priority: Math.max(0, Math.floor(Number(v.priority) || 0)),
        stopFurtherRules: v.stopFurtherRules,
        channelIds: v.channelIds,
        customerGroupIds: v.customerGroupIds,
        conditions: conditionInput(sentRoot) as never,
        action: actionInput(sentAction) as never,
      };
      // Empty means "none": on update an explicit null clears the stored value.
      const optional = {
        description: v.description.trim() || null,
        startsAt: fromLocalInput(v.startsAt),
        endsAt: fromLocalInput(v.endsAt),
        usageLimit: number(v.usageLimit),
        usageLimitPerCustomer: number(v.usageLimitPerCustomer),
      };
      if (promotion) {
        unwrap((await request(UpdateMutation, { id: promotion.id, input: { ...common, ...optional } })).promotionUpdate);
        return promotion.id;
      }
      const created = unwrap(
        (
          await request(CreateMutation, {
            input: {
              ...common,
              ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null)),
              requiresCoupon: v.requiresCoupon,
              ...(v.requiresCoupon && v.couponCodes.length ? { couponCodes: v.couponCodes } : {}),
            },
          })
        ).promotionCreate,
      );
      return created.promotion!.id;
    },
    {
      success: editing ? "Promotion saved" : "Promotion created",
      invalidate: [["promotions"]],
      onSuccess: (id, sent) => {
        setAttempted(false);
        if (editing) {
          void queryClient.invalidateQueries({ queryKey: ["promotion", promotion!.id] });
          // What was sent is now saved; edits made while saving stay unsaved.
          form.reset(sent.values, { keepValues: true });
          setSaved({ root: sent.root, action: sent.action });
        } else {
          unsaved.release();
          void navigate({ to: "/promotions/$id", params: { id }, replace: true });
        }
      },
      onError: (error) => reportError(error, form),
    },
  );

  const remove = useAction(() => request(DeleteMutation, { id: promotion!.id }).then((r) => unwrap(r.promotionDelete)), {
    success: "Promotion deleted",
    invalidate: [["promotions"]],
    onSuccess: () => {
      unsaved.release();
      void navigate({ to: "/promotions" });
    },
  });

  const submit = form.handleSubmit(
    (v) => {
      setAttempted(true);
      if (ruleProblems.length) return goToFirstProblem();
      save.mutate({ values: v, root, action });
    },
    () => {
      setAttempted(true);
      // Field errors render only after this returns, so go to the first problem on the next tick.
      setTimeout(goToFirstProblem);
    },
  );
  useSaveShortcut(() => void submit(), write && (dirty || !editing) && !save.isPending);

  const discard = () => {
    form.reset();
    setRoot(saved.root);
    setAction(saved.action);
    setAttempted(false);
  };

  const methodOptions = (shippingMethods.data?.shippingMethods ?? []).map((m) => ({ value: m.code ?? "", label: m.names?.find((n) => n.locale === defaultLocale)?.value ?? m.names?.[0]?.value ?? m.code ?? "", hint: m.code ?? undefined }));
  const summaryCondition = describeCondition(root, data.names);
  const channelNames = values.channelIds.length ? values.channelIds.map((id) => channels.find((c) => c.id === id)?.name ?? "?").join(", ") : "every channel";
  const groupNames = values.customerGroupIds.length ? values.customerGroupIds.map((id) => customerGroups.find((g) => g.id === id)?.name ?? "?").join(", ") : "every customer";
  const toFix = summary.length ? `${summary.length} thing${summary.length === 1 ? "" : "s"} to fix` : undefined;

  return (
    <Page>
      <form ref={formRef} onSubmit={submit}>
        <PageHeader
          back={{ to: "/promotions", label: "Promotions" }}
          title={promotion?.name ?? "New promotion"}
          badges={promotion ? <PromotionStateBadge promotion={{ ...promotion }} /> : null}
          description={promotion ? `Created ${formatDate(promotion.createdAt)} · used ${formatNumber(promotion.timesUsed ?? 0)} time${promotion.timesUsed === 1 ? "" : "s"}` : "Describe when the promotion applies and what it gives."}
          actions={
            write ? (
              <>
                {editing ? (
                  <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Delete
                  </Button>
                ) : null}
                <Button type="submit" loading={save.isPending} disabled={editing && !dirty}>
                  <Save />
                  {editing ? "Save" : "Create promotion"}
                </Button>
              </>
            ) : null
          }
        />
        {toFix ? (
          <Alert variant="destructive" title={`${toFix} before saving`} className="mb-6">
            <ul className="mt-1 space-y-0.5">
              {summary.map((p, i) => (
                <li key={`${p.key}-${i}`}>
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => goTo(p.key)}>
                    <span className="font-medium">{p.where}</span>: {p.message}
                  </button>
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <fieldset disabled={!write} className="contents">
          <TwoColumn
            main={
              <>
                <Card>
                  <CardContent className="grid gap-4 pt-5">
                    <Field label="Name" required hint="Shown on orders and receipts as the discount's label." error={errors.name?.message}>
                      <Input autoFocus={!editing} aria-invalid={errors.name ? true : undefined} {...form.register("name", { required: "Required" })} placeholder="Summer sale: 20% off shirts" />
                    </Field>
                    <Field label="Internal description">
                      <Textarea rows={2} {...form.register("description")} placeholder="Why it exists and who approved it" />
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Conditions</CardTitle>
                      <CardDescription>When the cart qualifies. Leave empty to apply to every cart.</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ConditionEditor value={root} onChange={setRoot} data={data} currencies={currencies} problems={problemsByKey} />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Discount</CardTitle>
                      <CardDescription>What the qualifying cart gets.</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {ACTIONS.map((a) => (
                        <button
                          key={a.value}
                          type="button"
                          onClick={() => setAction({ ...action, kind: a.value as ActionKind, percent: a.value === "buyXGetY" || a.value === "shippingOff" ? action.percent || "100" : action.percent })}
                          className={cn("rounded-lg border p-3 text-left transition-colors hover:bg-accent/50", action.kind === a.value && "border-primary bg-primary/5 ring-1 ring-primary/30")}
                        >
                          <p className="text-[13px] font-medium">{a.label}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
                        </button>
                      ))}
                    </div>
                    <ActionFields action={action} onChange={setAction} currencies={currencies} methodOptions={methodOptions} methodsAvailable={!shippingMethods.isError} problems={problemsByKey} />
                    {action.kind !== "shippingOff" ? (
                      <div className="grid gap-2">
                        <Label className="text-[13px]">Applies to</Label>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" variant={action.target ? "outline" : "secondary"} onClick={() => setAction({ ...action, target: null })}>
                            Every item in the cart
                          </Button>
                          <Button type="button" size="sm" variant={action.target ? "secondary" : "outline"} onClick={() => setAction({ ...action, target: action.target ?? emptyPredicate("category") })}>
                            Only matching items
                          </Button>
                        </div>
                        {action.target ? <PredicateEditor value={action.target} onChange={(target) => setAction({ ...action, target })} data={data} problems={problemsByKey} /> : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>

                {promotion?.requiresCoupon ? <CouponsCard promotion={promotion} write={write} /> : null}
              </>
            }
            side={
              <>
                <Card className="border-primary/30 bg-primary/5">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5">
                      <Sparkles className="size-4 text-primary" /> Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-[13px] leading-relaxed">
                    <p>
                      <span className="font-medium">{describeAction(action, data.names)}</span>
                      {root.kind === "all" && root.children.length === 0 ? " on every cart" : ` when ${summaryCondition}`}.
                    </p>
                    <p className="text-muted-foreground">
                      For {groupNames} in {channelNames}
                      {(editing ? promotion.requiresCoupon : values.requiresCoupon) ? ", with a coupon code" : ", applied automatically"}.
                    </p>
                    {values.stopFurtherRules ? <p className="text-muted-foreground">Promotions with a higher priority number are skipped once this one applies.</p> : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Status</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <Label className="justify-between font-normal">
                      Active
                      <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!write} />} />
                    </Label>
                    <Field label="Priority" hint="Lower numbers run first.">
                      <Input type="number" min={0} {...form.register("priority")} />
                    </Field>
                    <Label className="justify-between font-normal">
                      <span>
                        Stop later promotions
                        <span className="block text-xs text-muted-foreground">When this one applies, promotions after it in priority order don't.</span>
                      </span>
                      <Controller control={form.control} name="stopFurtherRules" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!write} />} />
                    </Label>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Coupon</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    {editing ? (
                      <p className="text-[13px]">
                        {promotion.requiresCoupon ? "Applies only with a coupon code." : "Applies automatically, without a code."}
                        <span className="block text-xs text-muted-foreground">Fixed once the promotion is created.</span>
                      </p>
                    ) : (
                      <>
                        <Label className="justify-between font-normal">
                          Requires a coupon code
                          <Controller control={form.control} name="requiresCoupon" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
                        </Label>
                        {values.requiresCoupon ? (
                          <Field label="Codes" hint="Add codes now, or generate many after creating the promotion.">
                            <Controller control={form.control} name="couponCodes" render={({ field }) => <TagInput value={field.value} onChange={field.onChange} uppercase placeholder="SUMMER20" />} />
                          </Field>
                        ) : null}
                      </>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Availability</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <Field label="Channels" hint="Empty means every channel.">
                      <Controller
                        control={form.control}
                        name="channelIds"
                        render={({ field }) => <MultiSelect options={channels.map((c) => ({ value: c.id, label: c.name ?? c.code ?? "" }))} value={field.value} onChange={field.onChange} placeholder="Every channel" disabled={!write} />}
                      />
                    </Field>
                    <Field label="Customer groups" hint="Empty means everyone, including guests.">
                      <Controller
                        control={form.control}
                        name="customerGroupIds"
                        render={({ field }) => <MultiSelect options={customerGroups.map((g) => ({ value: g.id, label: g.name ?? g.code ?? "" }))} value={field.value} onChange={field.onChange} placeholder="Everyone" disabled={!write} />}
                      />
                    </Field>
                    <Field label="Starts" hint="Empty means immediately.">
                      <Input type="datetime-local" {...form.register("startsAt", { deps: ["endsAt"] })} />
                    </Field>
                    <Field label="Ends" hint="Empty means no end." error={errors.endsAt?.message}>
                      <Input
                        type="datetime-local"
                        aria-invalid={errors.endsAt ? true : undefined}
                        {...form.register("endsAt", { validate: (endsAt, all) => !endsAt || !all.startsAt || new Date(all.startsAt) < new Date(endsAt) || "Must be after the start" })}
                      />
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Usage limits</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <Field label="Total uses" hint="Empty means unlimited.">
                      <Input type="number" min={1} {...form.register("usageLimit")} />
                    </Field>
                    <Field label="Uses per customer" hint="Empty means unlimited. Guests are counted by email.">
                      <Input type="number" min={1} {...form.register("usageLimitPerCustomer")} />
                    </Field>
                    {editing ? (
                      <dl>
                        <Detail label="Used so far">{formatNumber(promotion.timesUsed ?? 0)}</Detail>
                      </dl>
                    ) : null}
                  </CardContent>
                </Card>
              </>
            }
          />
        </fieldset>
        {write && (dirty || !editing) ? (
          <SaveBar
            status={dirty ? "Unsaved changes" : "Not saved yet"}
            problem={toFix}
            saving={save.isPending}
            onSave={() => void submit()}
            onDiscard={editing && dirty ? discard : undefined}
            saveLabel={editing ? "Save" : "Create promotion"}
          />
        ) : null}
      </form>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${promotion?.name ?? "promotion"}?`}
        description="Its coupon codes stop working immediately. Orders that already used it keep their discount."
        destructive
        confirmLabel="Delete promotion"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
      {unsaved.dialog}
    </Page>
  );
};

/** Marks a discount field with a problem, so Save can go to it. */
const fieldProblem = (problems: RuleProblems, key: string) => {
  const message = problems.get(key);
  return { message, marks: { "data-rule-key": key, "aria-invalid": message ? true : undefined } as const };
};

const ActionFields = ({
  action,
  onChange,
  currencies,
  methodOptions,
  methodsAvailable,
  problems,
}: {
  action: ActionState;
  onChange: (action: ActionState) => void;
  currencies: readonly string[];
  methodOptions: { value: string; label: string; hint?: string }[];
  methodsAvailable: boolean;
  problems: RuleProblems;
}) => {
  const percentProblem = fieldProblem(problems, ACTION_FIELDS.percent);
  const amountsProblem = problems.get(ACTION_FIELDS.amounts);
  const quantitiesProblem = fieldProblem(problems, ACTION_FIELDS.quantities);
  switch (action.kind) {
    case "percentageOff":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Percentage off" error={percentProblem.message}>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" className="w-28" value={action.percent} onChange={(e) => onChange({ ...action, percent: e.target.value })} aria-label="Percentage off" {...percentProblem.marks} />
              <span className="text-muted-foreground">%</span>
            </div>
          </Field>
          <Field label="Maximum discount" hint="Optional cap per order, per currency.">
            <MoneyByCurrencyInput value={action.maxDiscount} onChange={(maxDiscount) => onChange({ ...action, maxDiscount })} currencies={currencies} />
          </Field>
        </div>
      );
    case "fixedOffEach":
    case "fixedOffCart":
      return (
        <Field label={action.kind === "fixedOffEach" ? "Amount off each item" : "Amount off the order"} hint="Per currency; carts in other currencies get no discount." error={amountsProblem}>
          <div data-rule-key={ACTION_FIELDS.amounts} data-invalid={amountsProblem ? "true" : undefined} className={cn("w-fit rounded-lg", amountsProblem && "p-2 ring-1 ring-destructive")}>
            <MoneyByCurrencyInput value={action.amounts} onChange={(amounts) => onChange({ ...action, amounts })} currencies={currencies} />
          </div>
        </Field>
      );
    case "buyXGetY":
      return (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Buy" error={quantitiesProblem.message}>
            <Input type="number" min={1} value={Number.isNaN(action.buyQuantity) ? "" : action.buyQuantity} onChange={(e) => onChange({ ...action, buyQuantity: Math.max(1, Math.floor(Number(e.target.value))) })} {...quantitiesProblem.marks} />
          </Field>
          <Field label="Get">
            <Input type="number" min={1} value={Number.isNaN(action.getQuantity) ? "" : action.getQuantity} onChange={(e) => onChange({ ...action, getQuantity: Math.max(1, Math.floor(Number(e.target.value))) })} aria-invalid={quantitiesProblem.message ? true : undefined} />
          </Field>
          <Field label="Discount on those" hint="100% makes them free." error={percentProblem.message}>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" value={action.percent} onChange={(e) => onChange({ ...action, percent: e.target.value })} aria-label="Discount on those, in percent" {...percentProblem.marks} />
              <span className="text-muted-foreground">%</span>
            </div>
          </Field>
        </div>
      );
    case "shippingOff":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shipping discount" hint="100% means free shipping." error={percentProblem.message}>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" className="w-28" value={action.percent} onChange={(e) => onChange({ ...action, percent: e.target.value })} aria-label="Shipping discount, in percent" {...percentProblem.marks} />
              <span className="text-muted-foreground">%</span>
            </div>
          </Field>
          <Field label="Shipping methods" hint="Empty means every method.">
            {methodsAvailable && methodOptions.length ? (
              <MultiSelect options={methodOptions} value={action.methodCodes} onChange={(methodCodes) => onChange({ ...action, methodCodes })} placeholder="Every method" />
            ) : (
              <TagInput value={action.methodCodes} onChange={(methodCodes) => onChange({ ...action, methodCodes })} placeholder="Method codes, e.g. us_standard" />
            )}
          </Field>
        </div>
      );
  }
};

// ---------------------------------------------------------------- coupons

const COUPON_PAGE = 100;

const CouponsCard = ({ promotion, write }: { promotion: Promotion; write: boolean }) => {
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const coupons = promotion.coupons ?? [];
  const shown = coupons.filter((c) => !filter || (c.code ?? "").includes(filter.trim().toUpperCase()));
  const visible = shown.slice(0, COUPON_PAGE);
  const visibleIds = visible.flatMap((c) => (c.id ? [c.id] : []));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["promotion", promotion.id] });

  const add = useAction(() => request(UpdateMutation, { id: promotion.id, input: { couponCodes: codes } }).then((r) => unwrap(r.promotionUpdate)), {
    success: `Added ${codes.length} code${codes.length === 1 ? "" : "s"}`,
    onSuccess: () => {
      setCodes([]);
      void refresh();
    },
  });

  const remove = useAction((ids: string[]) => request(DeleteCouponsMutation, { ids }).then((r) => unwrap(r.couponsDelete)), {
    success: (r) => `Deleted ${r.deletedIds?.length ?? 0} code${r.deletedIds?.length === 1 ? "" : "s"}`,
    onSuccess: (r) => {
      setSelected((current) => {
        const next = new Set(current);
        for (const id of r.deletedIds ?? []) next.delete(id);
        return next;
      });
      setDeleting(null);
      void refresh();
    },
  });

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const deletingCode = deleting?.length === 1 ? coupons.find((c) => c.id === deleting[0])?.code : null;

  const exportCodes = () =>
    downloadText(
      `coupons-${(promotion.name ?? "promotion").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
      toCsv([["code", "times_used", "usage_limit", "expires_at"], ...coupons.map((c) => [c.code, c.timesUsed, c.usageLimit, c.expiresAt])]),
    );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <Ticket className="size-4 text-muted-foreground" /> Coupon codes
          </CardTitle>
          <CardDescription>
            {coupons.length} code{coupons.length === 1 ? "" : "s"} · {formatNumber(coupons.reduce((n, c) => n + (c.timesUsed ?? 0), 0))} uses
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {write && selected.size ? (
            <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting([...selected])}>
              <Trash2 />
              Delete {selected.size}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={!coupons.length} onClick={exportCodes}>
            <Download />
            Export
          </Button>
          {write ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setGenerating(true)}>
              <Sparkles />
              Generate
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {write ? (
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-64 flex-1">
              <TagInput value={codes} onChange={setCodes} uppercase placeholder="Add codes: type and press Enter, or paste a list" />
            </div>
            <Button type="button" size="sm" className="mt-0.5" disabled={!codes.length} loading={add.isPending} onClick={() => add.mutate(undefined)}>
              Add codes
            </Button>
          </div>
        ) : null}
        {coupons.length > 10 ? <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a code" className="h-8 max-w-xs" /> : null}
        {coupons.length === 0 ? (
          <Alert variant="warning">This promotion needs a coupon but has no codes yet, so nobody can use it.</Alert>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {write ? (
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all shown codes"
                        checked={allVisibleSelected ? true : visibleIds.some((id) => selected.has(id)) ? "indeterminate" : false}
                        onCheckedChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            for (const id of visibleIds) {
                              if (allVisibleSelected) next.delete(id);
                              else next.add(id);
                            }
                            return next;
                          })
                        }
                      />
                    </TableHead>
                  ) : null}
                  <TableHead>Code</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead>Expires</TableHead>
                  {write ? <TableHead className="w-10" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((c) => (
                  <TableRow key={c.id ?? c.code} className="hover:bg-transparent" data-state={c.id && selected.has(c.id) ? "selected" : undefined}>
                    {write ? (
                      <TableCell>
                        <Checkbox aria-label={`Select ${c.code}`} checked={!!c.id && selected.has(c.id)} disabled={!c.id} onCheckedChange={() => c.id && toggle(c.id)} />
                      </TableCell>
                    ) : null}
                    <TableCell className="font-mono text-[13px]">{c.code}</TableCell>
                    <TableCell className="tabular text-right">
                      {c.usageLimit ? `${c.timesUsed} / ${c.usageLimit}` : c.timesUsed}
                      {c.usageLimit && (c.timesUsed ?? 0) >= c.usageLimit ? (
                        <Badge variant="secondary" className="ml-2">
                          Used up
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.expiresAt ? formatDateTime(c.expiresAt) : "Never"}</TableCell>
                    {write ? (
                      <TableCell className="text-right">
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${c.code}`} disabled={!c.id} onClick={() => c.id && setDeleting([c.id])}>
                          <Trash2 />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {shown.length > COUPON_PAGE ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing {COUPON_PAGE} of {shown.length}. Export to see every code.</p> : null}
          </div>
        )}
      </CardContent>
      {generating ? <GenerateDialog promotion={promotion} onClose={() => setGenerating(false)} onDone={refresh} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deletingCode ? `Delete code ${deletingCode}?` : `Delete ${deleting?.length ?? 0} codes?`}
        description="Shoppers can no longer use them. Orders that already used a code keep it."
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
};

type GenerateForm = { quantity: string; prefix: string; length: string; usageLimit: string; expiresAt: string };

const GenerateDialog = ({ promotion, onClose, onDone }: { promotion: Promotion; onClose: () => void; onDone: () => Promise<unknown> }) => {
  const form = useForm<GenerateForm>({ defaultValues: { quantity: "100", prefix: "", length: "10", usageLimit: "1", expiresAt: "" } });
  const generate = useAction(
    (v: GenerateForm) =>
      request(GenerateMutation, {
        promotionId: promotion.id,
        quantity: Math.floor(Number(v.quantity)),
        prefix: v.prefix.trim().toUpperCase() || null,
        length: Math.floor(Number(v.length)) || null,
        usageLimit: v.usageLimit.trim() ? Math.floor(Number(v.usageLimit)) : null,
        expiresAt: fromLocalInput(v.expiresAt),
      }).then((r) => unwrap(r.couponsGenerate)),
    {
      success: (r) => `Generated ${r.coupons?.length ?? 0} codes`,
      onSuccess: () => {
        onClose();
        void onDone();
      },
      onError: (error) => reportError(error, form, []),
    },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>Generate coupon codes</DialogTitle>
          <DialogDescription>Unique random codes for this promotion, e.g. for a newsletter or influencer campaign.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => generate.mutate(v))} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="How many" required hint="Up to 10,000 at a time." error={form.formState.errors.quantity?.message}>
              <Input type="number" min={1} max={10000} {...form.register("quantity", { required: "Required", validate: (v) => (Number(v) >= 1 && Number(v) <= 10000) || "Between 1 and 10,000" })} />
            </Field>
            <Field label="Prefix" hint="e.g. VIP- gives VIP-7KQ2…">
              <Input className="font-mono uppercase" {...form.register("prefix")} />
            </Field>
            <Field label="Random characters" hint="6 to 32.">
              <Input type="number" min={6} max={32} {...form.register("length")} />
            </Field>
            <Field label="Uses per code" hint="Empty means unlimited.">
              <Input type="number" min={1} {...form.register("usageLimit")} />
            </Field>
            <Field label="Expires" className="sm:col-span-2" hint="Empty means the codes never expire.">
              <Input type="datetime-local" {...form.register("expiresAt")} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={generate.isPending}>
              <Sparkles />
              Generate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
