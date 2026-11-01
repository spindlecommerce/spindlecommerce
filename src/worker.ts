import ecom from "../ecom.config.ts";
import { createPlatform } from "./platform.ts";
import { startWorker } from "./modules/integrations/worker.ts";

// Standalone outbox worker. Several can run at once: batches are claimed with SKIP LOCKED.
const platform = await createPlatform({ plugins: ecom.plugins });
void platform.plugins.start();
const worker = startWorker(platform);
platform.logger.info("Outbox worker started");

const shutdown = async () => {
  await worker.stop();
  await platform.database.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
