import { describe, expect, it } from "vitest";
import { deriveKey, openSecret, sealSecret } from "../../src/lib/crypto.ts";
import { base32Decode, base32Encode, hotp, otpauthUri, verifyTotp } from "../../src/lib/totp.ts";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890", truncated to 6 digits.
const SEED = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("totp", () => {
  it("round-trips base32", () => {
    expect(SEED).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(SEED).toString()).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv-gy3t=")).toEqual(base32Decode("GEZDGNBVGY3T"));
  });

  it("matches the RFC 6238 test vectors", () => {
    for (const [seconds, code] of VECTORS) expect(hotp(SEED, Math.floor(seconds / 30))).toBe(code);
  });

  it("accepts one step of drift and returns the matched step", () => {
    const at = 1111111111_000;
    const step = Math.floor(at / 30_000);
    expect(verifyTotp(SEED, "050471", at)).toBe(step);
    expect(verifyTotp(SEED, hotp(SEED, step - 1), at)).toBe(step - 1);
    expect(verifyTotp(SEED, hotp(SEED, step + 1), at)).toBe(step + 1);
    expect(verifyTotp(SEED, hotp(SEED, step + 2), at)).toBeNull();
    expect(verifyTotp(SEED, "05047", at)).toBeNull();
    expect(verifyTotp(SEED, "050 471", at)).toBe(step);
  });

  it("builds an authenticator URI", () => {
    expect(otpauthUri("ABC", "a@b.test", "Ecom Admin")).toBe("otpauth://totp/Ecom%20Admin:a%40b.test?secret=ABC&issuer=Ecom%20Admin&algorithm=SHA1&digits=6&period=30");
  });
});

describe("sealed secrets", () => {
  it("encrypts with AES-GCM and detects tampering or the wrong key", () => {
    const key = deriveKey(new TextEncoder().encode("app-secret"), "staff-totp");
    const sealed = sealSecret(key, "JBSWY3DPEHPK3PXP");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(openSecret(key, sealed)).toBe("JBSWY3DPEHPK3PXP");
    const [v, iv, ct, tag] = sealed.split(".");
    const flipped = `${v}.${iv}.${ct!.slice(0, -2)}${ct!.slice(-2) === "AA" ? "AB" : "AA"}.${tag}`;
    expect(() => openSecret(key, flipped)).toThrow();
    expect(() => openSecret(deriveKey(new TextEncoder().encode("other"), "staff-totp"), sealed)).toThrow();
  });
});
