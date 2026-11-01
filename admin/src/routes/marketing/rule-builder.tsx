import { useQuery } from "@tanstack/react-query";
import { Layers, Plus, Search, Trash2, X } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { CountryMultiSelect, MoneyByCurrencyInput } from "@/components/inputs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { graphql } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { countryName } from "@/lib/format";
import { useDebounced, useReference } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { emptyCondition, emptyPredicate, OPERATORS, type Condition, type Names, type Operator, type Predicate } from "./promotion-rules";

// ---------------------------------------------------------------- reference data for rules

const RuleDataQuery = graphql(`
  query RuleData {
    categories {
      id
      name
      parent {
        id
      }
    }
    attributeDefinitions {
      code
      label
      type
      options {
        code
        label
      }
    }
  }
`);

const ProductNamesQuery = graphql(`
  query RuleProductNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        name
      }
    }
  }
`);

const ProductSearchQuery = graphql(`
  query RuleProductSearch($q: String) {
    products(query: $q, first: 12) {
      edges {
        node {
          id
          name
          status
        }
      }
    }
  }
`);

type CategoryRow = { id: string; name: string | null; parent: { id: string } | null };

/** Breadcrumb labels for `categories`, which lists parents before their children. */
const withBreadcrumbs = (rows: readonly CategoryRow[] | null | undefined): { id: string; label: string }[] => {
  const labels = new Map<string, string>();
  return (rows ?? []).map((row) => {
    const parent = row.parent ? labels.get(row.parent.id) : undefined;
    const label = parent ? `${parent} / ${row.name ?? "?"}` : (row.name ?? "?");
    labels.set(row.id, label);
    return { id: row.id, label };
  });
};

const collectProductIds = (conditions: Condition[], extra: (Predicate | null)[]) => {
  const ids = new Set<string>();
  const fromPredicate = (p: Predicate | null) => {
    if (!p) return;
    if (p.kind === "product") p.productIds.forEach((id) => ids.add(id));
    if (p.kind === "all" || p.kind === "any") p.children.forEach(fromPredicate);
  };
  const fromCondition = (c: Condition) => {
    if (c.kind === "all" || c.kind === "any" || c.kind === "none") c.children.forEach(fromCondition);
    if (c.kind === "lines") fromPredicate(c.predicate);
  };
  conditions.forEach(fromCondition);
  extra.forEach(fromPredicate);
  return [...ids].sort();
};

/** Reference data for the builder's pickers, plus a name resolver for summaries. */
export const useRuleData = (root: Condition, target: Predicate | null) => {
  const { customerGroups } = useReference();
  const data = useQuery({ queryKey: ["rule-data"], queryFn: () => request(RuleDataQuery), staleTime: 5 * 60_000 });
  const productIds = collectProductIds([root], [target]);
  const products = useQuery({ queryKey: ["rule-products", productIds], queryFn: () => request(ProductNamesQuery, { ids: productIds }), enabled: productIds.length > 0, staleTime: 5 * 60_000 });
  return useMemo(() => {
    const categories = withBreadcrumbs(data.data?.categories);
    const attributes = (data.data?.attributeDefinitions ?? []).map((a) => ({ code: a.code ?? "", label: a.label ?? a.code ?? "", type: a.type, options: (a.options ?? []).map((o) => ({ value: o.code ?? "", label: o.label ?? o.code ?? "" })) }));
    const productNames = new Map<string, string>();
    for (const node of products.data?.nodes ?? []) if (node && "name" in node && node.id) productNames.set(node.id, node.name ?? node.id);
    const names: Names = {
      product: (id) => productNames.get(id) ?? "a product",
      category: (id) => categories.find((c) => c.id === id)?.label ?? "a category",
      group: (id) => customerGroups.find((g) => g.id === id)?.name ?? "a group",
      attribute: (code) => attributes.find((a) => a.code === code)?.label ?? code,
      country: (code) => countryName(code),
    };
    return { categories, attributes, productNames, groups: customerGroups, names };
  }, [data.data, products.data, customerGroups]);
};

