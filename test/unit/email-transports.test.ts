import pino from "pino";
import { describe, expect, it } from "vitest";
import type { EmailContext } from "../../plugins/email/settings.ts";
import { checkTransport, transmit, TransportError, type OutgoingEmail } from "../../plugins/email/transports.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** A minimal transport context whose fetch records each request and answers with `reply`. */
const setup = (settings: Partial<EmailContext["settings"]>, reply: (call: Call) => Response | Promise<Response> = () => Response.json({})) => {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return reply(call);
  }) as typeof globalThis.fetch;
  const ctx = { settings: { transport: "log", ...settings }, fetch, logger: pino({ level: "silent" }) } as unknown as EmailContext;
  return { ctx, calls };
};

const email: OutgoingEmail = {
  from: "Ecom <orders@shop.example.test>",
  replyTo: "help@shop.example.test",
  to: "sam@example.test",
  subject: "Order US-000001 confirmed",
  html: "<p>Hi</p>",
  text: "Hi",
  template: "order_confirmation",
  idempotencyKey: "event-1:order_confirmation:sam@example.test",
};

describe("email transports", () => {
  it("sends with Resend", async () => {
    const { ctx, calls } = setup({ transport: "resend", resendApiKey: "re_test_123", from: email.from }, () => Response.json({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
    await expect(transmit(ctx, email)).resolves.toEqual({ messageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.resend.com/emails");
    expect(call!.method).toBe("POST");
    expect(call!.headers).toMatchObject({ authorization: "Bearer re_test_123", "content-type": "application/json", "idempotency-key": "event-1:order_confirmation:sam@example.test" });
    expect(call!.body).toEqual({
      from: "Ecom <orders@shop.example.test>",
      to: ["sam@example.test"],
      subject: "Order US-000001 confirmed",
      html: "<p>Hi</p>",
      text: "Hi",
      reply_to: "help@shop.example.test",
      tags: [{ name: "template", value: "order_confirmation" }],
    });
  });

  it("sends with Postmark on the outbound stream", async () => {
    const { ctx, calls } = setup({ transport: "postmark", postmarkServerToken: "pm-token", from: email.from }, () =>
      Response.json({ To: email.to, SubmittedAt: "2026-10-26T12:00:00Z", MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817", ErrorCode: 0, Message: "OK" }),
    );
    await expect(transmit(ctx, { ...email, replyTo: null })).resolves.toEqual({ messageId: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817" });
    const [call] = calls;
    expect(call!.url).toBe("https://api.postmarkapp.com/email");
    expect(call!.method).toBe("POST");
    expect(call!.headers).toMatchObject({ accept: "application/json", "content-type": "application/json", "x-postmark-server-token": "pm-token" });
    expect(call!.body).toEqual({ From: email.from, To: "sam@example.test", Subject: email.subject, HtmlBody: "<p>Hi</p>", TextBody: "Hi", Tag: "order_confirmation", MessageStream: "outbound" });
  });

  it("reports provider errors, unreachable providers and missing settings", async () => {
    const rejected = setup({ transport: "resend", resendApiKey: "re_x", from: email.from }, () =>
      Response.json({ statusCode: 422, name: "validation_error", message: "Invalid `to` field." }, { status: 422 }),
    );
    await expect(transmit(rejected.ctx, email)).rejects.toThrow(new TransportError("Resend answered 422: Invalid `to` field."));

    const postmark = setup({ transport: "postmark", postmarkServerToken: "pm", from: email.from }, () => Response.json({ ErrorCode: 406, Message: "You tried to send to inactive recipient(s)." }, { status: 422 }));
    await expect(transmit(postmark.ctx, email)).rejects.toThrow("Postmark answered 422: You tried to send to inactive recipient(s).");

    const down = setup({ transport: "resend", resendApiKey: "re_x", from: email.from }, () => {
      throw new TypeError("fetch failed");
    });
    await expect(transmit(down.ctx, email)).rejects.toThrow("Resend could not be reached: fetch failed");

    const noKey = setup({ transport: "resend", from: email.from });
    await expect(transmit(noKey.ctx, email)).rejects.toThrow(/RESEND_API_KEY/);
    expect(noKey.calls).toHaveLength(0);
    const noToken = setup({ transport: "postmark", from: email.from });
    await expect(transmit(noToken.ctx, email)).rejects.toThrow(/POSTMARK_SERVER_TOKEN/);
    const noFrom = setup({ transport: "resend", resendApiKey: "re_x", from: "  " });
    await expect(transmit(noFrom.ctx, email)).rejects.toThrow(/Set From/);
    const badFrom = setup({ transport: "resend", resendApiKey: "re_x", from: "Shop" });
    await expect(transmit(badFrom.ctx, email)).rejects.toThrow(/not an email address/);
  });

  it("only records with the log transport", async () => {
    const { ctx, calls } = setup({ transport: "log" });
    await expect(transmit(ctx, { ...email, from: "" })).resolves.toEqual({ messageId: null });
    expect(calls).toHaveLength(0);
  });

  it("checks the connection", async () => {
    expect(await checkTransport(setup({ transport: "log" }).ctx)).toMatchObject({ ok: true, message: expect.stringContaining("nothing is sent") });
    expect(await checkTransport(setup({ transport: "resend", from: email.from }).ctx)).toMatchObject({ ok: false, message: expect.stringContaining("RESEND_API_KEY") });

    const domains = (status: string) => () => Response.json({ object: "list", data: [{ id: "d1", name: "shop.example.test", status }] });
    const verified = setup({ transport: "resend", resendApiKey: "re_x", from: email.from }, domains("verified"));
    expect(await checkTransport(verified.ctx)).toEqual({ ok: true, message: "Resend: the API key works and shop.example.test is verified." });
    expect(verified.calls[0]).toMatchObject({ url: "https://api.resend.com/domains", method: "GET", headers: { authorization: "Bearer re_x" } });
    expect(await checkTransport(setup({ transport: "resend", resendApiKey: "re_x", from: email.from }, domains("pending")).ctx)).toMatchObject({ ok: false, message: expect.stringContaining("pending") });
    expect(await checkTransport(setup({ transport: "resend", resendApiKey: "re_x", from: "a@other.test" }, domains("verified")).ctx)).toMatchObject({
      ok: false,
      message: expect.stringContaining("other.test is not set up"),
    });
    const restricted = () => Response.json({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 });
    expect(await checkTransport(setup({ transport: "resend", resendApiKey: "re_x", from: email.from }, restricted).ctx)).toMatchObject({ ok: true });
    const invalid = () => Response.json({ statusCode: 400, name: "validation_error", message: "API key is invalid" }, { status: 400 });
    expect(await checkTransport(setup({ transport: "resend", resendApiKey: "re_x", from: email.from }, invalid).ctx)).toEqual({ ok: false, message: "Resend answered 400: API key is invalid" });

    const server = setup({ transport: "postmark", postmarkServerToken: "pm", from: email.from }, () => Response.json({ ID: 1, Name: "Ecom production" }));
    expect(await checkTransport(server.ctx)).toMatchObject({ ok: true, message: expect.stringContaining('server "Ecom production"') });
    expect(server.calls[0]).toMatchObject({ url: "https://api.postmarkapp.com/server", method: "GET", headers: { "x-postmark-server-token": "pm" } });
    const badToken = () => Response.json({ ErrorCode: 10, Message: "No Account or Server API tokens were supplied in the HTTP headers." }, { status: 401 });
    expect(await checkTransport(setup({ transport: "postmark", postmarkServerToken: "pm", from: email.from }, badToken).ctx)).toMatchObject({ ok: false, message: expect.stringContaining("Postmark answered 401") });
  });
});
