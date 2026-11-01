import { addressOf, value, type EmailContext } from "./settings.ts";

export type Transport = "log" | "resend" | "postmark";
export type OutgoingEmail = { from: string; replyTo: string | null; to: string; subject: string; html: string; text: string; template: string; idempotencyKey?: string };
export type SendResult = { messageId: string | null };

const TIMEOUT_MS = 10_000;
export const RESEND_API = "https://api.resend.com";
export const POSTMARK_API = "https://api.postmarkapp.com";
export const PROVIDER_NAMES: Record<Transport, string> = { log: "the log transport", resend: "Resend", postmark: "Postmark" };

/** A send failure whose message is fit to show staff as is. */
export class TransportError extends Error {}

const call = async (ctx: EmailContext, provider: string, url: string, init: RequestInit) => {
  let response: Response;
  try {
    response = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new TransportError(`${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, body };
};

const failure = (provider: string, response: Response, body: Record<string, unknown> | null) => {
  const detail = body && (typeof body.message === "string" ? body.message : typeof body.Message === "string" ? body.Message : null);
  return new TransportError(`${provider} answered ${response.status}${detail ? `: ${detail}` : ""}`);
};

/** What the active transport needs before it can send; null when it is ready. */
export const missingSetting = (ctx: EmailContext): string | null => {
  const { transport } = ctx.settings;
  if (transport === "log") return null;
  if (transport === "resend" && !value(ctx.settings.resendApiKey)) return "Resend needs an API key: set RESEND_API_KEY or the Resend API key setting";
  if (transport === "postmark" && !value(ctx.settings.postmarkServerToken)) return "Postmark needs a server token: set POSTMARK_SERVER_TOKEN or the Postmark server token setting";
  const from = value(ctx.settings.from);
  if (!from) return `Set From (e.g. Shop <orders@example.com>) to a sender on a domain verified with ${PROVIDER_NAMES[transport]}`;
  if (!addressOf(from)) return `From is not an email address: "${from}"`;
  return null;
};

const resend = async (ctx: EmailContext, email: OutgoingEmail): Promise<SendResult> => {
  const { response, body } = await call(ctx, "Resend", `${RESEND_API}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${value(ctx.settings.resendApiKey)}`,
      "content-type": "application/json",
      // Resend ignores a repeated key for 24 hours, so retrying a lost response won't send twice.
      ...(email.idempotencyKey ? { "idempotency-key": email.idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify({
      from: email.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      tags: [{ name: "template", value: email.template }],
    }),
  });
  if (!response.ok) throw failure("Resend", response, body);
  return { messageId: typeof body?.id === "string" ? body.id : null };
};

const postmark = async (ctx: EmailContext, email: OutgoingEmail): Promise<SendResult> => {
  const { response, body } = await call(ctx, "Postmark", `${POSTMARK_API}/email`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": value(ctx.settings.postmarkServerToken)! },
    body: JSON.stringify({
      From: email.from,
      To: email.to,
      Subject: email.subject,
      HtmlBody: email.html,
      TextBody: email.text,
      ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
      Tag: email.template,
      MessageStream: "outbound",
    }),
  });
  // Postmark reports some rejections with 200 and a non-zero ErrorCode.
  if (!response.ok || (typeof body?.ErrorCode === "number" && body.ErrorCode !== 0)) throw failure("Postmark", response, body);
  return { messageId: typeof body?.MessageID === "string" ? body.MessageID : null };
};

/** The log transport sends nothing; the message log is the record. */
export const transmit = async (ctx: EmailContext, email: OutgoingEmail): Promise<SendResult> => {
  const transport = ctx.settings.transport;
  if (transport === "log") {
    ctx.logger.info({ template: email.template, to: email.to, subject: email.subject }, "email logged (log transport, not sent)");
    return { messageId: null };
  }
  const missing = missingSetting(ctx);
  if (missing) throw new TransportError(missing);
  return transport === "resend" ? resend(ctx, email) : postmark(ctx, email);
};

/** "Test connection": the transport in use, and whether its key works. */
export const checkTransport = async (ctx: EmailContext): Promise<{ ok: boolean; message: string }> => {
  const { transport } = ctx.settings;
  if (transport === "log") return { ok: true, message: "Log transport: emails are recorded in the message log and nothing is sent. Pick Resend or Postmark to send." };
  const missing = missingSetting(ctx);
  if (missing) return { ok: false, message: missing };
  try {
    if (transport === "resend") return await checkResend(ctx);
    const { response, body } = await call(ctx, "Postmark", `${POSTMARK_API}/server`, {
      headers: { accept: "application/json", "x-postmark-server-token": value(ctx.settings.postmarkServerToken)! },
    });
    if (!response.ok) return { ok: false, message: failure("Postmark", response, body).message };
    return { ok: true, message: `Postmark: the token works for the server "${String(body?.Name ?? "?")}". Make sure ${addressOf(value(ctx.settings.from)!)} is a confirmed sender signature or domain there.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const checkResend = async (ctx: EmailContext) => {
  const { response, body } = await call(ctx, "Resend", `${RESEND_API}/domains`, { headers: { authorization: `Bearer ${value(ctx.settings.resendApiKey)}` } });
  // Keys with "sending access" only may not list domains; they still send.
  if (response.status === 401 && body?.name === "restricted_api_key") return { ok: true, message: "Resend: the API key works (sending access only, so its domains cannot be checked)." };
  if (!response.ok) return { ok: false, message: failure("Resend", response, body).message };
  const domains = (Array.isArray(body?.data) ? body.data : []) as { name?: string; status?: string }[];
  const sender = addressOf(value(ctx.settings.from)!)!.split("@")[1]!.toLowerCase();
  const domain = domains.find((d) => d.name?.toLowerCase() === sender);
  if (!domain) {
    const known = domains.map((d) => `${d.name} (${d.status})`).join(", ") || "none";
    return { ok: false, message: `Resend: the API key works, but the sender domain ${sender} is not set up there (domains: ${known}). Add it and its DNS records in Resend.` };
  }
  if (domain.status !== "verified") return { ok: false, message: `Resend: the sender domain ${sender} is ${domain.status}, not verified yet. Check its DNS records in Resend.` };
  return { ok: true, message: `Resend: the API key works and ${sender} is verified.` };
};
