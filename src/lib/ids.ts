import { uuidv7 } from "uuidv7";

/** Time-ordered UUIDv7, generated in the application so inserts can return ids without a round trip. */
export const newId = (): string => uuidv7();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GID_PREFIX = "gid://ecom/";

export const isUuid = (value: string): boolean => UUID.test(value);

/** Global object id exposed by the GraphQL API, e.g. `gid://ecom/Product/0192…`. */
export const toGlobalId = (type: string, id: string): string => `${GID_PREFIX}${type}/${id}`;

export const parseGlobalId = (gid: string): { type: string; id: string } | null => {
  if (!gid.startsWith(GID_PREFIX)) return null;
  const [type, id, ...rest] = gid.slice(GID_PREFIX.length).split("/");
  if (!type || !id || rest.length > 0 || !isUuid(id)) return null;
  return { type, id: id.toLowerCase() };
};
