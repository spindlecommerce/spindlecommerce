import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { InvalidStateError } from "../../lib/errors.ts";
import type { Platform } from "../../platform.ts";
import type { PluginContext, RouteApi } from "../../plugins/sdk.ts";

export const PLUGIN_ROUTES_PATH = "/plugins";

/**
 * 503 while the plugin is inactive: webhook senders retry it, unlike a 404, and it does not say
 * which settings are missing.
 */
const routeApi = (platform: Platform, name: string): RouteApi<any> => ({
  context: async (c: Context): Promise<PluginContext> => {
    try {
      return await platform.plugins.context(name);
    } catch (error) {
      if (!(error instanceof InvalidStateError)) throw error;
      throw new HTTPException(503, { res: c.json({ error: { code: "PLUGIN_UNAVAILABLE", message: `The ${name} plugin is not active` } }, 503) });
    }
  },
});

/** Routes are public: each plugin verifies what it receives, such as webhook signatures. */
export const mountPluginRoutes = (app: Hono, options: { platform: Platform; base: string }) => {
  const { platform } = options;
  for (const definition of platform.plugins.definitions) {
    if (!definition.routes) continue;
    const name = definition.name;
    const router = new Hono();
    router.onError((error, c) => {
      if (error instanceof HTTPException) return error.getResponse();
      platform.logger.error({ err: error, plugin: name, path: c.req.path }, "plugin route failed");
      void platform.plugins.reportError(error, { source: "route", plugin: name, details: { method: c.req.method, path: c.req.path } });
      return c.json({ error: { code: "INTERNAL_SERVER_ERROR", message: "The plugin could not handle the request" } }, 500);
    });
    definition.routes(router, routeApi(platform, name));
    app.route(`${options.base}${PLUGIN_ROUTES_PATH}/${name}`, router);
  }
};
