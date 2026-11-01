/**
 * Build the platform for Vercel's Build Output API (v3): the admin's static files, one function for
 * everything else, and the worker cron. Then migrate the database and, if asked, create the first
 * admin and the demo data. `--smoke` instead runs the built function locally and checks its routes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { WORKER_PATH } from "../src/modules/integrations/worker.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, ".vercel/output");
const functionDir = join(output, "functions/index.func");
const adminDist = join(root, "admin/dist");

/** The route of functions/index.func. Requests sent to it keep their original path. */
const FUNCTION_ROUTE = "/index";

/**
 * Left out of the bundle. PGlite is development-only and imported on demand. @node-rs/argon2 loads
 * a native binary, so it is copied in whole. pg-native is pg's optional native binding, unused.
 */
const EXTERNAL = ["@electric-sql/pglite", "drizzle-orm/pglite", "drizzle-orm/pglite/migrator", "@node-rs/argon2", "pg-native"];
/** Externals the function loads at runtime, copied into its node_modules. */
const RUNTIME_PACKAGES = ["@node-rs/argon2"];
/** Vercel functions run on Linux x64 with glibc. */
const DEPLOY_BINARY = "linux-x64-gnu";

/** CommonJS dependencies inside the ESM bundle call require() and read __dirname: define them. */
const BANNER = [
  'import { createRequire as __ecomCreateRequire } from "node:module";',
  'import { fileURLToPath as __ecomFileURLToPath } from "node:url";',
  "const require = __ecomCreateRequire(import.meta.url);",
  "const __filename = __ecomFileURLToPath(import.meta.url);",
  'const __dirname = __ecomFileURLToPath(new URL(".", import.meta.url));',
].join("\n");

const log = (message: string) => console.log(`vercel-build: ${message}`);
const size = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} kB`);
const truthy = (value: string | undefined) => value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());

/** Comments stripped, so examples in doc comments are not taken for real code. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Give each source module its own `import.meta.url`, as if it sat at its source path inside the
 * function, and collect the files its `new URL("…", import.meta.url)` calls name, to copy there.
 * Skips directories containing the module, which are bases for other paths, and admin modules
 * (.tsx, .jsx), which Vite bundles into the admin.
 */
const sourceUrls = (assets: Set<string>): Plugin => ({
  name: "source-urls",
  setup(builder) {
    const sources = [join(root, "src") + sep, join(root, "plugins") + sep];
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      if (!sources.some((dir) => args.path.startsWith(dir))) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta")) return undefined;
      const code = withoutComments(source);
      const unsupported = /import\.meta\.(?!url\b)\w+/.exec(code);
      if (unsupported) throw new Error(`${relative(root, args.path)}: ${unsupported[0]} is not supported in the Vercel bundle; use new URL(…, import.meta.url)`);
      for (const [, , path] of code.matchAll(/new URL\(\s*(["'])([^"'`$]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
        if (/\.[jt]sx$/.test(path!)) continue;
        const target = resolve(dirname(args.path), path!);
        if ((dirname(args.path) + sep).startsWith(target + sep)) continue;
        if (!target.startsWith(root)) throw new Error(`${relative(root, args.path)}: ${path} points outside the project`);
        assets.add(relative(root, target));
      }
      const self = relative(root, args.path).split(sep).join("/");
      return {
        contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(`./${self}`)}, import.meta.url).href`),
        loader: args.path.endsWith("ts") ? "ts" : "js",
        resolveDir: dirname(args.path),
      };
    });
  },
});

const bundle = async () => {
  const assets = new Set<string>();
  const result = await build({
    entryPoints: [join(root, "src/vercel/handler.ts")],
    outfile: join(functionDir, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: EXTERNAL,
    banner: { js: BANNER },
    sourcemap: "linked",
    sourcesContent: false,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    plugins: [sourceUrls(assets)],
  });
  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  log(`bundled src/vercel/handler.ts → functions/index.func/index.mjs (${size(bytes)} with its source map)`);
  // A bundled module declaring one of the banner's names would make the bundle fail to load.
  const code = await readFile(join(functionDir, "index.mjs"), "utf8");
  const clash = /^(?:var|let|const|function|class) (require|__filename|__dirname)\b/m.exec(code.slice(BANNER.length));
  if (clash) throw new Error(`a bundled module declares ${clash[1]}, which the bundle's banner defines`);
  return assets;
};

