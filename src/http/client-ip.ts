import type { Context } from "hono";

/**
 * The socket's remote address on @hono/node-server (null on other runtimes) or, behind `trustProxy`
 * proxies, the address the outermost one saw. Each appends to X-Forwarded-For, so earlier entries
 * are whatever the client sent.
 */
export const clientIp = (c: Context, trustProxy: number): string | null => {
  const connection = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? null;
  if (trustProxy <= 0) return connection;
  const forwarded = c.req.header("x-forwarded-for")?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return forwarded[Math.max(0, forwarded.length - trustProxy)] ?? connection;
};
