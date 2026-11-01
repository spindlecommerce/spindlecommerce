import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { graphql } from "@/graphql/graphql";
import type { ListSearch } from "@/router";
import { reportError } from "@/components/form";
import { request } from "./api";

// ---------------------------------------------------------------- URL state

/** The list screen's URL search params, and a patch setter that resets the cursor by default. */
export const useListSearch = () => {
  const search = useSearch({ strict: false }) as ListSearch;
  const navigate = useNavigate();
  const set = useCallback(
    (patch: Partial<ListSearch>, options: { keepCursor?: boolean } = {}) =>
      void navigate({
        to: ".",
        search: (prev: ListSearch) => {
          const next: Record<string, string | undefined> = { ...prev, ...patch };
          if (!options.keepCursor && !("after" in patch)) delete next.after;
          for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === "") delete next[key];
          return next as ListSearch;
        },
        replace: true,
      }),
    [navigate],
  );
  return [search, set] as const;
};

/** Params that don't change which rows a list shows. */
const NOT_LIST_STATE = new Set(["after", "new"]);

/** One cursor chain per list and filters, mirrored in memory for when sessionStorage fails. */
const chainKey = (pathname: string, search: ListSearch) =>
  `cursor-pages:${pathname}?${Object.entries(search)
    .filter(([key, value]) => value && !NOT_LIST_STATE.has(key))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")}`;
const chains = new Map<string, string[]>();

const readChain = (key: string): string[] => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (Array.isArray(stored) && stored[0] === "" && stored.every((cursor) => typeof cursor === "string")) return stored;
  } catch {
    // Storage blocked or the value unreadable: fall back to this page load's memory.
  }
  return chains.get(key) ?? [""];
};

const writeChain = (key: string, chain: string[]) => {
  chains.set(key, chain);
  try {
    sessionStorage.setItem(key, JSON.stringify(chain));
  } catch {
    // Memory only.
  }
};

/**
 * Cursor paging with "Previous" and page numbers. The cursor is in the URL (`after`); the chain
 * that led to it is kept in sessionStorage, so it survives a reload. `page` is undefined for a
 * cursor this tab never paged to (a shared link): the list then only goes forward or to page one.
 */
export const useCursorPages = () => {
  const [search, set] = useListSearch();
  const pathname = useLocation({ select: (location) => location.pathname });
  const key = chainKey(pathname, search);
  // Bumped after each write, to read the chain again.
  const [version, setVersion] = useState(0);
  const chain = useMemo(() => readChain(key), [key, version]);
  const after = search.after ?? "";
  const index = chain.indexOf(after);
  return {
    after: after || null,
    page: index >= 0 ? index + 1 : undefined,
    next: (cursor: string | null | undefined) => {
      // A second click on a page that hasn't loaded yet would send the cursor we're already at.
      if (!cursor || cursor === after) return;
      if (index >= 0) {
        writeChain(key, [...chain.slice(0, index + 1), cursor]);
        setVersion((v) => v + 1);
      }
      set({ after: cursor }, { keepCursor: true });
    },
    prev: () => {
      if (index <= 0) return;
      set({ after: chain[index - 1] || undefined }, { keepCursor: true });
    },
    first: () => set({ after: undefined }, { keepCursor: true }),
    reset: () => {
      writeChain(key, [""]);
      setVersion((v) => v + 1);
    },
  };
};

export const useDebounced = <T,>(value: T, ms = 250) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
};

// ---------------------------------------------------------------- per-user preferences

const PreferencesQuery = graphql(`
  query Preferences($keys: [String!]) {
    viewer {
      preferences(keys: $keys) {
        key
        value
      }
    }
  }
`);

const PreferenceSet = graphql(`
  mutation PreferenceSet($key: String!, $value: JSON) {
    staffPreferenceSet(key: $key, value: $value) {
      __typename
    }
  }
`);

/** A server-stored preference of the signed-in user, e.g. saved views or columns. */
export const usePreference = <T,>(key: string, fallback: T) => {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["preference", key], queryFn: () => request(PreferencesQuery, { keys: [key] }), staleTime: 5 * 60_000 });
  const stored = query.data?.viewer?.preferences?.[0]?.value as T | undefined;
  const value = stored ?? fallback;
  const save = useMutation({
    mutationFn: (next: T | null) => request(PreferenceSet, { key, value: next }),
    onMutate: (next) => {
      queryClient.setQueryData(["preference", key], { viewer: { preferences: next === null ? [] : [{ key, value: next }] } });
    },
  });
  return [value, (next: T | null) => save.mutate(next), query.isLoading] as const;
};

// ---------------------------------------------------------------- mutations

