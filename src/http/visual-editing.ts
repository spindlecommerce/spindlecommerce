import { readFile } from "node:fs/promises";
import type { Hono } from "hono";

const BRIDGE = new URL("../visual-editing/bridge.js", import.meta.url);

/**
 * The visual editing bridge for storefronts. Any origin may load it: it carries no secrets and only
 * talks to the admin origin a storefront passes to it.
 */
export const mountVisualEditing = (app: Hono, options: { base: string; production: boolean }) => {
  let cached: Promise<string> | null = null;
  app.get(`${options.base}/visual-editing/bridge.js`, async () => {
    // Re-read in development so edits show up without a restart.
    const source = await (options.production ? (cached ??= readFile(BRIDGE, "utf8")) : readFile(BRIDGE, "utf8"));
    return new Response(source, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": options.production ? "public, max-age=300" : "no-cache",
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });
};
