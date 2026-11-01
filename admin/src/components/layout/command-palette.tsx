import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command as CommandPrimitive, defaultFilter } from "cmdk";
import { LayoutTemplate, Loader2, LogOut, Monitor, Moon, Package, Receipt, Sun, User } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/overlay";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { setTheme } from "@/lib/theme";
import { QUICK_ACTIONS, useNav } from "./nav";

const SearchQuery = graphql(`
  query GlobalSearch($q: String!, $products: Boolean!, $orders: Boolean!, $customers: Boolean!, $pages: Boolean!) {
    pages(query: $q, first: 5) @include(if: $pages) {
      edges {
        node {
          id
          title
          path
          status
        }
      }
    }
    products(query: $q, first: 5) @include(if: $products) {
      edges {
        node {
          id
          name
          status
        }
      }
    }
    orders(first: 5, filter: { query: $q }) @include(if: $orders) {
      edges {
        node {
          id
          number
          email
          totals {
            total {
              formatted
            }
          }
        }
      }
    }
    customers(query: $q, first: 5) @include(if: $customers) {
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

type SearchResult = ResultOf<typeof SearchQuery>;

const hasResults = (data: SearchResult) => [data.pages, data.products, data.orders, data.customers].some((list) => !!list?.edges?.length);

/**
 * "1042" or "#1042": an order number without channel prefix and padding, of 3+ digits so "10" stays
 * a search. Letter prefixes are left to the search, since SKUs look like that too (GIFT-50).
 */
const ORDER_NUMBER = /^#?(\d{3,})$/;

/** The orders among the results whose number ends in the digits typed ("US-001042" for "1042"). */
const exactOrders = (data: SearchResult | undefined, digits: string) =>
  (data?.orders?.edges ?? []).flatMap((edge) => {
    const number = edge?.node?.number;
    const ending = number ? /(\d+)$/.exec(number)?.[1] : undefined;
    return number && ending && Number(ending) === Number(digits) ? [number] : [];
  });

const useDebounced = <T,>(value: T, ms = 200) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
};

/** One row: cmdk matches the typed text against `value` and then `keywords`. */
type Entry = { key: string; value: string; keywords?: string[]; onSelect: () => void; children: ReactNode };
type Section = { key: string; heading: string; entries: Entry[] };

/**
 * ⌘K: screens, actions and search results, ranked together. Screens match by name before keywords
 * ("inv" is Inventory); results match the text the server found them by, even a hidden SKU or
 * email. An order number gets "Open order" at the top at once.
 */
export const CommandPalette = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can, signOut } = useAuth();
  const nav = useNav();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const q = useDebounced(typed);
  const searchFor = (term: string, signal?: AbortSignal) =>
    request(SearchQuery, { q: term, products: can("catalog:read"), orders: can("orders:read"), customers: can("customers:read"), pages: can("content:read") }, { signal });
  const search = useQuery({
    queryKey: ["global-search", q],
    enabled: open && q.length >= 2,
    queryFn: ({ signal }) => searchFor(q, signal),
    staleTime: 10_000,
  });
  // The text typed hasn't been sent yet, or its results aren't back.
  const searching = open && typed.length >= 2 && (typed !== q || search.isFetching);

  // cmdk keeps its highlighted pick when results arrive, leaving a weak match above better ones,
  // so each new set of results resets the highlight to the best match.
  const [selected, setSelected] = useState("");
  const [seen, setSeen] = useState<SearchResult>();
  if (search.data && search.data !== seen) {
    setSeen(search.data);
    if (hasResults(search.data)) setSelected("");
  }

  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelected("");
  }, [open]);

  const go = (to: string) => {
    onOpenChange(false);
    // Targets may carry a query (e.g. /pages?new=page); the router takes it as search params.
    const url = new URL(to, window.location.origin);
    void navigate({ to: url.pathname, search: Object.fromEntries(url.searchParams) });
  };

  const data = search.data;
  const orderDigits = can("orders:read") ? (ORDER_NUMBER.exec(typed)?.[1] ?? null) : null;
  const exact = orderDigits && q === typed ? exactOrders(data, orderDigits) : [];

  /**
   * Opens the order whose number ends in `digits`, matched here since numbers carry a channel
   * prefix and padding ("US-001042"). Otherwise opens the orders list filtered by the digits.
   */
  const openOrder = async (digits: string) => {
    onOpenChange(false);
    let numbers = exact;
    if (!numbers.length) {
      try {
        numbers = exactOrders(await queryClient.fetchQuery({ queryKey: ["global-search", digits], queryFn: ({ signal }) => searchFor(digits, signal), staleTime: 10_000 }), digits);
      } catch {
        numbers = [];
      }
    }
    if (numbers.length === 1) void navigate({ to: "/orders/$number", params: { number: numbers[0]! } });
    else void navigate({ to: "/orders", search: { q: digits } });
  };

  // ---------------------------------------------------------------- rows

  const sections: Section[] = [
    {
      key: "actions",
      heading: "Actions",
      entries: QUICK_ACTIONS.filter((a) => can(a.permission)).map((action) => ({
        key: action.to,
        value: action.label,
        keywords: ["action"],
        onSelect: () => go(action.to),
        children: (
          <>
            <action.icon />
            {action.label}
          </>
        ),
      })),
    },
    ...nav.map((group) => ({
      key: group.label || "home",
      heading: group.label || "Go to",
      entries: group.items
        .filter((item) => can(item.permission))
        .map((item) => ({
          key: item.to,
          value: item.label,
          keywords: ["go", group.label, ...(item.keywords?.split(" ") ?? [])].filter(Boolean),
          onSelect: () => go(item.to),
          children: (
            <>
              <item.icon />
              {item.label}
            </>
          ),
        })),
    })),
    {
      key: "preferences",
      heading: "Preferences",
      entries: [
        ...(
          [
            ["light", Sun, "Light theme"],
            ["dark", Moon, "Dark theme"],
            ["system", Monitor, "System theme"],
          ] as const
        ).map(([theme, Icon, label]) => ({
          key: theme,
          value: label,
          keywords: ["appearance", "mode"],
          onSelect: () => setTheme(theme),
          children: (
            <>
              <Icon />
              {label}
            </>
          ),
        })),
        {
          key: "account",
          value: "Your account",
          keywords: ["profile", "password", "two-factor"],
          onSelect: () => go("/account"),
          children: (
            <>
              <User />
              Your account
            </>
          ),
        },
        {
          key: "sign-out",
          value: "Sign out",
          keywords: ["logout", "log out"],
          onSelect: () => {
            onOpenChange(false);
            void signOut();
          },
          children: (
            <>
              <LogOut />
              Sign out
            </>
          ),
        },
      ],
    },
  ].filter((section) => section.entries.length);

  // Results match the text they were found by (`q`). Keyed by it because cmdk reads keywords only
  // when a row first registers.
  const result = (id: string, value: string, onSelect: () => void, children: ReactNode): Entry => ({ key: `${q}:${id}`, value, keywords: [q], onSelect, children });
  const results: Section[] = [
    {
      key: "orders",
      heading: "Orders",
      entries: (data?.orders?.edges ?? []).flatMap((edge) => {
        const order = edge?.node;
        return order
          ? [
              result(
                order.id,
                `order ${order.number} ${order.email ?? ""}`,
                () => go(`/orders/${order.number}`),
                <>
                  <Receipt />
                  <span className="font-medium">{order.number}</span>
                  <span className="flex-1 truncate text-muted-foreground">{order.email}</span>
                  <span className="tabular text-xs text-muted-foreground">{order.totals?.total?.formatted}</span>
                </>,
              ),
            ]
          : [];
      }),
    },
    {
      key: "products",
      heading: "Products",
      entries: (data?.products?.edges ?? []).flatMap((edge) => {
        const product = edge?.node;
        return product
          ? [
              result(
                product.id,
                `product ${product.name} ${product.id}`,
                () => go(`/products/${encodeURIComponent(product.id)}`),
                <>
                  <Package />
                  <span className="flex-1 truncate">{product.name}</span>
                  <span className="text-xs text-muted-foreground">{product.status?.toLowerCase()}</span>
                </>,
              ),
            ]
          : [];
      }),
    },
    {
      key: "pages",
      heading: "Pages",
      entries: (data?.pages?.edges ?? []).flatMap((edge) => {
        const page = edge?.node;
        return page
          ? [
              result(
                page.id,
                `page ${page.title} ${page.path ?? ""}`,
                () => go(`/pages/${encodeURIComponent(page.id)}`),
                <>
                  <LayoutTemplate />
                  <span className="truncate">{page.title}</span>
                  <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{page.path}</span>
                  <span className="text-xs text-muted-foreground">{page.status?.toLowerCase()}</span>
                </>,
              ),
            ]
          : [];
      }),
    },
    {
      key: "customers",
      heading: "Customers",
      entries: (data?.customers?.edges ?? []).flatMap((edge) => {
        const customer = edge?.node;
        return customer
          ? [
              result(
                customer.id,
                `customer ${customer.email} ${customer.firstName} ${customer.lastName}`,
                () => go(`/customers/${encodeURIComponent(customer.id)}`),
                <>
                  <User />
                  <span>
                    {customer.firstName} {customer.lastName}
                  </span>
                  <span className="flex-1 truncate text-muted-foreground">{customer.email}</span>
                </>,
              ),
            ]
          : [];
      }),
    },
  ].filter((section) => section.entries.length);

  // cmdk 1.1 doesn't sort groups (its group sort looks for an attribute they lack) and highlights
  // the first row shown, so groups are ranked here by their best row with its scoring. Ties keep
  // screens and actions first.
  const filtering = typed !== "";
  const best = (section: Section) => Math.max(0, ...section.entries.map((entry) => defaultFilter(entry.value, query, entry.keywords)));
  const ordered = filtering
    ? [...sections, ...results]
        .map((section) => ({ section, score: best(section) }))
        .sort((a, b) => b.score - a.score)
        .map(({ section }) => section)
    : [...results, ...sections];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Command value={selected} onValueChange={setSelected} loop>
          <CommandInput placeholder="Search products, orders, customers, pages or jump to…" value={query} onValueChange={setQuery} />
          <CommandList>
            {searching ? null : <CommandEmpty>No results.</CommandEmpty>}
            {orderDigits ? (
              // First, in a group of its own. Its value follows the text, so its keywords do too.
              <CommandGroup value="open-order">
                <CommandItem value={`open order ${typed}`} keywords={[query]} onSelect={() => void openOrder(orderDigits)}>
                  <Receipt />
                  <span className="flex-1 truncate">
                    Open order <span className="font-medium">{exact.length === 1 ? exact[0] : orderDigits}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {ordered.map((section) => (
              <Fragment key={section.key}>
                <CommandGroup heading={section.heading}>
                  {section.entries.map((entry) => (
                    <CommandItem key={entry.key} value={entry.value} keywords={entry.keywords} onSelect={entry.onSelect}>
                      {entry.children}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {!filtering && section.key === "actions" ? <CommandSeparator /> : null}
              </Fragment>
            ))}
          </CommandList>
          {searching ? (
            <CommandPrimitive.Loading label="Searching" className="border-t px-3 py-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                Searching…
              </span>
            </CommandPrimitive.Loading>
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  );
};
