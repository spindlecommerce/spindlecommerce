import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as installed from "@spindlecommerce/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { Address as PublishedAddress } from "../../packages/plugin-sdk/public/internal.ts";
import { buildPluginSdkPackage } from "../../scripts/plugin-sdk-package.ts";
import type { Address } from "../../src/lib/address.ts";
import * as sdk from "../../src/plugins/sdk.ts";

/** True only when A and B are the same type. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The published package spells Address out; `pnpm typecheck` fails here when the two drift apart.
const sameAddress: Same<PublishedAddress, Address> = true;

describe("@spindlecommerce/plugin-sdk", () => {
  it("is the platform's own SDK in an installation, so plugin packages share its classes", () => {
    expect(installed.ValidationError).toBe(sdk.ValidationError);
    expect(installed.PaymentDeclinedError).toBe(sdk.PaymentDeclinedError);
    expect(installed.definePlugin).toBe(sdk.definePlugin);
  });

  it("has the plugin API version as its major version", async () => {
    const { version } = JSON.parse(await readFile(new URL("../../packages/plugin-sdk/package.json", import.meta.url), "utf8")) as { version: string };
    expect(Number(version.split(".")[0])).toBe(sdk.PLUGIN_API_VERSION);
  });

  it("publishes the platform's Address", () => {
    expect(sameAddress).toBe(true);
  });

  it("builds the published copy from the SDK, with nothing else of the platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plugin-sdk-test-"));
    try {
      const { files } = await buildPluginSdkPackage(dir);
      expect(files).toEqual(expect.arrayContaining(["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/internal.d.ts"]));

      const published = (await import(pathToFileURL(join(dir, "dist/index.js")).href)) as typeof sdk;
      expect(Object.keys(published).sort()).toEqual(Object.keys(sdk).sort());
      expect(published.PLUGIN_API_VERSION).toBe(sdk.PLUGIN_API_VERSION);
      expect(new published.ValidationError("Bad input", [{ path: ["name"], message: "Required" }]).fieldErrors).toHaveLength(1);

      const types = await readFile(join(dir, "dist/index.d.ts"), "utf8");
      expect(types).not.toMatch(/from "\.\.\//);
      expect(types).toContain('from "./internal.js"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
