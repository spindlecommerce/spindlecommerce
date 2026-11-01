import { jwtVerify, SignJWT } from "jose";
import type { Config } from "../../config.ts";
import { AuthenticationError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import type { Frontend } from "./frontends.ts";

export type PreviewClaims = {
  staffId: string;
  /** Evaluate scheduled visibility at this time instead of now. */
  at: string | null;
  /** A template being edited: product or category pages render with it instead of their own. */
  templateId: string | null;
  expiresAt: Date;
};

export const PREVIEW_TTL_SECONDS = 2 * 60 * 60;
const AUDIENCE = "ecom:preview";

/**
 * A short-lived, read-only token for draft content. Frontends keep it in an httpOnly cookie and
 * send it as `x-preview-token`.
 */
export const createPreviewToken = async (config: Config, input: { staffId: string; at?: string | null; templateId?: string | null; ttlSeconds?: number }) => {
  const ttl = Math.min(input.ttlSeconds ?? PREVIEW_TTL_SECONDS, 24 * 60 * 60);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({ typ: "preview", ...(input.at ? { at: input.at } : {}), ...(input.templateId ? { tpl: input.templateId } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.staffId)
    .setIssuer("ecom")
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(newId())
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(config.jwtSecret);
  return { token, expiresAt };
};

export const verifyPreviewToken = async (config: Config, token: string): Promise<PreviewClaims> => {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: "ecom", audience: AUDIENCE, algorithms: ["HS256"] });
    if (payload.typ !== "preview" || !payload.sub || !payload.exp) throw new Error("wrong token type");
    return { staffId: payload.sub, at: typeof payload.at === "string" ? payload.at : null, templateId: typeof payload.tpl === "string" ? payload.tpl : null, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    throw new AuthenticationError("The preview link has expired or is invalid; open the preview again from the admin");
  }
};

/** The frontend's preview route, which enables draft mode and redirects to `path`. */
export const previewUrl = (frontend: Pick<Frontend, "url" | "previewPath">, input: { token: string; path: string; locale?: string | null; channel?: string | null }) => {
  // Concatenated, not resolved, so a frontend served under a base path keeps it.
  const url = new URL(`${frontend.url}${frontend.previewPath}`);
  url.searchParams.set("token", input.token);
  url.searchParams.set("path", input.path);
  if (input.locale) url.searchParams.set("locale", input.locale);
  if (input.channel) url.searchParams.set("channel", input.channel);
  return url.toString();
};
