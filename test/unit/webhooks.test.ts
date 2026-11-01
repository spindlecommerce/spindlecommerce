import { describe, expect, it } from "vitest";
import { isPublicWebhookUrl, nextRetryDelayMs, signPayload, verifySignature } from "../../src/modules/integrations/webhooks.ts";
import { EVENT_TYPES, matchesEventPattern } from "../../src/modules/integrations/outbox.ts";

describe("webhooks", () => {
  it("signs payloads so receivers can verify them, and rejects stale or forged signatures", () => {
    const body = JSON.stringify({ type: "order.placed" });
    const header = signPayload("whsec_test", body);
    expect(verifySignature("whsec_test", body, header)).toBe(true);
    expect(verifySignature("whsec_other", body, header)).toBe(false);
    expect(verifySignature("whsec_test", `${body} `, header)).toBe(false);
    expect(verifySignature("whsec_test", body, signPayload("whsec_test", body, Math.floor(Date.now() / 1000) - 3600))).toBe(false);
  });

  it("matches event patterns with prefixes", () => {
    expect(matchesEventPattern("order.*", "order.placed")).toBe(true);
    expect(matchesEventPattern("order.*", "orders.placed")).toBe(false);
    expect(matchesEventPattern("*", "product.updated")).toBe(true);
    expect(matchesEventPattern("product.updated", "product.created")).toBe(false);
  });

  it("does not expose password reset credentials as webhook events", () => {
    expect(EVENT_TYPES).not.toContain("customer.password_reset_requested");
    expect(EVENT_TYPES).not.toContain("staff.password_reset_requested");
  });

  it("refuses internal targets unless private URLs are explicitly allowed", () => {
    const original = process.env.ALLOW_PRIVATE_WEBHOOK_URLS;
    try {
      delete process.env.ALLOW_PRIVATE_WEBHOOK_URLS;
      for (const url of ["http://localhost:8080/x", "http://localhost./x", "http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/x", "http://192.168.1.2/x", "http://172.20.0.1/x", "http://[::1]/x", "http://[::]/x", "http://[::ffff:10.0.0.5]/x", "http://[fe80::1]/x", "http://[febf::1]/x", "http://[fd12::1]/x", "http://metadata.google.internal/x", "http://host.docker.internal:9000/x"]) {
        expect(isPublicWebhookUrl(url), url).toBe(false);
      }
      for (const url of ["https://erp.example.com/hooks", "https://fdshop.com/hooks", "https://8.8.8.8/hooks", "https://[2606:4700:4700::1111]/hooks"]) {
        expect(isPublicWebhookUrl(url), url).toBe(true);
      }
      // The dev container opts in so webhooks can reach receivers on the developer's machine.
      process.env.ALLOW_PRIVATE_WEBHOOK_URLS = "true";
      expect(isPublicWebhookUrl("http://host.docker.internal:9000/x")).toBe(true);
    } finally {
      if (original === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_URLS;
      else process.env.ALLOW_PRIVATE_WEBHOOK_URLS = original;
    }
  });

  it("backs off exponentially up to six hours", () => {
    expect(nextRetryDelayMs(1)).toBeGreaterThanOrEqual(24_000);
    expect(nextRetryDelayMs(1)).toBeLessThanOrEqual(36_000);
    expect(nextRetryDelayMs(30)).toBeLessThanOrEqual(6 * 3600_000 * 1.2);
  });
});
