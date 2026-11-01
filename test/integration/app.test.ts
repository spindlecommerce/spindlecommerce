import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../../src/app.ts";
import { createTestPlatform } from "../helpers/platform.ts";

let app: App;
beforeAll(async () => {
  const { platform } = await createTestPlatform();
  app = await createApp({ platform, basePath: "/api" });
});
afterAll(() => app.close());

describe("HTTP app", () => {
  it("mounts under a base path, as inside a Next.js route handler", async () => {
    const health = await app.fetch(new Request("http://ecom.test/api/health"));
    expect(await health.json()).toEqual({ status: "ok", database: "pglite" });
    const response = await app.fetch(
      new Request("http://ecom.test/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ localization { channel { code } } }" }) }),
    );
    expect((await response.json()).data).toEqual({ localization: { channel: { code: "us" } } });
    expect((await app.fetch(new Request("http://ecom.test/graphql"))).status).toBe(404);
  });

  it("answers CORS preflight for storefront clients and sets security headers", async () => {
    const preflight = await app.fetch(
      new Request("http://ecom.test/api/graphql", { method: "OPTIONS", headers: { origin: "https://shop.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-channel" } }),
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-channel");
    const response = await app.fetch(new Request("http://ecom.test/api/health"));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