export type RuleData = ReturnType<typeof useRuleData>;

// ---------------------------------------------------------------- small inputs

/** Free-form values as chips: Enter, comma or a pasted list adds them. */
export const TagInput = ({ value, onChange, placeholder, uppercase, invalid }: { value: string[]; onChange: (value: string[]) => void; placeholder?: string; uppercase?: boolean; invalid?: boolean }) => {
  const [draft, setDraft] = useState("");
  const add = (text: string) => {
    const items = text
      .split(/[\n,;]+/)
      .map((t) => (uppercase ? t.trim().toUpperCase() : t.trim()))
      .filter(Boolean);
    if (items.length) onChange([...new Set([...value, ...items])]);
    setDraft("");
  };
  return (
    <div className={cn("flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40 dark:bg-input/30", invalid && "border-destructive")}>
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="rounded-md pr-1 font-mono">
          {tag}
          <button type="button" aria-label={`Remove ${tag}`} className="rounded-sm opacity-60 hover:opacity-100" onClick={() => onChange(value.filter((t) => t !== tag))}>
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[\n,;]/.test(text)) {
            e.preventDefault();
            add(text);
          }
        }}
        onBlur={() => draft && add(draft)}
        placeholder={value.length ? "" : placeholder}
        className="min-w-24 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
};

