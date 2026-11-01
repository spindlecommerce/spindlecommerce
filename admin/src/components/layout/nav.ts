import { useMemo } from "react";
import {
  BarChart3,
  Blocks,
  Component,
  LayoutTemplate,
  MonitorSmartphone,
  Rocket,
  Boxes,
  ClipboardList,
  Coins,
  FolderTree,
  Gauge,
  Globe,
  Images,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListTree,
  MapPin,
  Package,
  Percent,
  Puzzle,
  Receipt,
  ScrollText,
  Shapes,
  ShieldCheck,
  ShoppingCart,
  SignpostBig,
  Tag,
  Truck,
  UserCog,
  Users,
  UsersRound,
  Webhook,
  Wrench,
  CreditCard,
  type LucideIcon,
} from "lucide-react";
import { pluginPath, useAdminPlugins, type LoadedPlugin } from "@/components/plugin-runtime";

/** `permission` may list several: the item shows to viewers with any one of them. */
export type NavItem = { label: string; to: string; icon: LucideIcon; permission: string | readonly string[]; keywords?: string };
export type NavGroup = { label: string; items: NavItem[] };

/** The admin's sections; see docs/admin.md. */
export const NAV: NavGroup[] = [
  { label: "", items: [{ label: "Dashboard", to: "/", icon: LayoutDashboard, permission: "reports:read", keywords: "home overview kpi" }] },
  {
    label: "Sales",
    items: [
      { label: "Orders", to: "/orders", icon: Receipt, permission: "orders:read", keywords: "sales invoices shipments credit memos refunds" },
      { label: "Abandoned carts", to: "/carts", icon: ShoppingCart, permission: "reports:read", keywords: "quotes shopping carts" },
    ],
  },
  {
    label: "Catalog",
    items: [
      { label: "Products", to: "/products", icon: Package, permission: "catalog:read", keywords: "sku variants items" },
      { label: "Categories", to: "/categories", icon: FolderTree, permission: "catalog:read", keywords: "tree navigation" },
      { label: "Inventory", to: "/inventory", icon: Boxes, permission: "inventory:read", keywords: "stock msi quantity sources" },
      { label: "Attributes", to: "/attributes", icon: ListTree, permission: "catalog:read", keywords: "eav options swatches" },
      { label: "Product types", to: "/product-types", icon: Shapes, permission: "catalog:read", keywords: "attributes variant options" },
    ],
  },
  {
    label: "Customers",
    items: [
      { label: "Customers", to: "/customers", icon: Users, permission: "customers:read", keywords: "accounts buyers" },
      { label: "Customer groups", to: "/customer-groups", icon: UsersRound, permission: "customers:read", keywords: "segments wholesale" },
    ],
  },
  {
    label: "Marketing",
    items: [
      { label: "Promotions", to: "/promotions", icon: Percent, permission: "promotions:read", keywords: "coupons discounts offers deals" },
      { label: "Redirects", to: "/redirects", icon: SignpostBig, permission: "catalog:read", keywords: "url rewrites seo 301" },
    ],
  },
  {
    label: "Content",
    items: [
      { label: "Pages", to: "/pages", icon: LayoutTemplate, permission: "content:read", keywords: "page builder visual editor landing cms basic pages" },
      // Products use the library as much as pages do.
      { label: "Media", to: "/media", icon: Images, permission: ["content:read", "catalog:read"], keywords: "media library images videos photos pictures files uploads assets dam" },
      { label: "Components", to: "/components", icon: Component, permission: "content:read", keywords: "slices blocks content types schema library" },
      { label: "Releases", to: "/releases", icon: Rocket, permission: "content:read", keywords: "publish schedule bundle launch" },
    ],
  },
  { label: "Analytics", items: [{ label: "Reports", to: "/reports", icon: BarChart3, permission: "reports:read", keywords: "sales bestsellers statistics" }] },
  {
    label: "Settings",
    items: [
      { label: "Channels", to: "/settings/channels", icon: Globe, permission: "settings:read", keywords: "stores websites markets regions" },
      { label: "Taxes", to: "/settings/taxes", icon: Landmark, permission: "settings:read", keywords: "tax rules rates zones classes vat" },
      { label: "Shipping", to: "/settings/shipping", icon: Truck, permission: "settings:read", keywords: "carriers zones table rate flat rate" },
      { label: "Payments", to: "/settings/payments", icon: CreditCard, permission: "settings:read", keywords: "payment methods" },
      { label: "Currencies", to: "/settings/currencies", icon: Coins, permission: "settings:read", keywords: "exchange rates" },
      { label: "Stock locations", to: "/settings/locations", icon: MapPin, permission: "inventory:read", keywords: "warehouses sources stocks" },
      { label: "Storefronts", to: "/settings/storefronts", icon: MonitorSmartphone, permission: "content:read", keywords: "frontends preview deploy revalidate next.js" },
      { label: "Plugins", to: "/settings/plugins", icon: Puzzle, permission: "settings:read", keywords: "extensions integrations apps add-ons modules" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Staff", to: "/system/staff", icon: UserCog, permission: "staff:read", keywords: "admin users permissions" },
      { label: "Roles", to: "/system/roles", icon: ShieldCheck, permission: "staff:read", keywords: "acl permissions" },
      { label: "API keys", to: "/system/api-keys", icon: KeyRound, permission: "integrations:read", keywords: "integrations tokens" },
      { label: "Webhooks", to: "/system/webhooks", icon: Webhook, permission: "integrations:read", keywords: "events deliveries" },
      { label: "Audit log", to: "/system/audit-log", icon: ScrollText, permission: "staff:read", keywords: "action log history activity" },
      { label: "Maintenance", to: "/system/maintenance", icon: Wrench, permission: "catalog:write", keywords: "reindex search cache" },
    ],
  },
];

/** Adds plugin nav entries to their named group, or "Plugins"; new groups go before Settings. */
export const withPluginEntries = (nav: readonly NavGroup[], plugins: readonly LoadedPlugin[]): NavGroup[] => {
  const groups = nav.map((group) => ({ ...group, items: [...group.items] }));
  for (const plugin of plugins) {
    for (const page of plugin.definition.pages ?? []) {
      if (!page.nav || page.path.includes("$")) continue;
      const label = page.nav.group ?? "Plugins";
      let group = groups.find((g) => g.label === label);
      if (!group) {
        group = { label, items: [] };
        const settings = groups.findIndex((g) => g.label === "Settings");
        groups.splice(settings < 0 ? groups.length : settings, 0, group);
      }
      group.items.push({
        label: page.nav.label,
        to: pluginPath(plugin.name, page.path),
        icon: page.nav.icon ?? Blocks,
        permission: page.nav.permission,
        keywords: [plugin.title, page.nav.keywords].filter(Boolean).join(" "),
      });
    }
  }
  return groups;
};

/** NAV with active plugins' entries, for the sidebar and ⌘K. */
export const useNav = (): readonly NavGroup[] => {
  const { plugins } = useAdminPlugins();
  return useMemo(() => (plugins.length ? withPluginEntries(NAV, plugins) : NAV), [plugins]);
};

export const QUICK_ACTIONS: { label: string; to: string; icon: LucideIcon; permission: string }[] = [
  { label: "Create order", to: "/orders/new", icon: ClipboardList, permission: "orders:write" },
  { label: "Add product", to: "/products/new", icon: Tag, permission: "catalog:write" },
  { label: "Add customer", to: "/customers/new", icon: Users, permission: "customers:write" },
  { label: "Add promotion", to: "/promotions/new", icon: Percent, permission: "promotions:write" },
  { label: "Create page", to: "/pages?new=page", icon: LayoutTemplate, permission: "content:write" },
  { label: "View reports", to: "/reports", icon: Gauge, permission: "reports:read" },
];
