import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet } from "@tanstack/react-router";
import { AppShell, FullScreenShell } from "@/components/layout/app-shell";
import { LoginPage, ResetPasswordPage } from "@/routes/login";

/** Filters, cursors and tabs live in the URL so views can be shared and survive reloads. */
export type ListSearch = Partial<Record<"q" | "after" | "status" | "payment" | "fulfillment" | "channel" | "group" | "type" | "category" | "product" | "tab" | "from" | "to" | "view" | "location" | "outcome" | "operation" | "redirect" | "token" | "kind" | "source" | "node" | "locale" | "device" | "new" | "sort" | "numbers" | "doc" | "asset", string>>;

const listSearch = (search: Record<string, unknown>): ListSearch =>
  Object.fromEntries(Object.entries(search).filter(([, v]) => typeof v === "string" && v !== "").map(([k, v]) => [k, v as string])) as ListSearch;

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet, validateSearch: listSearch });

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "login", component: LoginPage });
const resetRoute = createRoute({ getParentRoute: () => rootRoute, path: "reset-password", component: ResetPasswordPage });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppShell });
/** Signed-in screens that need the whole window, such as the visual page editor. */
const fullScreenRoute = createRoute({ getParentRoute: () => rootRoute, id: "fullscreen", component: FullScreenShell });

const page = <Path extends string>(path: Path, load: () => Promise<Record<string, unknown>>, name: string) =>
  createRoute({ getParentRoute: () => appRoute, path, component: lazyRouteComponent(load as () => Promise<Record<string, () => React.JSX.Element>>, name) });

const routes = [
  page("/", () => import("@/routes/dashboard"), "DashboardPage"),
  page("orders", () => import("@/routes/orders/list"), "OrdersPage"),
  page("orders/new", () => import("@/routes/orders/create"), "CreateOrderPage"),
  page("orders/print", () => import("@/routes/orders/print"), "OrdersPrintPage"),
  page("orders/$number", () => import("@/routes/orders/detail"), "OrderPage"),
  page("orders/$number/print", () => import("@/routes/orders/print"), "OrderPrintPage"),
  page("carts", () => import("@/routes/reports/abandoned-carts"), "AbandonedCartsPage"),
  page("products", () => import("@/routes/catalog/products"), "ProductsPage"),
  page("products/new", () => import("@/routes/catalog/product-edit"), "ProductEditPage"),
  page("products/$id", () => import("@/routes/catalog/product-edit"), "ProductEditPage"),
  page("categories", () => import("@/routes/catalog/categories"), "CategoriesPage"),
  page("categories/$id/merchandising", () => import("@/routes/catalog/merchandising"), "MerchandisingPage"),
  page("inventory", () => import("@/routes/catalog/inventory"), "InventoryPage"),
  page("attributes", () => import("@/routes/catalog/attributes"), "AttributesPage"),
  page("product-types", () => import("@/routes/catalog/product-types"), "ProductTypesPage"),
  page("customers", () => import("@/routes/customers/list"), "CustomersPage"),
  page("customers/new", () => import("@/routes/customers/detail"), "CustomerPage"),
  page("customers/$id", () => import("@/routes/customers/detail"), "CustomerPage"),
  page("customer-groups", () => import("@/routes/customers/groups"), "CustomerGroupsPage"),
  page("promotions", () => import("@/routes/marketing/promotions"), "PromotionsPage"),
  page("promotions/new", () => import("@/routes/marketing/promotion-edit"), "PromotionEditPage"),
  page("promotions/$id", () => import("@/routes/marketing/promotion-edit"), "PromotionEditPage"),
  page("redirects", () => import("@/routes/marketing/redirects"), "RedirectsPage"),
  page("pages", () => import("@/routes/builder/pages"), "PagesPage"),
  page("media", () => import("@/routes/media/library"), "MediaLibraryPage"),
  page("components", () => import("@/routes/builder/components"), "ComponentsPage"),
  page("components/new", () => import("@/routes/builder/component-edit"), "ComponentEditPage"),
  page("components/$id", () => import("@/routes/builder/component-edit"), "ComponentEditPage"),
  page("releases", () => import("@/routes/builder/releases"), "ReleasesPage"),
  page("releases/$id", () => import("@/routes/builder/release"), "ReleasePage"),
  page("reports", () => import("@/routes/reports/reports"), "ReportsPage"),
  page("settings/channels", () => import("@/routes/settings/channels"), "ChannelsPage"),
  page("settings/taxes", () => import("@/routes/settings/taxes"), "TaxesPage"),
  page("settings/shipping", () => import("@/routes/settings/shipping"), "ShippingPage"),
  page("settings/payments", () => import("@/routes/settings/payments"), "PaymentsPage"),
  page("settings/currencies", () => import("@/routes/settings/currencies"), "CurrenciesPage"),
  page("settings/locations", () => import("@/routes/settings/locations"), "LocationsPage"),
  page("settings/storefronts", () => import("@/routes/settings/storefronts"), "StorefrontsPage"),
  page("settings/plugins", () => import("@/routes/settings/plugins"), "PluginsPage"),
  page("settings/plugins/$name", () => import("@/routes/settings/plugins-detail"), "PluginSettingsPage"),
  // Plugin admin pages, matched against the plugin's own page list.
  page("plugins/$plugin/$", () => import("@/components/plugin-page"), "PluginPage"),
  page("system/staff", () => import("@/routes/system/staff"), "StaffPage"),
  page("system/roles", () => import("@/routes/system/roles"), "RolesPage"),
  page("system/api-keys", () => import("@/routes/system/api-keys"), "ApiKeysPage"),
  page("system/webhooks", () => import("@/routes/system/webhooks"), "WebhooksPage"),
  page("system/audit-log", () => import("@/routes/system/audit-log"), "AuditLogPage"),
  page("system/maintenance", () => import("@/routes/system/maintenance"), "MaintenancePage"),
  page("account", () => import("@/routes/account"), "AccountPage"),
];

const editorRoute = createRoute({
  getParentRoute: () => fullScreenRoute,
  path: "pages/$id",
  component: lazyRouteComponent(() => import("@/routes/builder/editor/editor") as Promise<Record<string, () => React.JSX.Element>>, "PageEditorPage"),
});

const routeTree = rootRoute.addChildren([loginRoute, resetRoute, appRoute.addChildren(routes), fullScreenRoute.addChildren([editorRoute])]);

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, basepath: "/admin", context: { queryClient }, defaultPreload: "intent", scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
