import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Hono } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Same-origin, except images from anywhere, framing registered storefronts (the page editor's
 * preview) and uploads straight to object storage.
 */
export const adminCsp = (frameOrigins: readonly string[], connectOrigins: readonly string[] = []) => [
  `frame-src 'self' ${frameOrigins.join(" ")}`.trim(),
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "font-src 'self' data:",
  `connect-src 'self' ${connectOrigins.join(" ")}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/**
 * The built admin app at /admin; unknown paths get index.html, with a CSP built per request since
 * registered storefronts change at runtime. On Vercel the directory holds only index.html: the CDN
 * serves the assets.
 */
export const mountAdminApp = (
  app: Hono,
  options: { dir: string | null; base: string; production?: boolean; frameOrigins?: () => Promise<string[]>; connectOrigins?: readonly string[] },
) => {
  if (!options.dir) return false;
  const root = resolve(options.dir);
  if (!existsSync(join(root, "index.html"))) return false;
  const prefix = `${options.base}/admin`;
  // Storefront origins change rarely; look them up at most every 10 seconds.
  let origins: { at: number; value: Promise<string[]> } | null = null;
  const frameOrigins = () => {
    if (!origins || Date.now() - origins.at > 10_000) origins = { at: Date.now(), value: (options.frameOrigins?.() ?? Promise.resolve([])).catch(() => []) };
    return origins.value;
  };

  const send = async (file: string, cache: string, extra: Record<string, string> = {}) =>
    new Response(await readFile(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache, ...extra } });
  // Cached in production only: in development a rebuild rewrites it.
  const readIndex = () => readFile(join(root, "index.html"));
  let index: ReturnType<typeof readIndex> | null = null;
  const indexHtml = () => {
    if (!options.production) return readIndex();
    index ??= readIndex().catch((error: unknown) => {
      index = null;
      throw error;
    });
    return index;
  };

  const handler = async (path: string) => {
    let relative: string;
    try {
      relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const candidate = join(root, relative);
    // index.html itself is the app page below, with its CSP.
    if (relative && relative !== "index.html" && candidate.startsWith(root + sep)) {
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return send(candidate, relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
    // A missing file, such as a chunk from before a deploy, is a 404 rather than the app's HTML.
    if (relative.startsWith("assets/") || (extname(relative) !== "" && relative !== "index.html")) return new Response("Not found", { status: 404, headers: { "cache-control": "no-cache" } });
    return new Response(await indexHtml(), {
      headers: { "content-type": TYPES[".html"]!, "cache-control": "no-cache", "content-security-policy": adminCsp(await frameOrigins(), options.connectOrigins) },
    });
  };

  app.get(prefix, (c) => c.redirect(`${prefix}/`, 308));
  app.get(`${prefix}/*`, (c) => handler(c.req.path.slice(prefix.length)));
  return true;
};
