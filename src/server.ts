import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import ecom from "../ecom.config.ts";
import { createApp } from "./app.ts";
import { createAdminDevServer } from "./http/admin-dev.ts";
import { startWorker } from "./modules/integrations/worker.ts";
import { createPlatform } from "./platform.ts";

const { app, platform, close } = await createApp({ platform: await createPlatform({ plugins: ecom.plugins }) });
const port = platform.config.port;
// Not awaited: a plugin's slow or failing onStart (logged) must not hold up serving.
void platform.plugins.start();
// Drains the outbox in-process unless WORKER=external (then run `pnpm worker` separately).
const worker = process.env.WORKER === "external" ? null : startWorker(platform);

const api = getRequestListener(app.fetch);
const server = createServer();
// In development, serve the admin app from source with hot reload unless ADMIN_DEV=false.
const adminDev = process.env.NODE_ENV !== "production" && process.env.ADMIN_DEV !== "false" ? await createAdminDevServer(server) : null;
server.on("request", (req, res) => (adminDev ? adminDev.handle(req, res, () => void api(req, res)) : void api(req, res)));

server.listen(port, () => {
  platform.logger.info(
    `Admin http://localhost:${port}/admin/ · Storefront GraphQL http://localhost:${port}/graphql · Admin GraphQL http://localhost:${port}/admin/graphql (${platform.database.kind})`,
  );
});

const shutdown = async (signal: string) => {
  platform.logger.info(`${signal}: shutting down`);
  server.close();
  await adminDev?.close();
  await worker?.stop();
  await close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
