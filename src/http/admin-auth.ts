import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { DomainError } from "../lib/errors.ts";
import { toGlobalId } from "../lib/ids.ts";
import { recordAudit, type AuditRecord } from "../modules/audit/service.ts";
import { revokeRefreshToken, rotateRefreshToken, type Session } from "../modules/auth/service.ts";
import { beginStaffSignIn, completeStaffSignIn, getStaffUser, requestStaffPasswordReset, resetStaffPassword, type StaffUser } from "../modules/staff/service.ts";
import type { Platform } from "../platform.ts";
import { clientIp } from "./client-ip.ts";

/**
 * Browser sign-in for the admin app. The refresh token stays in an httpOnly, SameSite=Strict cookie
 * scoped to these routes; the app keeps only the access token, in memory.
 *
 * CSRF: every route also requires a JSON body or X-Requested-With, which a cross-origin page can't
 * send without a CORS preflight this API refuses.
 */
export const ADMIN_SESSION_COOKIE = "ecom_admin_rt";

type Auth = { platform: Platform; base: string };

const credentials = z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(256) });
const verification = z.object({ challengeToken: z.string().min(1), code: z.string().trim().min(1).max(32) });
const resetRequest = z.object({ email: z.string().trim().min(1).max(254) });
const reset = z.object({ token: z.string().min(1), password: z.string().min(1).max(256) });

const fail = (c: Context, status: 400 | 401 | 403 | 415, code: string, message: string) => c.json({ error: { code, message } }, status);

const guard = (c: Context): Response | null => {
  const json = c.req.header("content-type")?.toLowerCase().startsWith("application/json");
  if (!json && c.req.header("x-requested-with") !== "ecom-admin") return fail(c, 415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON or the X-Requested-With: ecom-admin header");
  return null;
};

const body = async <S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | null> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
};

const staffJson = (user: StaffUser) => ({ id: toGlobalId("StaffUser", user.id), email: user.email, name: user.name });

const startSession = (c: Context, auth: Auth, session: Session, user: StaffUser) => {
  setCookie(c, ADMIN_SESSION_COOKIE, session.refreshToken, {
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:" || process.env.NODE_ENV === "production",
    path: `${auth.base}/admin/auth`,
    expires: session.refreshTokenExpiresAt,
  });
  return c.json({ staffUser: staffJson(user), accessToken: session.accessToken, accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString() });
};

const endSession = (c: Context, auth: Auth) => deleteCookie(c, ADMIN_SESSION_COOKIE, { path: `${auth.base}/admin/auth` });

const audit = (c: Context, auth: Auth, entry: Omit<AuditRecord, "ip" | "userAgent">) =>
  recordAudit(auth.platform.db, { ...entry, ip: clientIp(c, auth.platform.config.trustProxy), userAgent: c.req.header("user-agent") ?? null }).catch((err: unknown) =>
    auth.platform.logger.error({ err }, "audit log write failed"),
  );

const errorCode = (error: unknown) => (error instanceof DomainError ? error.code : "INTERNAL_SERVER_ERROR");

export const mountAdminAuth = (app: Hono, auth: Auth) => {
  const { db, config } = auth.platform;
  const route = (path: string) => `${auth.base}/admin/auth/${path}`;

  app.post(route("login"), async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    const input = await body(c, credentials);
    if (!input) return fail(c, 400, "VALIDATION_FAILED", "Send an email and password");
    try {
      const result = await beginStaffSignIn(db, config, input.email, input.password);
      await audit(c, auth, { actorType: "staff", actorId: result.staffUser.id, actorLabel: result.staffUser.email, operation: "staffLogin", targetType: "StaffUser", targetId: result.staffUser.id, outcome: "success", input: { email: input.email } });
      if (result.kind === "challenge") {
        return c.json({ twoFactorRequired: true, challengeToken: result.challengeToken, expiresAt: result.expiresAt.toISOString() });
      }
      return startSession(c, auth, result.session, result.staffUser);
    } catch (error) {
      await audit(c, auth, { actorType: "anonymous", actorId: null, actorLabel: input.email, operation: "staffLogin", outcome: "error", errorCode: errorCode(error), input: { email: input.email } });
      if (error instanceof DomainError) return fail(c, 401, error.code, error.message);
      throw error;
    }
  });

  app.post(route("verify"), async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    const input = await body(c, verification);
    if (!input) return fail(c, 400, "VALIDATION_FAILED", "Send the challenge token and a code");
    try {
      const result = await completeStaffSignIn(db, config, input.challengeToken, input.code);
      await audit(c, auth, { actorType: "staff", actorId: result.staffUser.id, actorLabel: result.staffUser.email, operation: "staffLoginVerify", targetType: "StaffUser", targetId: result.staffUser.id, outcome: "success" });
      return startSession(c, auth, result.session, result.staffUser);
    } catch (error) {
      await audit(c, auth, { actorType: "anonymous", actorId: null, actorLabel: null, operation: "staffLoginVerify", outcome: "error", errorCode: errorCode(error) });
      if (error instanceof DomainError) return fail(c, 401, error.code, error.message);
      throw error;
    }
  });

  /** A new access token for the cookie; rotates the refresh token. */
  app.post(route("refresh"), async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    if (!token) return fail(c, 401, "UNAUTHENTICATED", "Not signed in");
    try {
      const { session, subjectId } = await rotateRefreshToken(db, config, token, "staff");
      const user = await getStaffUser(db, subjectId);
      if (!user?.isActive) {
        await revokeRefreshToken(db, session.refreshToken);
        endSession(c, auth);
        return fail(c, 401, "UNAUTHENTICATED", "The staff account is not active");
      }
      return startSession(c, auth, session, user);
    } catch (error) {
      endSession(c, auth);
      if (error instanceof DomainError) return fail(c, 401, error.code, error.message);
      throw error;
    }
  });

  app.post(route("logout"), async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    if (token) await revokeRefreshToken(db, token);
    endSession(c, auth);
    return c.body(null, 204);
  });

  app.post(route("password-reset-request"), async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    const input = await body(c, resetRequest);
    if (!input) return fail(c, 400, "VALIDATION_FAILED", "Send an email");
    const url = await requestStaffPasswordReset(db, config, input.email);
    if (url && process.env.NODE_ENV !== "production") auth.platform.logger.info({ email: input.email, url }, "staff password reset link (development only)");
    return c.json({ accepted: true }, 202);
  });

  app.post(route("password-reset"), async (c) => {
    const blocked = guard(c);
    if (blocked) return blocked;
    const input = await body(c, reset);
    if (!input) return fail(c, 400, "VALIDATION_FAILED", "Send the token and a new password");
    try {
      const user = await resetStaffPassword(db, input.token, input.password);
      await audit(c, auth, { actorType: "staff", actorId: user.id, actorLabel: user.email, operation: "staffPasswordReset", targetType: "StaffUser", targetId: user.id, outcome: "success" });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof DomainError) {
        const fieldErrors = "fieldErrors" in error ? (error as { fieldErrors: unknown }).fieldErrors : undefined;
        return c.json({ error: { code: error.code, message: error.message, fieldErrors } }, 400);
      }
      throw error;
    }
  });
};
