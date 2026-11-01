/**
 * The stable admin API for plugins, imported as `@ecom/admin`; the rest of admin/src is internal.
 * React, lucide-react and the libraries re-exported here may be imported directly.
 *
 * A plugin's admin module default-exports `defineAdminPlugin({ pages, widgets, settings })`. Pages
 * and widgets show only while the plugin is active, and only to staff with their permission.
 * Modules of plugins in ecom.config.ts are bundled into the admin and run in the browser, so never
 * import the plugin's server code. See docs/plugins.md (Writing admin modules).
 */
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { SettingDescriptor } from "@/components/settings-form";

// ---------------------------------------------------------------- definition

/** A permission, or a list of which any one suffices, e.g. ["reviews:moderate", "catalog:write"]. */
export type Permission = string | readonly string[];

/** The sidebar's groups. Entries naming none go in "Plugins", before Settings. */
export type NavGroupName = "Sales" | "Catalog" | "Customers" | "Marketing" | "Content" | "Analytics" | "Settings" | "System" | "Plugins";

export type PluginPageProps = {
  /** The values of the path's `$` segments: "reviews/$id" at …/reviews/42 gives `{ id: "42" }`. */
  params: Record<string, string>;
};

export type AdminPage = {
  /**
   * The path under /admin/plugins/<name>/: "" for the home page, "reviews", or "reviews/$id".
   * Exact segments win over parameters.
   */
  path: string;
  /** Lists the page in Settings › Plugins; the page renders its own PageHeader. */
  title: string;
  /** Renders the whole screen, normally `<Page><PageHeader …/>…</Page>`. */
  component: ComponentType<PluginPageProps>;
  /** Needed to open the page; defaults to the nav entry's. Without either, every staff user may. */
  permission?: Permission;
  /** An entry in the sidebar and ⌘K. Not for paths with parameters. */
  nav?: {
    label: string;
    /** Default "Plugins". */
    group?: NavGroupName;
    /** Default: Blocks. */
    icon?: LucideIcon;
    permission: Permission;
    /** Extra words ⌘K finds the entry by. */
    keywords?: string;
  };
};

/** Where widgets go, with the props each place passes them. */
export type WidgetZones = {
  /** The order screen's side column. `id`: the order's ID. */
  "order.detail": { id: string };
  /** The product editor's side column (saved products only). `id`: the product's ID. */
  "product.detail": { id: string };
  /** The customer screen's side column. `id`: the customer's ID. */
  "customer.detail": { id: string };
  /** A grid below the dashboard's figures, shown even to staff who can't see them. No props. */
  dashboard: Record<never, never>;
};
export type WidgetZone = keyof WidgetZones;

/** A widget renders its own Card. If it throws, an error replaces it and the screen keeps working. */
export type AdminWidget = { [Z in WidgetZone]: { zone: Z; component: ComponentType<WidgetZones[Z]>; permission?: Permission } }[WidgetZone];

/** The plugin as Settings › Plugins shows it. */
export type PluginInfo = {
  name: string;
  title: string;
  version: string;
  description: string | null;
  enabled: boolean;
  /** Every required setting has a value. */
  configured: boolean;
  /** Enabled and configured: its pages, widgets, providers and handlers run. */
  active: boolean;
  /** Keys of required settings without a value. */
  missingSettings: string[];
  /** Descriptors with the current values; render them with SettingsForm. */
  settings: SettingDescriptor[];
};

/** What a custom settings panel (`defineAdminPlugin({ settings })`) gets. */
export type PluginSettingsPanelProps = {
  plugin: PluginInfo;
  /**
   * Saves a patch: omitted keys keep their values; `null` clears one, a secret too. Once it
   * resolves, `plugin` has the new values. Rejects with a MutationError whose field error paths
   * are ["input", "settings", key] (see `settingsErrors`).
   */
  save: (settings: Record<string, unknown>) => Promise<void>;
  /** The viewer may change settings (settings:write); otherwise show them read-only. */
  canEdit: boolean;
};

