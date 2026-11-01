import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { registerPluginGraphQL } from "./graphql/schema.ts";
import { createGraphQLHandler } from "./graphql/yoga.ts";
import { mountAdminApp } from "./http/admin-app.ts";
import { mountAdminAuth } from "./http/admin-auth.ts";
import { clientIp } from "./http/client-ip.ts";
import { mountMedia } from "./http/media.ts";
import { mountPaymentWebhooks } from "./http/payments.ts";
import { mountVisualEditing } from "./http/visual-editing.ts";
import { frontendOrigins } from "./modules/builder/frontends.ts";
import { channels } from "./modules/channels/tables.ts";
import { mountWorkerRoute } from "./modules/integrations/worker.ts";
import { mediaUploadOrigins } from "./modules/media/storage.ts";
import { mountPluginRoutes } from "./modules/plugins/routes.ts";
import { createPlatform, type Platform } from "./platform.ts";

export type App = {
  app: Hono;
  platform: Platform;
  fetch: (request: Request) => Response | Promise<Response>;
  close: () => Promise<void>;
};

/** The HTTP surface as a Web-standard fetch handler, for Node, Bun, Deno or a Next.js route handler. */
export const createApp = async (options: { platform?: Platform; basePath?: string } = {}): Promise<App> => {
  const platform = options.platform ?? (await createPlatform());
  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const paths = { storefront: `${base}/graphql`, admin: `${base}/admin/graphql`, health: `${base}/health` };
  // Plugins' types and fields join the schema before it is built.
  registerPluginGraphQL(platform.plugins.definitions);
  const storefront = createGraphQLHandler(platform, "storefront", paths.storefront);
  const admin = createGraphQLHandler(platform, "admin", paths.admin);

  // A shared (Redis) cache is invalidated by the worker itself; an in-memory one listens for every
  // worker's changes.
  let stopped = false;
  const responseCache = platform.responseCache;
  const invalidations = responseCache && !responseCache.shared ? platform.pubsub.subscribe("invalidate") : null;
  if (responseCache && invalidations) {
    void (async () => {
      for await (const entities of invalidations) {
        if (stopped) break;
        await responseCache.invalidate(entities);
      }
    })();
  }

  const adminOrigins = (process.env.ADMIN_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const app = new Hono();
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
  app.use(paths.storefront, cors({ origin: process.env.STOREFRONT_CORS_ORIGINS?.split(",") ?? "*", allowHeaders: ["content-type", "authorization", "x-channel", "x-locale", "x-currency", "accept-language", "x-preview-token"], maxAge: 600 }));
  app.use(paths.admin, cors({ origin: adminOrigins, allowHeaders: ["content-type", "authorization", "x-channel", "x-locale", "x-currency"], maxAge: 600 }));
  app.get(base || "/", (c) => c.json({ name: "ecom", ...paths, ...(adminApp ? { adminApp: `${base}/admin/` } : {}) }));
  app.get(paths.health, async (c) => {
    await platform.db.$count(channels);
    return c.json({ status: "ok", database: platform.database.kind });
  });
  app.on(["GET", "POST", "OPTIONS"], paths.storefront, (c) => storefront.yoga.fetch(c.req.raw, { clientIp: clientIp(c, platform.config.trustProxy) }));
  app.on(["GET", "POST", "OPTIONS"], paths.admin, (c) => admin.yoga.fetch(c.req.raw, { clientIp: clientIp(c, platform.config.trustProxy) }));
  mountAdminAuth(app, { platform, base });
  mountMedia(app, { platform, base });
  mountPaymentWebhooks(app, { platform, base });
  mountVisualEditing(app, { base, production: platform.config.production });
  mountWorkerRoute(app, { platform, base });
  mountPluginRoutes(app, { platform, base });
  // Last, so its catch-all for client-side routes never shadows the API routes above.
  const adminApp = mountAdminApp(app, {
    dir: platform.config.admin.appDir,
    base,
    production: platform.config.production,
    frameOrigins: () => frontendOrigins(platform.db),
    connectOrigins: mediaUploadOrigins(),
  });

  return {
    app,
    platform,
    fetch: (request) => app.fetch(request),
    close: async () => {
      stopped = true;
      await invalidations?.return?.();
      await platform.database.close();
    },
  };
};