const copyAssets = async (assets: Set<string>) => {
  for (const asset of [...assets].sort()) {
    const from = join(root, asset);
    if (!existsSync(from)) throw new Error(`${asset} is referenced by the API but missing${asset.startsWith("admin/dist") ? ": run pnpm admin:build first" : ""}`);
    await cp(from, join(functionDir, asset), { recursive: true });
    log(`copied ${asset}`);
  }
};

/** Copy each runtime package and its installed platform binaries, dereferencing pnpm's symlinks. */
const copyRuntimePackages = async () => {
  const fromRoot = createRequire(join(root, "package.json"));
  for (const name of RUNTIME_PACKAGES) {
    const manifest = fromRoot.resolve(`${name}/package.json`);
    const dir = dirname(manifest);
    await cp(dir, join(functionDir, "node_modules", name), { recursive: true, dereference: true });
    const { optionalDependencies = {} } = JSON.parse(readFileSync(manifest, "utf8")) as { optionalDependencies?: Record<string, string> };
    const fromPackage = createRequire(manifest);
    const binaries: string[] = [];
    for (const binary of Object.keys(optionalDependencies)) {
      let binaryManifest: string;
      try {
        binaryManifest = fromPackage.resolve(`${binary}/package.json`);
      } catch {
        continue;
      }
      await cp(dirname(binaryManifest), join(functionDir, "node_modules", binary), { recursive: true, dereference: true });
      binaries.push(binary);
    }
    log(`copied ${name} with ${binaries.join(", ") || "no platform binary"}`);
    if (!binaries.some((b) => b.endsWith(`-${DEPLOY_BINARY}`))) {
      const message = `${name}-${DEPLOY_BINARY} is not installed, so this output only runs on this machine. Vercel's build (Linux x64) installs it.`;
      if (process.env.VERCEL === "1") throw new Error(message);
      console.warn(`vercel-build: warning: ${message}`);
    }
  }
};

/** A relative PERSISTED_OPERATIONS_FILE is copied to the same path inside the function (see src/vercel/env.ts). */
const copyPersistedOperations = async () => {
  const file = process.env.PERSISTED_OPERATIONS_FILE?.trim();
  if (!file) return;
  if (isAbsolute(file)) throw new Error("PERSISTED_OPERATIONS_FILE must be relative to the project to be deployed with the function");
  await cp(join(root, file), join(functionDir, file));
  log(`copied ${file}`);
};

