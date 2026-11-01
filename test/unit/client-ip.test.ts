import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp } from "../../src/http/client-ip.ts";

// Called in-process, so there is no connection address: "null" stands for it.
const app = new Hono().get("/", (c) => c.text(String(clientIp(c, Number(c.req.query("trust"))))));
const ip = async (trust: number, forwarded?: string) => (await app.request(`/?trust=${trust}`, { headers: forwarded ? { "x-forwarded-for": forwarded } : {} })).text();

describe("client IP", () => {
  it("uses the connection's address unless proxies are trusted", async () => {
    expect(await ip(0, "203.0.113.7")).toBe("null");
  });

  it("counts trusted proxies back from the end of X-Forwarded-For, past what the client sent", async () => {
    const forwarded = "203.0.113.7, 198.51.100.4,192.0.2.9";
    expect(await ip(1, forwarded)).toBe("192.0.2.9");
    expect(await ip(2, forwarded)).toBe("198.51.100.4");
    expect(await ip(5, forwarded)).toBe("203.0.113.7");
    expect(await ip(1)).toBe("null");
  });
});
