import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Imported first by the Vercel function, before anything reads the environment. Sets VERCEL even
 * when the project hides system environment variables, and defaults NODE_ENV to production.
 */
process.env.VERCEL ||= "1";
process.env.NODE_ENV ||= "production";

// Files the build copies into the function sit at their project paths under the function root.
const root = fileURLToPath(new URL("../../", import.meta.url));
const operations = process.env.PERSISTED_OPERATIONS_FILE;
if (operations && !isAbsolute(operations)) process.env.PERSISTED_OPERATIONS_FILE = resolve(root, operations);
