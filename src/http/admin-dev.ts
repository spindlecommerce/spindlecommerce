import { existsSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** Admin URLs the API answers itself; everything else under /admin/ is the app. */
const API_PATH = /^\/admin\/(?:graphql(?:[/?]|$)|auth\/|media\/uploads\/)/;
/** /admin/media is the media library screen, except for the API's multipart upload (POST). */
const MEDIA_UPLOAD = /^\/admin\/media(?:\?|$)/;

const isApiRequest = (req: IncomingMessage, url: string) => API_PATH.test(url) || (req.method !== "GET" && req.method !== "HEAD" && MEDIA_UPLOAD.test(url));

export type AdminDevServer = {
  handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  close: () => Promise<void>;
};

/** Development only: the admin app from source at /admin/, via Vite in middleware mode on this server. */
export const createAdminDevServer = async (server: Server): Promise<AdminDevServer | null> => {
  const configFile = "admin/vite.config.ts";
  if (!existsSync(configFile)) return null;
  const { createServer } = await import("vite");
  // "native" uses Node's own TypeScript support; the default bundles the config to a temporary file
  // whose removal restarts `node --watch`.
  const vite = await createServer({ configFile, configLoader: "native", appType: "spa", server: { middlewareMode: true, ws: { server } } });
  return {
    handle: (req, res, next) => {
      const url = req.url ?? "/";
      if (url === "/admin") {
        res.writeHead(308, { location: "/admin/" }).end();
        return;
      }
      if (!url.startsWith("/admin/") || isApiRequest(req, url)) return next();
      vite.middlewares(req, res, next);
    },
    close: () => vite.close(),
  };
};
