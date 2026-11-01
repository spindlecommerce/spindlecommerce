import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { Config } from "../../config.ts";
import type { Database } from "../../db/client.ts";
import { randomToken, safeEqual, sha256 } from "../../lib/crypto.ts";
import { AuthenticationError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { apiKeys, passwordResetTokens, refreshTokens, type SubjectType } from "./tables.ts";

// OWASP baseline for Argon2id (the library default): 19 MiB memory, 2 iterations, 1 lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) => hash(password, ARGON2);

export const verifyPassword = async (passwordHash: string | null, password: string): Promise<boolean> => {
  if (!passwordHash) {
    // Spend comparable time for unknown accounts so response timing does not reveal them.
    await hash(password, ARGON2);
    return false;
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};

export type Session = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

const AUDIENCE: Record<SubjectType, string> = { customer: "ecom:storefront", staff: "ecom:admin" };

export const signAccessToken = async (config: Config, subjectType: SubjectType, subjectId: string) => {
  const expiresAt = new Date(Date.now() + config.accessTokenTtlSeconds * 1000);
  const token = await new SignJWT({ typ: subjectType })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subjectId)
    .setIssuer("ecom")
    .setAudience(AUDIENCE[subjectType])
    .setIssuedAt()
    .setJti(newId())
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(config.jwtSecret);
  return { token, expiresAt };
};

export const verifyAccessToken = async (config: Config, token: string, subjectType: SubjectType): Promise<string> => {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: "ecom", audience: AUDIENCE[subjectType], algorithms: ["HS256"] });
    if (payload.typ !== subjectType || !payload.sub) throw new Error("wrong token type");
    return payload.sub;
  } catch {
    throw new AuthenticationError("The access token is invalid or expired");
  }
};

/** One flow step's token; its audience is the purpose, so it never works as an access token. */
export const signPurposeToken = async (config: Config, purpose: string, subjectId: string, ttlSeconds: number) =>
  new SignJWT({ typ: purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subjectId)
    .setIssuer("ecom")
    .setAudience(`ecom:${purpose}`)
    .setIssuedAt()
    .setJti(newId())
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(config.jwtSecret);

export const verifyPurposeToken = async (config: Config, token: string, purpose: string): Promise<string> => {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: "ecom", audience: `ecom:${purpose}`, algorithms: ["HS256"] });
    if (payload.typ !== purpose || !payload.sub) throw new Error("wrong token type");
    return payload.sub;
  } catch {
    throw new AuthenticationError("The sign-in step has expired; sign in again");
  }
};

export const issueSession = async (db: Database, config: Config, subjectType: SubjectType, subjectId: string, familyId = newId()) => {
  const access = await signAccessToken(config, subjectType, subjectId);
  const refreshToken = `rt_${randomToken(32)}`;
  const refreshTokenExpiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);
  const [row] = await db
    .insert(refreshTokens)
    .values({ subjectType, subjectId, tokenHash: sha256(refreshToken), familyId, expiresAt: refreshTokenExpiresAt })
    .returning({ id: refreshTokens.id });
  const session: Session = { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken, refreshTokenExpiresAt };
  return { session, refreshTokenId: row!.id };
};

/** Each token works once; a reused token means it leaked, so its whole family is revoked. */
export const rotateRefreshToken = async (db: Database, config: Config, refreshToken: string, subjectType: SubjectType) => {
  const outcome = await db.transaction(async (tx) => {
    const row = await tx.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(refreshToken)) });
    if (!row || row.subjectType !== subjectType) return { kind: "invalid" as const };
    if (!row.revokedAt && row.expiresAt <= new Date()) return { kind: "expired" as const };
    // Of two rotations racing with one token, only one revokes it here; the other is a reuse.
    const [claimed] = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    if (!claimed) {
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      return { kind: "reused" as const };
    }
    const next = await issueSession(tx, config, row.subjectType, row.subjectId, row.familyId);
    await tx.update(refreshTokens).set({ replacedById: next.refreshTokenId }).where(eq(refreshTokens.id, row.id));
    return { kind: "ok" as const, session: next.session, subjectId: row.subjectId };
  });
  if (outcome.kind === "reused") throw new AuthenticationError("This refresh token was already used; every session from that sign-in has been revoked");
  if (outcome.kind === "expired") throw new AuthenticationError("The refresh token has expired");
  if (outcome.kind === "invalid") throw new AuthenticationError("The refresh token is invalid");
  return { session: outcome.session, subjectId: outcome.subjectId };
};

/** Sign out: revoke the token's whole family. Unknown tokens are ignored. */
export const revokeRefreshToken = async (db: Database, refreshToken: string) => {
  const row = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, sha256(refreshToken)) });
  if (!row) return false;
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
  return true;
};

export const revokeAllSessions = (db: Database, subjectType: SubjectType, subjectId: string) =>
  db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.subjectType, subjectType), eq(refreshTokens.subjectId, subjectId), isNull(refreshTokens.revokedAt)));

export const createPasswordResetToken = async (db: Database, config: Config, subjectType: SubjectType, subjectId: string) => {
  const token = `pr_${randomToken(32)}`;
  await db.insert(passwordResetTokens).values({
    subjectType,
    subjectId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + config.passwordResetTtlSeconds * 1000),
  });
  return token;
};

/** Single use; consuming a token also signs the subject out everywhere. */
export const consumePasswordResetToken = async (db: Database, token: string, subjectType: SubjectType): Promise<string> => {
  // Checked and spent in one statement, so two requests racing with a token can't both use it.
  const [row] = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.tokenHash, sha256(token)), eq(passwordResetTokens.subjectType, subjectType), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())))
    .returning({ subjectId: passwordResetTokens.subjectId });
  if (!row) throw new AuthenticationError("The password reset token is invalid or expired");
  await revokeAllSessions(db, subjectType, row.subjectId);
  return row.subjectId;
};

// ---------------------------------------------------------------- API keys

export type ApiKey = typeof apiKeys.$inferSelect;

/** Returns the plaintext key exactly once; only its SHA-256 hash is stored. */
export const createApiKey = async (
  db: Database,
  input: { name: string; permissions: string[]; expiresAt?: Date | null; createdByStaffId?: string | null },
) => {
  const prefix = randomToken(6).replace(/[^A-Za-z0-9]/g, "x").slice(0, 8);
  const plaintext = `ek_${prefix}_${randomToken(24)}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ name: input.name, prefix, keyHash: sha256(plaintext), permissions: input.permissions, expiresAt: input.expiresAt ?? null, createdByStaffId: input.createdByStaffId ?? null })
    .returning();
  return { apiKey: row!, plaintext };
};

export const verifyApiKey = async (db: Database, plaintext: string): Promise<ApiKey> => {
  const match = /^ek_([A-Za-z0-9]{8})_[A-Za-z0-9_-]+$/.exec(plaintext);
  const row = match ? await db.query.apiKeys.findFirst({ where: eq(apiKeys.prefix, match[1]!) }) : undefined;
  if (!row || !safeEqual(row.keyHash, sha256(plaintext)) || row.revokedAt || (row.expiresAt && row.expiresAt <= new Date())) {
    throw new AuthenticationError("The API key is invalid, revoked or expired");
  }
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  }
  return row;
};

export const revokeApiKey = async (db: Database, id: string) => {
  const [row] = await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id)).returning();
  return row ?? null;
};

export const listApiKeys = (db: Database) => db.query.apiKeys.findMany({ orderBy: apiKeys.createdAt });
