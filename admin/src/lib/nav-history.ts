import { useMatch, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

/**
 * Where each screen was last left in this tab, and its title, kept in sessionStorage. Back links and
 * the page editor use it; sidebar links still open lists unfiltered.
 */

export type Visit = { path: string; search: Record<string, unknown>; hash: string; title?: string; at: number };
type NavHistory = { visits: Record<string, Visit>; last?: string };

const KEY = "ecom-admin:nav-history";
const LIMIT = 100;
/** Search params that open something on arrival (`/pages?new=page` opens the create dialog). */
const TRANSIENT = new Set(["new"]);

const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

const read = (): NavHistory => {
  try {
    const stored = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as NavHistory | null;
    return stored && typeof stored.visits === "object" ? stored : { visits: {} };
  } catch {
    return { visits: {} };
  }
};

const write = (history: NavHistory) => {
  const visits = Object.values(history.visits);
  if (visits.length > LIMIT) history.visits = Object.fromEntries(visits.sort((a, b) => b.at - a.at).slice(0, LIMIT).map((visit) => [visit.path, visit]));
  try {
    sessionStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    // Storage full or blocked: back links fall back to the bare paths.
  }
};

export const recordVisit = (location: { pathname: string; search: object; hash: string }) => {
  const history = read();
  const path = normalize(location.pathname);
  const search = Object.fromEntries(Object.entries(location.search).filter(([key, value]) => !TRANSIENT.has(key) && value !== undefined));
  history.visits[path] = { ...history.visits[path], path, search, hash: location.hash, at: Date.now() };
  history.last = path;
  write(history);
};

/** Remember a screen's title, for links back to it ("Back to Oxford Shirt"). */
export const recordTitle = (pathname: string, title: string) => {
  const history = read();
  const path = normalize(pathname);
  const visit = history.visits[path];
  if (visit?.title === title) return;
  // The title can arrive before the screen's location is recorded.
  history.visits[path] = { path, search: {}, hash: "", at: Date.now(), ...visit, title };
  write(history);
};

export const rememberedVisit = (path: string): Visit | undefined => read().visits[normalize(path)];

/** In the page editor, the screen it was opened from. */
export const lastVisit = (): Visit | undefined => {
  const history = read();
  return history.last ? history.visits[history.last] : undefined;
};

export type NavTarget = { to: string; search: Record<string, unknown>; hash?: string; title?: string };

const targetOf = (visit: Visit): NavTarget => ({ to: visit.path, search: visit.search, hash: visit.hash || undefined, title: visit.title });

/**
 * Records each loaded location the calling layout shows. Around the page editor the resolved
 * location can briefly belong to the other layout, hence the route check.
 */
export const useRecordVisits = () => {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  const href = useRouterState({ select: (state) => state.resolvedLocation?.href });
  useEffect(() => {
    const { resolvedLocation, location, matches } = router.state;
    if (!href || resolvedLocation?.href !== location.href || !matches.some((match) => match.routeId === routeId)) return;
    recordVisit(resolvedLocation);
  }, [router, routeId, href]);
};

/** Name the current screen for links back to it from elsewhere. */
export const useNavTitle = (title: string | undefined) => {
  // The route's own path: during a navigation away, the router's location is already the next one.
  const pathname = useMatch({ strict: false, shouldThrow: false, select: (match) => match.pathname });
  useEffect(() => {
    if (title && pathname) recordTitle(pathname, title);
  }, [pathname, title]);
};

/** `to` as last left in this tab. A `to` with its own search or hash is used as is. */
export const useBackTarget = (to: string | undefined): NavTarget | undefined =>
  useMemo(() => {
    if (to === undefined) return undefined;
    if (/[?#]/.test(to)) return { to, search: {} };
    const visit = rememberedVisit(to);
    return visit ? { ...targetOf(visit), to } : { to, search: {} };
  }, [to]);

/** The screen this one was opened from, or `fallback` as last left. Read once, on open. */
export const usePreviousScreen = (fallback: string): NavTarget =>
  useMemo(() => {
    const visit = lastVisit() ?? rememberedVisit(fallback);
    return visit ? targetOf(visit) : { to: fallback, search: {} };
  }, [fallback]);