const writeFunctionConfig = () =>
  writeFile(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(
      {
        runtime: "nodejs24.x",
        handler: "index.mjs",
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        shouldAddSourcemapSupport: true,
        // GraphQL subscriptions stream server-sent events.
        supportsResponseStreaming: true,
        // Hobby's maximum. A subscription stream ends here and its client reconnects.
        maxDuration: 300,
      },
      null,
      2,
    )}\n`,
  );

/** Everything in admin/dist except index.html, which the function serves with a per-request CSP. */
const copyStaticAdmin = async () => {
  const target = join(output, "static/admin");
  let files = 0;
  for (const entry of await readdir(adminDist)) {
    if (entry === "index.html") continue;
    await cp(join(adminDist, entry), join(target, entry), { recursive: true });
    files += statSync(join(adminDist, entry)).isDirectory() ? (await readdir(join(adminDist, entry))).length : 1;
  }
  log(`copied ${files} admin files to static/admin`);
};

/** Once a day, the most Hobby plans allow: a more frequent schedule fails the deployment. */
const DEFAULT_CRON_SCHEDULE = "0 5 * * *";

/**
 * Daily by default, so a first deployment works on any plan: traffic and changes run the worker in
 * between. Pro and Enterprise plans can set "* * * * *" for scheduled content to the minute.
 */
const cronSchedule = () => {
  const schedule = process.env.WORKER_CRON_SCHEDULE?.trim() || DEFAULT_CRON_SCHEDULE;
  if (["off", "none", "false"].includes(schedule)) return null;
  if (schedule.split(/\s+/).length !== 5) throw new Error(`WORKER_CRON_SCHEDULE must be a five-field cron expression or "off" (got ${schedule})`);
  return schedule;
};

const writeOutputConfig = async () => {
  const schedule = cronSchedule();
  const config = {
    version: 3,
    routes: [
      // Hashed file names: cache forever.
      { src: "^/admin/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
      { handle: "filesystem" },
      // A chunk from an older deployment is gone: a plain 404, not the app or the function.
      { src: "^/admin/assets/(.*)$", status: 404, headers: { "cache-control": "no-store" } },
      // Everything else goes to the function, at its original path.
      { src: "^/(.*)$", dest: FUNCTION_ROUTE },
    ],
    ...(schedule ? { crons: [{ path: WORKER_PATH, schedule }] } : {}),
  };
  await writeFile(join(output, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  log(schedule ? `cron: ${WORKER_PATH} on "${schedule}"${schedule === DEFAULT_CRON_SCHEDULE ? ' (Pro plans: WORKER_CRON_SCHEDULE="* * * * *" runs it every minute)' : ""}` : "cron: off");
};

const prepareDatabaseForDeploy = async () => {
  const { migrationDatabaseUrlFromEnv } = await import("../src/config.ts");
  const { default: ecom } = await import("../ecom.config.ts");
  const url = migrationDatabaseUrlFromEnv(process.env);
  const postgres = !!url && /^postgres(ql)?:\/\//.test(url);
  const requested = process.env.MIGRATE_ON_BUILD?.trim();
  // A preview shares the production database unless it has its own (Neon branching): its
  // migrations, from an unmerged branch, must not run there unless asked for.
  const preview = process.env.VERCEL_ENV === "preview";
  const migrate = requested ? truthy(requested) : postgres && !preview;
  const admin = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() && process.env.BOOTSTRAP_ADMIN_PASSWORD ? { email: process.env.BOOTSTRAP_ADMIN_EMAIL.trim(), password: process.env.BOOTSTRAP_ADMIN_PASSWORD, name: process.env.BOOTSTRAP_ADMIN_NAME?.trim() || undefined } : undefined;
  const demo = truthy(process.env.BOOTSTRAP_DEMO_DATA);
  if (!migrate) {
    if (!postgres) log("migrations: skipped (no PostgreSQL URL)");
    else if (requested) log("migrations: skipped (MIGRATE_ON_BUILD is off)");
    else log("migrations: skipped on a preview build; set MIGRATE_ON_BUILD=true for previews that have their own database (Neon branching)");
    if (admin) console.warn("vercel-build: warning: BOOTSTRAP_ADMIN_* is ignored when migrations are skipped");
    if (demo) console.warn("vercel-build: warning: BOOTSTRAP_DEMO_DATA is ignored when migrations are skipped");
    return;
  }
  if (!postgres) throw new Error("MIGRATE_ON_BUILD needs DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING, DATABASE_URL or POSTGRES_URL set to a PostgreSQL URL");
  const { prepareDatabase } = await import("../src/vercel/database.ts");
  const started = Date.now();
  const result = await prepareDatabase(url, { admin, demo, plugins: ecom.plugins });
  log(`migrations: applied${result.plugins.length ? `, with plugin migrations ${result.plugins.join(", ")}` : ""}`);
  if (admin) log(result.admin ? `created the first admin, ${result.admin.email}: remove BOOTSTRAP_ADMIN_PASSWORD now` : "BOOTSTRAP_ADMIN_*: staff users exist already, nothing created");
  if (demo) log(result.demo ? `demo data: added ${result.demo.products} products and ${result.demo.orders} orders` : "BOOTSTRAP_DEMO_DATA: the store has channels already, nothing added");
  log(`database ready in ${Date.now() - started} ms`);
};

const buildOutput = async () => {
  if (!existsSync(join(adminDist, "index.html"))) throw new Error("admin/dist/index.html is missing: run pnpm admin:build first (pnpm vercel:build does)");
  const started = Date.now();
  await rm(output, { recursive: true, force: true });
  await mkdir(functionDir, { recursive: true });
  const assets = await bundle();
  await copyAssets(assets);
  await copyRuntimePackages();
  await copyPersistedOperations();
  await writeFunctionConfig();
  await copyStaticAdmin();
  await writeOutputConfig();
  log(`wrote .vercel/output in ${Date.now() - started} ms`);
  await prepareDatabaseForDeploy();
};

/** Checks run against the built function; `seeded` ones need the demo data. */
const SMOKE_CHECKS = String.raw`
  const json = (body) => { try { return JSON.parse(body); } catch { return null; } };
  const gql = (query, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query }) });
  const https = { "x-forwarded-proto": "https" };
  await check("GET /health", "/health", {}, (r, b) => (r.status === 200 && json(b)?.database === "pglite" ? null : b));
  // An empty database has no channel, so the API answers with a GraphQL error; seeded, with data.
  await check("POST /graphql", "/graphql", gql("{ __typename }"), (r, b) => (json(b)?.data?.__typename === "Query" || json(b)?.errors?.[0]?.extensions?.code === "NOT_FOUND" ? null : b));
  await check("GET /admin/ (per-request CSP)", "/admin/", { headers: https }, (r, b) => (r.status === 200 && b.includes('<div id="root">') && (r.headers.get("content-security-policy") ?? "").includes("frame-src 'self'") ? null : "no page or CSP"));
  await check("GET /admin/orders (client-side route)", "/admin/orders", { headers: https }, (r) => (r.status === 200 && r.headers.get("content-security-policy") ? null : "no app page"));
  await check("GET /admin/assets/missing.js", "/admin/assets/missing.js", {}, (r) => (r.status === 404 ? null : "expected 404"));
  await check("GET /visual-editing/bridge.js", "/visual-editing/bridge.js", {}, (r, b) => (r.status === 200 && b.includes("EcomVisualEditing") ? null : "no bridge"));
  await check("GET " + WORKER_PATH + " without the secret", WORKER_PATH, {}, (r) => (r.status === 401 ? null : "expected 401"));
  await check("GET " + WORKER_PATH, WORKER_PATH, { headers: { authorization: "Bearer " + CRON_SECRET } }, (r, b) => (r.status === 200 && json(b)?.ok ? null : b));
  if (SEEDED) {
    await check("POST /graphql products", "/graphql", gql("{ products(first: 2) { totalCount } }", { "x-channel": "us" }), (r, b) => (json(b)?.data?.products?.totalCount > 0 ? null : b));
    let token = null;
    await check("POST /admin/auth/login (argon2, Secure cookie)", "/admin/auth/login", { method: "POST", headers: { "content-type": "application/json", ...https }, body: JSON.stringify(ADMIN) }, (r, b) => {
      token = json(b)?.accessToken ?? null;
      const cookie = r.headers.get("set-cookie") ?? "";
      return token && /;\s*Secure/i.test(cookie) && /HttpOnly/i.test(cookie) ? null : "status " + r.status + ", cookie: " + cookie + " " + b;
    });
    await check("POST /admin/graphql as staff", "/admin/graphql", gql("{ channels { code } }", { authorization: "Bearer " + token }), (r, b) => (json(b)?.data?.channels?.length >= 1 ? null : b));
    // The bundled Blob SDK signs a client token locally (BLOB_READ_WRITE_TOKEN is a dummy here).
    const upload = 'mutation { mediaUploadCreate(input: { filename: "smoke.png", contentType: "image/png", size: 1024 }) { ... on MediaUploadPayload { upload { provider pathname clientToken } } } }';
    await check("POST /admin/graphql mediaUploadCreate (Vercel Blob)", "/admin/graphql", gql(upload, { authorization: "Bearer " + token }), (r, b) => {
      const target = json(b)?.data?.mediaUploadCreate?.upload;
      return target?.provider === "VERCEL_BLOB" && target.pathname?.startsWith("media/") && target.clientToken?.startsWith("vercel_blob_client_") ? null : b;
    });
  }
