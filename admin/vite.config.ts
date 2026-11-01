import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath, searchForWorkspaceRoot, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
// `pnpm admin:vite` proxies API calls here; `pnpm dev` serves the admin from the API itself.
// Only uploads are proxied under /admin/media: /admin/media is the media library screen.
const api = process.env.ADMIN_API_URL ?? "http://localhost:4000";

/** A plugin's admin module (PluginDefinition.admin). */
type AdminModule = { name: string; title: string; file: string };

/**
 * Node imports ecom.config.ts rather than Vite bundling it, so it is the same config the server
 * runs. Only plugins' module top-level code runs here.
 */
const pluginAdminModules = async (): Promise<AdminModule[]> => {
  const file = fileURLToPath(new URL("../ecom.config.ts", import.meta.url));
  if (!existsSync(file)) return [];
  let config: { plugins?: readonly { name: string; title: string; admin?: URL }[] };
  try {
    config = ((await import(pathToFileURL(file).href)) as { default: typeof config }).default;
  } catch (error) {
    throw new Error(`The admin could not load ecom.config.ts to find plugin admin modules: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return (config.plugins ?? []).flatMap((plugin) => (plugin.admin ? [{ name: plugin.name, title: plugin.title, file: normalizePath(fileURLToPath(plugin.admin)) }] : []));
};

const MODULES_ID = "virtual:ecom/admin-plugins";

/**
 * Serves `virtual:ecom/admin-plugins`, with each plugin admin module in its own chunk so only active
 * plugins' modules load. Adds an `@source` per module directory to app.css, as Tailwind scans only
 * admin/ by itself.
 */
const adminPlugins = (modules: readonly AdminModule[]): Plugin => {
  const css = normalizePath(`${root}src/app.css`);
  const sources = [...new Set(modules.map((m) => dirname(m.file)))].map((dir) => `\n@source ${JSON.stringify(dir)};`).join("");
  return {
    name: "ecom-admin-plugins",
    enforce: "pre",
    resolveId: (id) => (id === MODULES_ID ? `\0${MODULES_ID}` : undefined),
    load: (id) =>
      id === `\0${MODULES_ID}`
        ? `export default [\n${modules.map((m) => `  { name: ${JSON.stringify(m.name)}, title: ${JSON.stringify(m.title)}, load: () => import(${JSON.stringify(m.file)}) },\n`).join("")}];\n`
        : undefined,
    // Ahead of Tailwind, also "pre" but later in the list. Appending keeps the source map valid.
    transform: { order: "pre", handler: (code, id) => (sources && normalizePath(id.split("?")[0]!) === css ? { code: code + sources, map: null } : undefined) },
  };
};

export default defineConfig(async () => {
  const modules = await pluginAdminModules();
  return {
    root,
    base: "/admin/",
    plugins: [adminPlugins(modules), react(), tailwindcss()],
    resolve: {
      // `@ecom/admin` is the stable API for plugin admin modules (src/plugin-sdk.ts); `@/` is internal.
      alias: { "@ecom/admin": `${root}src/plugin-sdk.ts`, "@": `${root}src` },
      // Plugin modules outside admin/ must share the app's React, router and query client.
      dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router"],
    },
    server: {
      port: 5173,
      proxy: Object.fromEntries(["/admin/graphql", "/admin/auth", "/admin/media/uploads", "/media"].map((path) => [path, { target: api, changeOrigin: true }])),
      // Plugin modules may live outside the workspace, e.g. in a linked package.
      fs: { allow: [searchForWorkspaceRoot(root), ...modules.map((m) => dirname(m.file))] },
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 900 },
  };
});
