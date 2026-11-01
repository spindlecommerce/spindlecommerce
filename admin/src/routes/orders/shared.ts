import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { graphql, type VariablesOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import type { ListSearch } from "@/router";

// ---------------------------------------------------------------- what staff can do with an order

type LineQuantities = { quantity?: number | null; quantityFulfilled?: number | null; quantityCanceled?: number | null; quantityRefunded?: number | null };

/** Units of an order line still to ship. */
export const remaining = (line: LineQuantities) => (line.quantity ?? 0) - (line.quantityFulfilled ?? 0) - (line.quantityCanceled ?? 0) - (line.quantityRefunded ?? 0);

export type OrderAction = "capture" | "fulfill" | "cancel";

type OrderState = { status?: string | null; paymentStatus?: string | null; fulfillmentStatus?: string | null; canCancel?: boolean | null; lines?: readonly LineQuantities[] | null };

const CAPTURABLE = ["PENDING", "AUTHORIZED", "PARTIALLY_PAID"];
const NOT_CAPTURABLE: Record<string, string> = { PAID: "Already paid", PARTIALLY_REFUNDED: "Partly refunded", REFUNDED: "Refunded", VOIDED: "Payment voided" };

/** Why an order can't be captured, shipped or canceled, or null. Shared with the bulk actions. */
export const orderBlocker = (action: OrderAction, order: OrderState): string | null => {
  const closed = order.status === "OPEN" ? null : order.status === "CANCELED" ? "Canceled" : order.status === "COMPLETED" ? "Completed" : "Not open";
  if (action === "cancel") {
    // The API's canCancel: open, unshipped and nothing captured.
    if (order.canCancel) return null;
    if (closed) return order.status === "CANCELED" ? "Already canceled" : closed;
    if (order.fulfillmentStatus !== "UNFULFILLED") return "Already shipped: refund instead";
    return "Payment captured: refund it first";
  }
  if (closed) return closed;
  if (action === "capture") return CAPTURABLE.includes(order.paymentStatus ?? "") ? null : (NOT_CAPTURABLE[order.paymentStatus ?? ""] ?? "Nothing to capture");
  return (order.lines ?? []).some((line) => remaining(line) > 0) ? null : "Nothing left to ship";
};

// ---------------------------------------------------------------- order queue

/** The list's page size; the queue's offsets are counted in it. */
export const ORDERS_PAGE_SIZE = 25;

const QueuePageQuery = graphql(`
  query OrderQueuePage($first: Int!, $after: String, $filter: OrderFilter) {
    orders(first: $first, after: $after, filter: $filter) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          number
        }
      }
    }
  }
`);

type OrderFilter = VariablesOf<typeof QueuePageQuery>["filter"];

/** The orders list result, kept per tab so the order page can step through it ("3 of 25"). */
export type OrderQueue = {
  /** The list's URL search: which result the queue is. */
  search: ListSearch;
  /** The filter the list sent, to load further pages the same way. */
  filter: OrderFilter;
  numbers: string[];
  /** Orders before the first number; null when the list didn't know its page number. */
  offset: number | null;
  total: number;
  endCursor: string | null;
  hasNextPage: boolean;
};

type OrdersPage = {
  totalCount?: number | null;
  pageInfo?: { hasNextPage: boolean; endCursor?: string | null } | null;
  edges?: readonly ({ node?: { number?: string | null } | null } | null)[] | null;
};

const QUEUE_KEY = "orders:queue";

export const readOrderQueue = (): OrderQueue | null => {
  try {
    const queue = JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? "null") as OrderQueue | null;
    return queue && Array.isArray(queue.numbers) ? queue : null;
  } catch {
    return null;
  }
};

const writeOrderQueue = (queue: OrderQueue) => {
  try {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage blocked or full: stepping through orders is a convenience.
  }
};