`;

/**
 * Run the built function behind a local HTTP server, on an empty in-memory database and then a
 * seeded PGlite one. PGlite isn't bundled: Node finds it because .vercel is inside the project.
 */
const smokeTest = async () => {
  const entry = join(functionDir, "index.mjs");
  if (!existsSync(entry)) throw new Error("No build output: run pnpm vercel:build first");
  const scratch = await mkdtemp(join(tmpdir(), "ecom-vercel-smoke-"));
  const admin = { email: "smoke@example.com", password: "smoke-admin-password-123" };
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LOG_LEVEL: "warn" };
  const cronSecret = "smoke-cron-secret";
  const run = (databaseUrl: string, seeded: boolean) => {
    const script = join(scratch, `smoke-${seeded ? "seeded" : "memory"}.mjs`);
    writeFileSync(
      script,
      `import { createServer } from "node:http";
const SEEDED = ${seeded}, CRON_SECRET = ${JSON.stringify(cronSecret)}, ADMIN = ${JSON.stringify(admin)}, WORKER_PATH = ${JSON.stringify(WORKER_PATH)};
const { default: handler } = await import(${JSON.stringify(pathToFileURL(entry).href)});
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
let failed = 0;
const check = async (name, path, init, test) => {
  const response = await fetch(base + path, init);
  const problem = test(response, await response.text());
  if (problem) failed++;
  console.log((problem ? "  FAIL " : "  ok   ") + name + " → " + response.status + (problem ? ": " + String(problem).slice(0, 300) : ""));
};
${SMOKE_CHECKS}
server.close();
process.exit(failed ? 1 : 0);
`,
    );
    log(`smoke test (${seeded ? "a seeded PGlite database" : "DATABASE_URL=memory:"})`);
    const env = {
      ...baseEnv,
      DATABASE_URL: databaseUrl,
      JWT_SECRET: "smoke-test-secret-smoke-test-secret",
      CRON_SECRET: cronSecret,
      // Media on Vercel Blob; nothing is uploaded, so the token only has to look like one.
      ...(seeded ? { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_smoke_notarealsecret" } : {}),
    };
    return spawnSync(process.execPath, [script], { cwd: root, env, stdio: "inherit", timeout: 120_000 }).status === 0;
  };
  try {
    const memory = run("memory:", false);
    const database = `pglite:${join(scratch, "db")}`;
    const seed = spawnSync(process.execPath, [join(root, "src/db/seed.ts")], {
      cwd: root,
      env: { ...baseEnv, DATABASE_URL: database, SEED_ADMIN_EMAIL: admin.email, SEED_ADMIN_PASSWORD: admin.password },
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 300_000,
    });
    if (seed.status !== 0) throw new Error("seeding the smoke test database failed");
    const seeded = run(database, true);
    if (!memory || !seeded) throw new Error("smoke test failed");
    log("smoke test passed");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

try {
  if (process.argv.includes("--smoke")) await smokeTest();
  else await buildOutput();
} catch (error) {
  console.error(`vercel-build: ${(error as Error).message}`);
  process.exit(1);
}