export type AdminPluginDefinition = {
  pages?: AdminPage[];
  widgets?: AdminWidget[];
  /** Replaces the generated settings form, e.g. to connect an account with OAuth. */
  settings?: ComponentType<PluginSettingsPanelProps>;
};

/** `export default defineAdminPlugin({ pages: [...] })` in a plugin's admin module. */
export const defineAdminPlugin = (definition: AdminPluginDefinition): AdminPluginDefinition => definition;

// ---------------------------------------------------------------- the plugin's own pages

/**
 * usePlugin(): the plugin whose page, widget or settings panel is rendering.
 * pluginPath(name, path): a plugin page's admin path, e.g. "/plugins/acme/reviews/42".
 * <PluginLink to="reviews/42"> and usePluginNavigate(): go to one of this plugin's pages.
 */
export { PluginLink, pluginPath, usePlugin, usePluginNavigate } from "@/components/plugin-runtime";

// ---------------------------------------------------------------- data

/**
 * Documents typed against schema/admin.graphql; `pnpm schema:print` adds the plugin's fields once
 * it is in ecom.config.ts. `request` runs one as the signed-in user; `unwrap` returns a mutation's
 * payload or throws a MutationError. Include `...ErrorFields` in mutation results.
 */
export { ErrorFields, graphql, MoneyFields, type ResultOf, type VariablesOf } from "@/graphql/graphql";
export { ApiError, MutationError, request, unwrap, type FieldError } from "@/lib/api";
/** The admin's query client. Start your own cache keys with your plugin's name. */
export { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/**
 * `useAction`: a mutation with a success toast, cache invalidation by key prefix, and errors as
 * toasts or on a form. `useListSearch`, `useCursorPages`: a list's filters and page in the URL, as
 * DataTable expects them.
 */
export { copyText, useAction, useCursorPages, useDebounced, useListSearch } from "@/lib/hooks";
/** `can(permission)`: whether the viewer has it, or any one of a list. */
export { useAuth } from "@/lib/auth";
export { Link, useNavigate } from "@tanstack/react-router";
export { toast } from "sonner";

// ---------------------------------------------------------------- formatting

export { countryName, formatAmount, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, relativeTime, type MoneyLike } from "@/lib/format";
export { cn, humanize } from "@/lib/utils";

// ---------------------------------------------------------------- components

export { Page, PageHeader, TwoColumn } from "@/components/layout/page";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
export { Button, type ButtonProps } from "@/components/ui/button";
export { Badge, type BadgeVariant } from "@/components/ui/badge";
export { BooleanBadge, StatusBadge } from "@/components/status";
export { Alert, Detail, EmptyState, Kbd, Separator, Skeleton } from "@/components/ui/feedback";
export { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
/** The admin grid: server-side search, URL filters and paging, export and keyboard navigation. */
export { DataTable, type Column } from "@/components/data-table";
export { JsonView } from "@/components/inputs";

// Forms: Field labels, describes and marks invalid the control inside it.
export { Field, FormSection, reportError } from "@/components/form";
export { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
export { Select, type SelectOption } from "@/components/ui/menu";
export { Combobox, MultiSelect, type ComboOption } from "@/components/ui/combobox";
export { Checkbox, SectionTabsList, SectionTabsTrigger, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
/** Typed settings forms, as Settings › Plugins renders them. */
export { changedSettings, initialSettingValues, SettingsForm, settingsErrors, validateSettings, type SettingDescriptor } from "@/components/settings-form";
/** Editors: the bar with Save and Discard, ⌘S, and the "Leave without saving?" guard. */
export { SaveBar, useSaveShortcut } from "@/components/save-bar";
export { useUnsavedChanges } from "@/lib/unsaved-changes";

// Overlays and menus.
export {
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  Tooltip,
} from "@/components/ui/overlay";
export { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
