/**
 * Build the npm copy of @spindlecommerce/plugin-sdk, for plugins written outside an installation:
 * `pnpm sdk:package <dir>`, then `npm stage publish` from <dir> and approve it on npmjs.com.
 *
 * It is built from src/plugins/sdk.ts, the platform's own SDK, with the platform modules it imports
 * swapped for the stand-ins in packages/plugin-sdk/public/, so nothing else of the platform ships.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "packages/plugin-sdk/public");

/** The SDK's relative imports and the published modules that replace them. Others fail the build. */
const STAND_INS: Record<string, string> = {
  "../db/client.ts": "./internal.ts",
  "../graphql/builder.ts": "./internal.ts",
  "../graphql/context.ts": "./internal.ts",
  "../graphql/refs.ts": "./refs.ts",
  "../lib/address.ts": "./internal.ts",
  "../platform.ts": "./internal.ts",
  "../lib/errors.ts": "./errors.ts",
};

/** Packages the published types import, depended on at the platform's versions. */
const TYPE_DEPENDENCIES = ["drizzle-orm", "hono", "pino"];

const packageName = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

/** src/plugins/sdk.ts with its imports pointed at the stand-ins. */
const publishedSource = async () => {
  const source = await readFile(join(root, "src/plugins/sdk.ts"), "utf8");
  if (/\bimport\s*\(/.test(source)) throw new Error("src/plugins/sdk.ts uses import(); the published package supports static imports only");
  return source.replace(/(\bfrom\s+)"([^"]+)"/g, (statement, from: string, specifier: string) => {
    if (!specifier.startsWith(".")) {
      if (!TYPE_DEPENDENCIES.includes(packageName(specifier))) throw new Error(`src/plugins/sdk.ts imports ${specifier}: add it to TYPE_DEPENDENCIES in scripts/plugin-sdk-package.ts`);
      return statement;
    }
    const standIn = STAND_INS[specifier];
    if (!standIn) throw new Error(`src/plugins/sdk.ts imports ${specifier}, which has no public stand-in: add one to packages/plugin-sdk/public/internal.ts and STAND_INS in scripts/plugin-sdk-package.ts`);
    return `${from}"${standIn}"`;
  });
};

/** `GraphQLExtensionApi.refs`: the platform's object refs by name, typed loosely. */
const refsStandIn = async () => {
  const refs = await readFile(join(root, "src/graphql/refs.ts"), "utf8");
  const names = [...refs.matchAll(/^export const (\w+)/gm)].map(([, name]) => name);
  if (!names.length) throw new Error("src/graphql/refs.ts exports no refs");
  return [
    "/** Object refs of the platform's GraphQL types, to add fields to. Typed in an installation. */",
    ...names.map((name) => `export declare const ${name}: any;`),
    "",
  ].join("\n");
};

/**
 * Write the published package into `dir`. Builds in a temporary folder whose node_modules links to
 * the platform's, so the stand-ins' imports resolve.
 */
export const buildPluginSdkPackage = async (dir: string) => {
  if (existsSync(dir) && (await readdir(dir)).length) throw new Error(`${dir} is not empty`);
  const errors = await readFile(join(root, "src/lib/errors.ts"), "utf8");
  if (/^\s*import\b|^\s*export\b.*\bfrom\b/m.test(errors)) throw new Error("src/lib/errors.ts imports other modules; the published package copies it as it is");

  const work = await mkdtemp(join(tmpdir(), "plugin-sdk-"));
  try {
    await symlink(join(root, "node_modules"), join(work, "node_modules"), "dir");
    await writeFile(join(work, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    await writeFile(join(work, "index.ts"), await publishedSource());
    await writeFile(join(work, "refs.ts"), await refsStandIn());
    await writeFile(join(work, "errors.ts"), errors);
    await copyFile(join(publicDir, "internal.ts"), join(work, "internal.ts"));

    const dist = join(dir, "dist");
    await build({
      absWorkingDir: work,
      entryPoints: [join(work, "index.ts")],
      outfile: join(dist, "index.js"),
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      external: TYPE_DEPENDENCIES.flatMap((name) => [name, `${name}/*`]),
      legalComments: "none",
      logLevel: "warning",
    });

    const tsconfig = {
      compilerOptions: {
        target: "es2022",
        lib: ["es2024"],
        module: "nodenext",
        moduleResolution: "nodenext",
        types: ["node"],
        strict: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: ".",
        outDir: dist,
      },
      files: ["index.ts", "internal.ts", "refs.ts", "errors.ts"],
    };
    await writeFile(join(work, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
    try {
      execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(work, "tsconfig.json")], { cwd: work, stdio: "pipe" });
    } catch (error) {
      const output = (error as { stdout?: Buffer }).stdout?.toString() ?? "";
      throw new Error(`The published SDK's types do not compile:\n${output}`, { cause: error });
    }
    // The declarations keep the source's .ts specifiers; the published files are .js.
    for (const file of (await readdir(dist)).filter((name) => name.endsWith(".d.ts"))) {
      const path = join(dist, file);
      const declarations = (await readFile(path, "utf8")).replace(/(\bfrom\s+"\.\/[\w-]+)\.ts"/g, '$1.js"');
      if (/from\s+"\.\.\//.test(declarations)) throw new Error(`dist/${file} reaches outside the package`);
      await writeFile(path, declarations);
    }

    const platform = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { engines: { node: string }; dependencies: Record<string, string> };
    const { version } = JSON.parse(await readFile(join(root, "packages/plugin-sdk/package.json"), "utf8")) as { version: string };
    const manifest = {
      name: "@spindlecommerce/plugin-sdk",
      version,
      description: "The plugin API for SpindleCommerce: payment and shipping providers, integrations, GraphQL fields, routes and scheduled tasks as plugins.",
      keywords: ["spindlecommerce", "ecommerce", "plugin", "sdk"],
      homepage: "https://spindlecommerce.com",
      license: "MIT",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      files: ["dist"],
      engines: { node: platform.engines.node },
      dependencies: Object.fromEntries(TYPE_DEPENDENCIES.map((name) => [name, `^${platform.dependencies[name]}`])),
      publishConfig: { access: "public" },
    };
    await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await copyFile(join(publicDir, "README.md"), join(dir, "README.md"));
    await copyFile(join(publicDir, "LICENSE"), join(dir, "LICENSE"));
    return { version, files: ["package.json", "README.md", "LICENSE", ...(await readdir(dist)).map((file) => `dist/${file}`)] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: pnpm sdk:package <dir>   (an empty or new folder to write the package into)");
    process.exit(1);
  }
  const dir = resolve(process.env.INIT_CWD ?? process.cwd(), target);
  await mkdir(dir, { recursive: true });
  const { version, files } = await buildPluginSdkPackage(dir);
  console.log(`plugin-sdk-package: wrote @spindlecommerce/plugin-sdk@${version} to ${dir}:\n  ${files.join("\n  ")}\nPublish it from there with \`npm stage publish\`, then approve it on npmjs.com.`);
}
