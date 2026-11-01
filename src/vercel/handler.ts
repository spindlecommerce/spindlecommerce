import "./env.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { attachDatabasePool, waitUntil } from "@vercel/functions";
// A static import, so the bundle includes the plugins (they are code, not files read at runtime).
import ecom from "../../ecom.config.ts";
import { createApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { trackOutboxWrites } from "../modules/integrations/outbox.ts";
import { createPlatform } from "../platform.ts";
import { createBackgroundWork } from "./background.ts";

/** scripts/vercel-build.ts copies the admin's index.html here; the CDN serves the assets. */
const ADMIN_INDEX = new URL("../../admin/dist/index.html", import.meta.url);

type Listener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const boot = async (): Promise<Listener> => {
  const config = loadConfig();
  // Before the platform, which would fail importing PGlite (not deployed). Logged, not thrown: the
  // smoke test runs the bundle on PGlite from node_modules.
  const url = config.databaseUrl;
  if (!url || url === "memory:" || url.startsWith("pglite:")) {
    console.error("DATABASE_URL (or POSTGRES_URL) must be a PostgreSQL URL on Vercel: connect Neon or Supabase. PGlite is not deployed.");
  }
  const appDir = process.env.ADMIN_APP_DIR === undefined ? fileURLToPath(new URL(".", ADMIN_INDEX)) : config.admin.appDir;
  const platform = await createPlatform({ config: { ...config, admin: { ...config.admin, appDir } }, plugins: ecom.plugins, keepAlive: waitUntil });
  // Lets idle connections close before Vercel suspends the instance. Not for Redis: it throws on
  // ioredis clients.
  if (platform.database.pool) attachDatabasePool(platform.database.pool);
  const { app } = await createApp({ platform });
  // Once per instance, held open past this first response; failures are logged.
  waitUntil(platform.plugins.start());
  const background = createBackgroundWork(platform, { keepAlive: waitUntil });
  return getRequestListener(async (request, env) => {
    const { result, drain } = await trackOutboxWrites(async () => app.fetch(request, env));
    // Before the response is written, so waitUntil holds the instance for the work it starts.
    background.afterRequest(new URL(request.url).pathname, drain);
    return result;
  });
};

let listener: Promise<Listener> | undefined;

/**
 * For the Build Output API's Node.js launcher. The app is built on an instance's first request and
 * serves every later one, concurrent ones included under Fluid compute.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  listener ??= boot().catch((error: unknown) => {
    listener = undefined;
    throw error;
  });
  let serve: Listener;
  try {
    serve = await listener;
  } catch (error) {
    console.error("The API failed to start", error);
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "INTERNAL_SERVER_ERROR", message: "The API failed to start; see the function logs" } }));
    return;
  }
  // Vercel terminates TLS. Give the app the URL the client used, so it sees https.
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  if (proto === "https" && req.headers.host && req.url?.startsWith("/")) req.url = `https://${req.headers.host}${req.url}`;
  await serve(req, res);
}
