import { useQueries, useQuery, type QueryObserverResult } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Component, createContext, useCallback, useContext, type ComponentProps, type ErrorInfo, type ReactNode } from "react";
import BUNDLED from "virtual:ecom/admin-plugins";
import { graphql } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminPage, AdminPluginDefinition } from "@/plugin-sdk";

/** The admin side of plugins: bundled admin modules, which plugins are active, and loading them. */

export type LoadedPlugin = { name: string; title: string; definition: AdminPluginDefinition };

type Bundled = (typeof BUNDLED)[number];

export const bundledPlugin = (name: string): Bundled | undefined => BUNDLED.find((entry) => entry.name === name);

/** Readable by every staff user, unlike `plugins`. */
const ActivePluginsQuery = graphql(`
  query ActivePlugins {
    activePlugins
  }
`);

const loadModule = async (entry: Bundled): Promise<LoadedPlugin> => {
  const definition = (await entry.load()).default;
  if (!definition || typeof definition !== "object") throw new Error(`The admin module of ${entry.title} has no default export from defineAdminPlugin()`);
  return { name: entry.name, title: entry.title, definition };
};

/** Modules are code, so they load once per page load. */
const moduleQuery = (entry: Bundled) => ({ queryKey: ["plugin-module", entry.name], queryFn: () => loadModule(entry), staleTime: Infinity, gcTime: Infinity, retry: false });

const combineModules = (results: QueryObserverResult<LoadedPlugin>[]) => ({
  plugins: results.flatMap((result) => (result.data ? [result.data] : [])),
  loading: results.some((result) => result.isLoading),
});

/** Active plugins' loaded admin modules. Settings › Plugins refreshes the active list on changes. */
export const useAdminPlugins = () => {
  const { status } = useAuth();
  const states = useQuery({
    queryKey: ["plugins", "active"],
    queryFn: () => request(ActivePluginsQuery),
    enabled: status === "signedIn" && BUNDLED.length > 0,
    staleTime: 5 * 60_000,
  });
  const names = states.data?.activePlugins;
  const modules = useQueries({ queries: BUNDLED.filter((entry) => names?.includes(entry.name)).map(moduleQuery), combine: combineModules });
  return {
    plugins: modules.plugins,
    /** Whether a plugin is active; `undefined` until known. */
    isActive: (name: string) => (names ? names.includes(name) : undefined),
    loading: states.isLoading || modules.loading,
  };
};

/** One plugin's admin module, whether or not the plugin is active (for its settings panel). */
export const usePluginModule = (name: string) => {
  const entry = bundledPlugin(name);
  return useQuery({ queryKey: ["plugin-module", name], queryFn: () => loadModule(entry!), enabled: !!entry, staleTime: Infinity, gcTime: Infinity, retry: false });
};

// ---------------------------------------------------------------- pages

/** "reviews/$id" → ["reviews", "$id"]. */
const segmentsOf = (path: string) => path.split("/").filter(Boolean);

/** Pages with fewer parameters match first, so "reviews/new" wins over "reviews/$id". */
export const matchPluginPage = (pages: readonly AdminPage[], segments: readonly string[]) => {
  const ranked = [...pages].sort((a, b) => segmentsOf(a.path).filter((s) => s.startsWith("$")).length - segmentsOf(b.path).filter((s) => s.startsWith("$")).length);
  for (const page of ranked) {
    const pattern = segmentsOf(page.path);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    if (pattern.every((part, i) => (part.startsWith("$") ? ((params[part.slice(1)] = segments[i]!), true) : part === segments[i]))) return { page, params };
  }
  return null;
};

// ---------------------------------------------------------------- the current plugin

type Scope = { name: string; title: string };
const ScopeContext = createContext<Scope | null>(null);

/** Marks what renders inside as the plugin's own, for usePlugin() and PluginLink. */
export const PluginScope = ({ plugin, children }: { plugin: Scope; children: ReactNode }) => <ScopeContext.Provider value={plugin}>{children}</ScopeContext.Provider>;

/** The plugin whose page, widget or settings panel is rendering. */
export const usePlugin = (): Scope => {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("usePlugin() works only inside a plugin's page, widget or settings panel");
  return scope;
};

/** pluginPath("acme", "reviews/42") → "/plugins/acme/reviews/42". */
export const pluginPath = (plugin: string, path = "") => {
  const rest = path.replace(/^\/+|\/+$/g, "");
  return `/plugins/${plugin}${rest ? `/${rest}` : ""}`;
};

/**
 * A link to one of the current plugin's pages, `to` being the path below the plugin's own. Encode
 * values in it: `<PluginLink to={`reviews/${encodeURIComponent(id)}`}>`.
 */
export const PluginLink = ({ to, search, ...props }: Omit<ComponentProps<"a">, "href"> & { to: string; search?: Record<string, string> }) => {
  const { name } = usePlugin();
  return <Link to={pluginPath(name, to)} search={search} {...props} />;
};

/**
 * `navigate("reviews", { search: { status: "pending" } })` within the current plugin. Encode values
 * in `to`, as for PluginLink.
 */
export const usePluginNavigate = () => {
  const { name } = usePlugin();
  const navigate = useNavigate();
  return useCallback((to: string, options: { search?: Record<string, string>; replace?: boolean } = {}) => navigate({ to: pluginPath(name, to), search: options.search, replace: options.replace }), [name, navigate]);
};

// ---------------------------------------------------------------- failures

/** Replaces a plugin page, widget or panel that throws while rendering with `fallback`. */
export class PluginBoundary extends Component<{ plugin: string; fallback: (error: Error) => ReactNode; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Plugin ${this.props.plugin} failed`, error, info.componentStack);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
