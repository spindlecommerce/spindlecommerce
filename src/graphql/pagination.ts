import { ValidationError } from "../lib/errors.ts";
import { pageSize } from "./builder.ts";

/** Opaque cursors: base64url JSON, either a keyset position (`k`) or a search offset (`o`). */
const encode = (value: { k?: string; o?: number }) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (cursor: string): { k?: string; o?: number } => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value === "object" && value) return value;
  } catch {}
  throw new ValidationError("Invalid cursor", [{ path: ["after"], message: "Pass a cursor returned by this API" }]);
};

export type ConnectionArgs = { first?: number | null; after?: string | null; last?: number | null; before?: string | null };

export type ConnectionResult<T, Extra = {}> = {
  edges: { cursor: string; node: T }[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
} & Extra;

const forwardOnly = (args: ConnectionArgs) => {
  if (args.last != null || args.before != null) {
    throw new ValidationError("Backward pagination is not supported", [{ path: ["last"], message: "Use first/after" }]);
  }
};

/** Keyset pagination on time-ordered UUIDv7 ids: stable under concurrent inserts, O(log n) per page. */
export const keysetConnection = async <T extends { id: string }>(
  args: ConnectionArgs,
  fetch: (page: { limit: number; afterId: string | null }) => Promise<{ rows: T[]; total: number }>,
): Promise<ConnectionResult<T>> => {
  forwardOnly(args);
  const limit = pageSize(args.first);
  const afterId = args.after ? (decode(args.after).k ?? null) : null;
  const { rows, total } = await fetch({ limit: limit + 1, afterId });
  const nodes = rows.slice(0, limit);
  const edges = nodes.map((node) => ({ cursor: encode({ k: node.id }), node }));
  return {
    edges,
    pageInfo: { hasNextPage: rows.length > limit, hasPreviousPage: afterId !== null, startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null },
    totalCount: total,
  };
};

/** Offset cursors for relevance-ranked search, where no stable key exists. */
export const offsetPage = (args: ConnectionArgs, max = 100) => {
  forwardOnly(args);
  const limit = pageSize(args.first, 20, max);
  const offset = args.after ? (decode(args.after).o ?? 0) + 1 : 0;
  if (offset > 10_000) throw new ValidationError("Result window too deep", [{ path: ["after"], message: "Narrow the search instead of paging past 10,000 results" }]);
  return { limit, offset };
};

export const offsetConnection = <T>(page: { limit: number; offset: number }, nodes: T[], totalCount: number): ConnectionResult<T> => {
  const edges = nodes.map((node, i) => ({ cursor: encode({ o: page.offset + i }), node }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.offset + nodes.length < totalCount,
      hasPreviousPage: page.offset > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
    totalCount,
  };
};

/** In-memory list → connection (small, bounded collections). */
export const listConnection = <T extends { id: string }>(args: ConnectionArgs, all: T[]): ConnectionResult<T> => {
  forwardOnly(args);
  const limit = pageSize(args.first);
  const afterId = args.after ? decode(args.after).k : undefined;
  const start = afterId ? all.findIndex((x) => x.id === afterId) + 1 : 0;
  const nodes = all.slice(start, start + limit);
  const edges = nodes.map((node) => ({ cursor: encode({ k: node.id }), node }));
  return {
    edges,
    pageInfo: { hasNextPage: start + limit < all.length, hasPreviousPage: start > 0, startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null },
    totalCount: all.length,
  };
};