export const ProductPicker = ({ value, onChange, names }: { value: string[]; onChange: (value: string[]) => void; names: Map<string, string> }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 200);
  const search = useQuery({ queryKey: ["rule-product-search", q], queryFn: () => request(ProductSearchQuery, { q: q || null }), enabled: open, staleTime: 30_000 });
  const results = (search.data?.products?.edges ?? []).flatMap((e) => (e?.node ? [e.node] : []));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((id) => (
        <Badge key={id} variant="secondary" className="rounded-md pr-1">
          {names.get(id) ?? "Loading…"}
          <button type="button" aria-label="Remove product" className="rounded-sm opacity-60 hover:opacity-100" onClick={() => onChange(value.filter((v) => v !== id))}>
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Search />
            {value.length ? "Add product" : "Choose products"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search by name or SKU…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{search.isFetching ? "Searching…" : "No products found."}</CommandEmpty>
              <CommandGroup>
                {results.map((p) => (
                  <CommandItem key={p.id} value={p.id} onSelect={() => onChange(value.includes(p.id) ? value.filter((v) => v !== p.id) : [...value, p.id])}>
                    <span className={cn("size-2 rounded-full", value.includes(p.id) ? "bg-primary" : "bg-transparent ring-1 ring-border")} />
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{p.status?.toLowerCase()}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
};

const OperatorSelect = ({ value, onChange }: { value: Operator; onChange: (value: Operator) => void }) => (
  <NativeSelect className="w-32" value={value} onChange={(e) => onChange(e.target.value as Operator)} aria-label="Comparison">
    {OPERATORS.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </NativeSelect>
);

const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <Button type="button" variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} className="shrink-0 text-muted-foreground hover:text-destructive">
    <Trash2 />
  </Button>
);

/** Problem messages by row key. */
export type RuleProblems = ReadonlyMap<string, string>;

/** Shown under a row, whose container carries data-invalid so Save can go to it. */
const ProblemText = ({ id, problem }: { id: string; problem: string | undefined }) =>
  problem ? (
    <p id={id} className="text-xs text-destructive">
      {problem}
    </p>
  ) : null;

const Leaf = ({ ruleKey, problem, title, children, onRemove }: { ruleKey: string; problem?: string; title: ReactNode; children: ReactNode; onRemove?: () => void }) => {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={problem ? `${id}-problem` : undefined}
      data-rule-key={ruleKey}
      data-invalid={problem ? "true" : undefined}
      className={cn("flex items-start gap-3 rounded-lg border bg-background p-3", problem && "border-destructive ring-1 ring-destructive/20")}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p id={`${id}-title`} className="text-[13px] font-medium">
          {title}
        </p>
        {children}
        <ProblemText id={`${id}-problem`} problem={problem} />
      </div>
      {onRemove ? <RemoveButton onClick={onRemove} label="Remove condition" /> : null}
    </div>
  );
};

// ---------------------------------------------------------------- line predicates

const PREDICATE_KINDS: { kind: Predicate["kind"]; label: string }[] = [
  { kind: "category", label: "In category" },
  { kind: "product", label: "Is product" },
  { kind: "sku", label: "SKU is" },
  { kind: "attribute", label: "Attribute is" },
  { kind: "all", label: "Group: all of" },
  { kind: "any", label: "Group: any of" },
];

/** Which cart lines a condition or action looks at. */
export const PredicateEditor = ({
  value,
  onChange,
  onRemove,
  data,
  depth = 0,
  problems,
}: {
  value: Predicate;
  onChange: (value: Predicate) => void;
  onRemove?: () => void;
  data: RuleData;
  depth?: number;
  problems?: RuleProblems;
}) => {
  const id = useId();
  const problem = problems?.get(value.key);
  switch (value.kind) {
    case "all":
    case "any":
      return (
        <div
          role="group"
          aria-label={value.kind === "all" ? "Items matching all of" : "Items matching any of"}
          aria-describedby={problem ? id : undefined}
          data-rule-key={value.key}
          data-invalid={problem ? "true" : undefined}
          className={cn("flex flex-col gap-2 rounded-lg border border-dashed p-3", depth % 2 ? "bg-muted/30" : "bg-background", problem && "border-destructive ring-1 ring-destructive/20")}
        >
          <div className="flex items-center gap-2">
            <NativeSelect className="w-44" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as "all" | "any" })} aria-label="Item group">
              <option value="all">Items matching all of</option>
              <option value="any">Items matching any of</option>
            </NativeSelect>
            <AddPredicate depth={depth} focusOnProblem={!!problem} onAdd={(p) => onChange({ ...value, children: [...value.children, p] })} />
            {onRemove ? <RemoveButton onClick={onRemove} label="Remove item group" /> : null}
          </div>
          {problem ? <ProblemText id={id} problem={problem} /> : value.children.length === 0 ? <p className="text-xs text-muted-foreground">Add at least one filter.</p> : null}
          {value.children.map((child, i) => (
            <PredicateEditor
              key={child.key}
              value={child}
              data={data}
              depth={depth + 1}
              problems={problems}
              onChange={(next) => onChange({ ...value, children: value.children.map((c, j) => (j === i ? next : c)) })}
              onRemove={() => onChange({ ...value, children: value.children.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      );
    case "sku":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="SKU is one of" onRemove={onRemove}>
          <TagInput value={value.skus} onChange={(skus) => onChange({ ...value, skus })} placeholder="Type a SKU and press Enter, or paste a list" invalid={!value.skus.length} />
        </Leaf>
      );
    case "product":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Product is one of" onRemove={onRemove}>
          <ProductPicker value={value.productIds} onChange={(productIds) => onChange({ ...value, productIds })} names={data.productNames} />
        </Leaf>
      );
    case "category":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="In category (subcategories included)" onRemove={onRemove}>
          <MultiSelect options={data.categories.map((c) => ({ value: c.id, label: c.label }))} value={value.categoryIds} onChange={(categoryIds) => onChange({ ...value, categoryIds })} placeholder="Choose categories" searchPlaceholder="Search categories…" />
        </Leaf>
      );
    case "attribute": {
      const definition = data.attributes.find((a) => a.code === value.code);
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Attribute has value" onRemove={onRemove}>
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <NativeSelect value={value.code} onChange={(e) => onChange({ ...value, code: e.target.value, values: [] })} aria-label="Attribute" aria-invalid={problem && !value.code ? true : undefined}>
              <option value="">Choose attribute…</option>
              {data.attributes.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.label}
                </option>
              ))}
            </NativeSelect>
            <div className="min-w-0" data-problem-focus={problem && value.code ? "" : undefined}>
              {definition?.options.length ? (
                <MultiSelect options={definition.options} value={value.values} onChange={(values) => onChange({ ...value, values })} placeholder="Choose values" />
              ) : (
                <TagInput value={value.values} onChange={(values) => onChange({ ...value, values })} placeholder={definition?.type === "BOOLEAN" ? "true or false" : "Values, e.g. cotton"} invalid={!!value.code && !value.values.length} />
              )}
            </div>
          </div>
        </Leaf>
      );
    }
  }
};

