import { parse } from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "../../admin/src/lib/api.ts";

const document = parse(`query Reference { channels { id } customerGroups { id } }`) as unknown as Parameters<typeof request>[0];

/** Answers the session refresh, then the operation with `body`. */
const serve = (body: unknown) =>
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(url.endsWith("/refresh") ? { accessToken: "token", accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString() } : body),
  );

afterEach(() => vi.unstubAllGlobals());

const denied = { data: { channels: null, customerGroups: [{ id: "g1" }] }, errors: [{ message: "Requires settings:read", path: ["channels"], extensions: { code: "PERMISSION_DENIED" } }] };

describe("admin request", () => {
  it("keeps the fields that resolved when asked for a partial result", async () => {
    serve(denied);
    expect(await request(document, undefined, { partial: true })).toEqual(denied.data);
  });

  it("fails on any error otherwise, and on a lost session either way", async () => {
    serve(denied);
    await expect(request(document)).rejects.toMatchObject({ constructor: ApiError, code: "PERMISSION_DENIED" });
    serve({ data: { channels: null, customerGroups: null }, errors: [{ message: "Sign in again", extensions: { code: "UNAUTHENTICATED" } }] });
    await expect(request(document, undefined, { partial: true })).rejects.toMatchObject({ constructor: ApiError, code: "UNAUTHENTICATED" });
  });
});
