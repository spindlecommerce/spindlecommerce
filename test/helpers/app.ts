import { createApp } from "../../src/app.ts";
import { createTestPlatform } from "./platform.ts";

export type GraphQLResult<T = any> = { status: number; data?: T; errors?: { message: string; extensions?: Record<string, unknown> }[]; extensions?: Record<string, any> };

/** The real HTTP app (Hono + Yoga) over a seeded in-memory database, called in-process. */
export const createTestApp = async (options: Parameters<typeof createTestPlatform>[0] = {}) => {
  const { platform, seed } = await createTestPlatform(options);
  const app = await createApp({ platform });
  const call = (path: string) => async <T = any>(query: string, variables?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<GraphQLResult<T>> => {
    const response = await app.fetch(
      new Request(`http://ecom.test${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify({ query, variables }) }),
    );
    return { status: response.status, ...(await response.json()) };
  };
  return { app, platform, seed, storefront: call("/graphql"), admin: call("/admin/graphql"), close: () => app.close() };
};

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