/** The list's filters without its cursor: every page of one result shares it. */
const resultKey = (search: ListSearch) =>
  JSON.stringify(
    Object.entries(search)
      .filter(([key, value]) => key !== "after" && value)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const numbersOf = (page: OrdersPage) => (page.edges ?? []).flatMap((edge) => (edge?.node?.number ? [edge.node.number] : []));

const extend = (queue: OrderQueue, page: OrdersPage): OrderQueue => {
  const seen = new Set(queue.numbers);
  const numbers = [...queue.numbers, ...numbersOf(page).filter((number) => !seen.has(number))];
  const hasNextPage = !!page.pageInfo?.hasNextPage;
  return {
    ...queue,
    numbers,
    endCursor: page.pageInfo?.endCursor ?? queue.endCursor,
    hasNextPage,
    // Orders that have since left the filter (e.g. shipped ones) lower the API's count, so keep the
    // count the queue started with until its real end is known.
    total: hasNextPage ? Math.max(queue.total, (queue.offset ?? 0) + numbers.length + 1) : (queue.offset ?? 0) + numbers.length,
  };
};

/**
 * Remember the page of orders the list shows. The next page of the same result extends the queue,
 * so stepping back from page 2's first order reaches page 1.
 */
export const rememberOrderList = ({ search, filter, after, page, orders }: { search: ListSearch; filter: OrderFilter; after: string | null; page: number | undefined; orders: OrdersPage }) => {
  const current = readOrderQueue();
  if (current && after && current.endCursor === after && resultKey(current.search) === resultKey(search)) {
    writeOrderQueue({ ...extend(current, orders), search });
    return;
  }
  const numbers = numbersOf(orders);
  const offset = after ? (page ? (page - 1) * ORDERS_PAGE_SIZE : null) : 0;
  writeOrderQueue({
    search,
    filter,
    numbers,
    offset,
    total: Math.max(orders.totalCount ?? 0, (offset ?? 0) + numbers.length),
    endCursor: orders.pageInfo?.endCursor ?? null,
    hasNextPage: !!orders.pageInfo?.hasNextPage,
  });
};

/** Keys typed into a field, or pressed while a dialog or menu is open, are not shortcuts. */
const notShortcut = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable], [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']"))) return true;
  return !!document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open']");
};

/**
 * The order's place in the remembered list result, or null if it isn't in it. Loads the list's next
 * page at the end. J or ] goes to the next order, K or [ to the previous one.
 */
export const useOrderQueue = (number: string) => {
  const navigate = useNavigate();
  const [queue, setQueue] = useState(readOrderQueue);
  const [loading, setLoading] = useState(false);
  const index = queue ? queue.numbers.indexOf(number) : -1;
  const active = !!queue && index >= 0;

  const open = (target: string) => void navigate({ to: "/orders/$number", params: { number: target } });
  const goPrevious = () => {
    const target = active ? queue.numbers[index - 1] : undefined;
    if (target) open(target);
  };
  const goNext = async () => {
    if (!active) return;
    const known = queue.numbers[index + 1];
    if (known) return open(known);
    if (!queue.hasNextPage || loading) return;
    setLoading(true);
    try {
      // Start from what is stored if it is still this result: it may have grown since this page read it.
      const stored = readOrderQueue();
      const base = stored && resultKey(stored.search) === resultKey(queue.search) && stored.numbers.includes(number) ? stored : queue;
      const data = await request(QueuePageQuery, { first: ORDERS_PAGE_SIZE, after: base.endCursor, filter: base.filter });
      const next = extend(base, data.orders ?? {});
      writeOrderQueue(next);
      setQueue(next);
      const target = next.numbers[next.numbers.indexOf(number) + 1];
      if (target) open(target);
      else toast.info("That was the last order in the list");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load the next orders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (notShortcut(event)) return;
      if (event.key === "j" || event.key === "]") {
        event.preventDefault();
        void goNext();
      } else if (event.key === "k" || event.key === "[") {
        event.preventDefault();
        goPrevious();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!active) return null;
  return {
    /** "3 of 25"; counted within the loaded orders ("3 of 25+") when the list's page was unknown. */
    label:
      queue.offset === null
        ? `${index + 1} of ${queue.numbers.length}${queue.hasNextPage ? "+" : ""}`
        : `${queue.offset + index + 1} of ${Math.max(queue.total, queue.offset + queue.numbers.length)}`,
    previous: queue.numbers[index - 1] ?? null,
    next: queue.numbers[index + 1] ?? null,
    hasNext: index < queue.numbers.length - 1 || queue.hasNextPage,
    loading,
    goPrevious,
    goNext,
  };
};

export type OrderQueueNav = NonNullable<ReturnType<typeof useOrderQueue>>;
