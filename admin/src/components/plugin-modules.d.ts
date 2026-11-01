/** Served by admin/vite.config.ts: the admin modules of the plugins in ecom.config.ts. */
declare module "virtual:ecom/admin-plugins" {
  const modules: readonly { name: string; title: string; load: () => Promise<{ default: import("../plugin-sdk").AdminPluginDefinition }> }[];
  export default modules;
}
