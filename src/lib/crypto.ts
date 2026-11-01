import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const hmacSha256 = (secret: string, payload: string): string => createHmac("sha256", secret).update(payload).digest("hex");

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** A 256-bit key for one purpose, derived from the application secret with HKDF-SHA256. */
export const deriveKey = (secret: Uint8Array, purpose: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "ecom", purpose, 32));

/**
 * Encrypt a secret the server must read back later (e.g. a TOTP seed) with AES-256-GCM.
 * Output: `v1.<iv>.<ciphertext>.<tag>`, base64url.
 */
export const sealSecret = (key: Buffer, plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, ciphertext, cipher.getAuthTag()].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
};

export const openSecret = (key: Buffer, sealed: string): string => {
  const [version, iv, ciphertext, tag] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext || !tag) throw new Error("Unsupported sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
};