/** A mutation with a success toast, cache invalidation by key prefix, and error toasts by default. */
export const useAction = <Variables, Result>(
  mutationFn: (variables: Variables) => Promise<Result>,
  options: { success?: string | ((result: Result) => string); invalidate?: QueryKey[]; onSuccess?: (result: Result, variables: Variables) => void; onError?: (error: unknown) => void } = {},
) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result, variables) => {
      if (options.success) toast.success(typeof options.success === "function" ? options.success(result) : options.success);
      await Promise.all((options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      options.onSuccess?.(result, variables);
    },
    onError: (error) => (options.onError ? options.onError(error) : reportError(error)),
  });
};

// ---------------------------------------------------------------- reference data

const ReferenceQuery = graphql(`
  query Reference {
    channels {
      id
      code
      name
      isActive
      currencies
      defaultCurrency
      locales
      defaultLocale
      countries {
        code
        name
      }
    }
    customerGroups {
      id
      code
      name
    }
    taxClasses {
      id
      code
      name
      kind
    }
    stockLocations {
      id
      code
      name
      isActive
    }
    productTypes {
      id
      code
      name
      isShippable
      attributes {
        code
      }
      variantAttributes {
        id
        code
        label
        options {
          code
          label
          swatch
        }
      }
    }
    localization {
      locale
      currencyCode
      channel {
        id
      }
    }
  }
`);

/**
 * Small, slow-changing lists many screens share. Fields the viewer can't read come back as errors,
 * so each list is optional.
 */
export const useReference = () => {
  const query = useQuery({ queryKey: ["reference"], queryFn: () => request(ReferenceQuery, undefined, { partial: true }), staleTime: 5 * 60_000, retry: false });
  return useMemo(() => {
    const data = query.data;
    const channels = data?.channels ?? [];
    // The API's match of the browser's locale to the default channel. It leads the list, so
    // translation tabs open on it.
    const displayLocale = data?.localization?.locale ?? channels[0]?.defaultLocale ?? "en-US";
    const locales = [...new Set([displayLocale, ...channels.flatMap((c) => c.locales ?? [])])];
    const currencies = [...new Set(channels.flatMap((c) => c.currencies ?? []))];
    return {
      loading: query.isLoading,
      channels,
      /** False when the channel list couldn't be read (it needs settings:read), leaving `channels` empty. */
      channelsLoaded: !!data?.channels,
      customerGroups: data?.customerGroups ?? [],
      taxClasses: data?.taxClasses ?? [],
      stockLocations: data?.stockLocations ?? [],
      productTypes: data?.productTypes ?? [],
      locales,
      currencies: currencies.length ? currencies : ["USD"],
      defaultLocale: displayLocale,
      /** The channel the API falls back to (DEFAULT_CHANNEL). */
      defaultChannelId: data?.localization?.channel?.id ?? channels.find((c) => c.isActive)?.id ?? channels[0]?.id ?? "",
    };
  }, [query.data, query.isLoading]);
};

// ---------------------------------------------------------------- the admin's currency

export type AdminCurrency = { channel: string; currency: string };

const currencyKey = (pair: AdminCurrency) => `${pair.channel}:${pair.currency}`;

/**
 * The channel and currency the admin shows prices in, saved per staff user. A pair because prices
 * belong to a channel; defaults to the default channel's currency. Nothing is converted.
 */
export const useAdminCurrency = () => {
  const { channels, defaultChannelId, loading } = useReference();
  const [saved, save, savedLoading] = usePreference<AdminCurrency | null>("admin:currency", null);
  const sold = channels.filter((c) => c.isActive && c.code).flatMap((c) => (c.currencies ?? []).map((currency) => ({ channel: c.code!, name: c.name ?? c.code!, currency })));
  const home = channels.find((c) => c.id === defaultChannelId && c.isActive) ?? channels.find((c) => c.isActive);
  const picked = !!saved && sold.some((p) => p.channel === saved.channel && p.currency === saved.currency);
  const current = picked ? saved! : { channel: home?.code ?? "", currency: home?.defaultCurrency ?? "USD" };
  // A currency two channels sell is named with its channel.
  const label = (pair: (typeof sold)[number]) => (sold.filter((p) => p.currency === pair.currency).length > 1 ? `${pair.currency} · ${pair.name}` : pair.currency);
  const choose = (pair: AdminCurrency | undefined) => pair && save({ channel: pair.channel, currency: pair.currency });
  return {
    ...current,
    key: currencyKey(current),
    /** Whether the viewer picked it (otherwise it is the default). */
    picked,
    loading: loading || savedLoading,
    options: sold.map((pair) => ({ value: currencyKey(pair), label: label(pair) })),
    /** Show prices and figures in an option (its `value`). */
    choose: (key: string) => choose(sold.find((pair) => currencyKey(pair) === key)),
    /** Prefers the current channel if it sells the currency, else the first that does. */
    chooseCurrency: (currency: string) => choose(sold.find((pair) => pair.currency === currency && pair.channel === current.channel) ?? sold.find((pair) => pair.currency === currency)),
  };
};

/** Copy text and confirm with a toast. */
export const copyText = async (text: string, label = "Copied") => {
  await navigator.clipboard.writeText(text);
  toast.success(label);
};