/** `focusOnProblem` makes it the control Save goes to when its group is empty. */
const AddPredicate = ({ onAdd, depth, focusOnProblem }: { onAdd: (p: Predicate) => void; depth: number; focusOnProblem?: boolean }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="outline" size="sm" data-problem-focus={focusOnProblem ? "" : undefined}>
        <Plus />
        Add filter
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      {PREDICATE_KINDS.filter((k) => depth < 2 || (k.kind !== "all" && k.kind !== "any")).map((k) => (
        <DropdownMenuItem key={k.kind} onSelect={() => onAdd(emptyPredicate(k.kind))}>
          {k.kind === "all" || k.kind === "any" ? <Layers /> : null}
          {k.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

// ---------------------------------------------------------------- conditions

const CONDITION_KINDS: { kind: Condition["kind"]; label: string; hint: string }[] = [
  { kind: "subtotal", label: "Subtotal", hint: "Cart subtotal after line discounts" },
  { kind: "quantity", label: "Item quantity", hint: "Total units in the cart" },
  { kind: "lines", label: "Cart contains…", hint: "Products, categories, SKUs or attributes" },
  { kind: "country", label: "Shipping country", hint: "Where the order ships" },
  { kind: "group", label: "Customer group", hint: "The shopper's group" },
  { kind: "all", label: "Group: all of", hint: "Nested conditions that must all hold" },
  { kind: "any", label: "Group: any of", hint: "Nested conditions of which one must hold" },
  { kind: "none", label: "Group: none of", hint: "Nested conditions that must not hold" },
];

const GROUP_LABEL = { all: "All of these are true", any: "Any of these is true", none: "None of these is true" } as const;

/** One node of the condition tree: a group of conditions or a single test. */
export const ConditionEditor = ({
  value,
  onChange,
  onRemove,
  data,
  currencies,
  depth = 0,
  problems,
}: {
  value: Condition;
  onChange: (value: Condition) => void;
  onRemove?: () => void;
  data: RuleData;
  currencies: readonly string[];
  depth?: number;
  problems?: RuleProblems;
}) => {
  const id = useId();
  const problem = problems?.get(value.key);
  switch (value.kind) {
    case "all":
    case "any":
    case "none":
      return (
        <div
          role="group"
          aria-label={GROUP_LABEL[value.kind]}
          aria-describedby={problem ? id : undefined}
          data-rule-key={value.key}
          data-invalid={problem ? "true" : undefined}
          className={cn("flex flex-col gap-2.5 rounded-xl border p-3", depth === 0 ? "bg-muted/30" : depth % 2 ? "bg-background" : "bg-muted/30", problem && "border-destructive ring-1 ring-destructive/20")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect className="w-52" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as "all" | "any" | "none" })} aria-label="Condition group">
              {(Object.keys(GROUP_LABEL) as (keyof typeof GROUP_LABEL)[]).map((k) => (
                <option key={k} value={k}>
                  {GROUP_LABEL[k]}
                </option>
              ))}
            </NativeSelect>
            <AddCondition depth={depth} focusOnProblem={!!problem} onAdd={(kind) => onChange({ ...value, children: [...value.children, emptyCondition(kind, currencies)] })} />
            {onRemove ? <RemoveButton onClick={onRemove} label="Remove condition group" /> : null}
          </div>
          {problem ? (
            <div className="px-1">
              <ProblemText id={id} problem={problem} />
            </div>
          ) : value.children.length === 0 ? (
            <p className="px-1 text-[13px] text-muted-foreground">{depth === 0 ? "No conditions: the promotion applies to every cart in its channels and groups." : "Empty group."}</p>
          ) : null}
          {value.children.map((child, i) => (
            <ConditionEditor
              key={child.key}
              value={child}
              data={data}
              currencies={currencies}
              depth={depth + 1}
              problems={problems}
              onChange={(next) => onChange({ ...value, children: value.children.map((c, j) => (j === i ? next : c)) })}
              onRemove={() => onChange({ ...value, children: value.children.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      );
    case "subtotal":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Subtotal" onRemove={onRemove}>
          <div className="flex flex-wrap items-start gap-2">
            <OperatorSelect value={value.operator} onChange={(operator) => onChange({ ...value, operator })} />
            <div data-problem-focus="">
              <MoneyByCurrencyInput value={value.amounts} onChange={(amounts) => onChange({ ...value, amounts })} currencies={currencies} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Carts in a currency without an amount never match.</p>
        </Leaf>
      );
    case "quantity":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Number of items" onRemove={onRemove}>
          <div className="flex items-center gap-2">
            <OperatorSelect value={value.operator} onChange={(operator) => onChange({ ...value, operator })} />
            <Input type="number" min={0} className="w-24" value={Number.isNaN(value.value) ? "" : value.value} aria-invalid={problem ? true : undefined} aria-label="Number of units" onChange={(e) => onChange({ ...value, value: Math.max(0, Math.floor(Number(e.target.value))) })} />
            <span className="text-[13px] text-muted-foreground">units</span>
          </div>
        </Leaf>
      );
    case "lines":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Cart contains" onRemove={onRemove}>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">At least</span>
            <Input type="number" min={1} className="h-8 w-20" value={value.minQuantity} aria-label="Minimum units" onChange={(e) => onChange({ ...value, minQuantity: Math.max(1, Math.floor(Number(e.target.value))) })} />
            <span className="text-muted-foreground">unit(s) of items where</span>
          </div>
          <PredicateEditor value={value.predicate} onChange={(predicate) => onChange({ ...value, predicate })} data={data} problems={problems} />
          {value.predicate.kind !== "all" && value.predicate.kind !== "any" ? (
            <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => onChange({ ...value, predicate: { ...emptyPredicate("all"), children: [value.predicate] } as Predicate })}>
              Combine with more item filters
            </button>
          ) : null}
        </Leaf>
      );
    case "country":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Ships to" onRemove={onRemove}>
          <CountryMultiSelect value={value.countries} onChange={(countries) => onChange({ ...value, countries })} placeholder="Choose countries" />
        </Leaf>
      );
    case "group":
      return (
        <Leaf ruleKey={value.key} problem={problem} title="Customer is in group" onRemove={onRemove}>
          <MultiSelect options={data.groups.map((g) => ({ value: g.id, label: g.name ?? g.code ?? "" }))} value={value.groupIds} onChange={(groupIds) => onChange({ ...value, groupIds })} placeholder="Choose groups" />
        </Leaf>
      );
  }
};

/** `focusOnProblem` makes it the control Save goes to when its group needs a condition. */
const AddCondition = ({ onAdd, depth, focusOnProblem }: { onAdd: (kind: Condition["kind"]) => void; depth: number; focusOnProblem?: boolean }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="outline" size="sm" data-problem-focus={focusOnProblem ? "" : undefined}>
        <Plus />
        Add condition
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-64">
      {CONDITION_KINDS.filter((k) => depth < 2 || !["all", "any", "none"].includes(k.kind)).map((k) => (
        <DropdownMenuItem key={k.kind} onSelect={() => onAdd(k.kind)} className="flex-col items-start gap-0">
          <span>{k.label}</span>
          <span className="text-xs text-muted-foreground">{k.hint}</span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
