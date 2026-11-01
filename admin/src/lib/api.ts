import type { TadaDocumentNode } from "gql.tada";
import { print } from "graphql";

/**
 * The access token lives only in memory. The refresh token is an httpOnly cookie sent to
 * /admin/auth/*, so reloads and expired tokens recover with a silent refresh.
 */
export const API = { graphql: "/admin/graphql", auth: "/admin/auth" };

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = "INTERNAL_SERVER_ERROR", status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type FieldError = { path: string[]; message: string };

/** A typed failure returned in a mutation's result union. */
export class MutationError extends ApiError {
  readonly typename: string;
  readonly fieldErrors: FieldError[];
  readonly details: Record<string, unknown>;
  constructor(result: { __typename: string; code?: string | null; message?: string | null; fieldErrors?: FieldError[] | null } & Record<string, unknown>) {
    super(result.message ?? "The request failed", result.code ?? "UNKNOWN", 200);
    this.typename = result.__typename;
    this.fieldErrors = result.fieldErrors ?? [];
    this.details = result;
  }
}

type Session = { accessToken: string; expiresAt: number };
let session: Session | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export const onSessionChange = (listener: (signedIn: boolean) => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const setSession = (accessToken: string | null, expiresAt?: string) => {
  session = accessToken ? { accessToken, expiresAt: expiresAt ? Date.parse(expiresAt) : Date.now() + 10 * 60_000 } : null;
  for (const listener of listeners) listener(session !== null);
};

export const hasSession = () => session !== null;

export const currentToken = () => ({ accessToken: session?.accessToken ?? null });

const authPost = (path: string, body?: unknown) =>
  fetch(`${API.auth}/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? { "x-requested-with": "ecom-admin" } : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Swaps the session cookie for a fresh access token; concurrent callers share one refresh. */
export const refreshSession = (): Promise<boolean> => {
  refreshing ??= (async () => {
    try {
      const response = await authPost("refresh");
      if (!response.ok) {
        setSession(null);
        return false;
      }
      const json = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string };
      setSession(json.accessToken, json.accessTokenExpiresAt);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
};

export type SignInResult = { kind: "session" } | { kind: "challenge"; challengeToken: string };

const authError = async (response: Response) => {
  const json = (await response.json().catch(() => null)) as { error?: { code: string; message: string; fieldErrors?: FieldError[] } } | null;
  const error = new ApiError(json?.error?.message ?? "The request failed", json?.error?.code, response.status);
  return Object.assign(error, { fieldErrors: json?.error?.fieldErrors ?? [] });
};

export const signIn = async (email: string, password: string): Promise<SignInResult> => {
  const response = await authPost("login", { email, password });
  if (!response.ok) throw await authError(response);
  const json = (await response.json()) as { twoFactorRequired?: boolean; challengeToken?: string; accessToken?: string; accessTokenExpiresAt?: string };
  if (json.twoFactorRequired && json.challengeToken) return { kind: "challenge", challengeToken: json.challengeToken };
  setSession(json.accessToken!, json.accessTokenExpiresAt);
  return { kind: "session" };
};

export const verifySignIn = async (challengeToken: string, code: string) => {
  const response = await authPost("verify", { challengeToken, code });
  if (!response.ok) throw await authError(response);
  const json = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string };
  setSession(json.accessToken, json.accessTokenExpiresAt);
};

export const signOut = async () => {
  await authPost("logout").catch(() => undefined);
  setSession(null);
};

export const requestPasswordReset = async (email: string) => {
  const response = await authPost("password-reset-request", { email });
  if (!response.ok) throw await authError(response);
};

export const resetPassword = async (token: string, password: string) => {
  const response = await authPost("password-reset", { token, password });
  if (!response.ok) throw await authError(response);
};

const printed = new WeakMap<object, string>();
const source = (document: object) => {
  let text = printed.get(document);
  if (!text) printed.set(document, (text = print(document as Parameters<typeof print>[0])));
  return text;
};

const operationName = (document: object) =>
  (document as { definitions: { kind: string; name?: { value: string } }[] }).definitions.find((d) => d.kind === "OperationDefinition")?.name?.value;

/**
 * Runs a typed operation, refreshing the session ahead of expiry and once more on a 401. With
 * `partial`, fields that failed come back null instead of failing the whole operation.
 */
export const request = async <Result, Variables>(
  document: TadaDocumentNode<Result, Variables>,
  variables?: Variables,
  options: { signal?: AbortSignal; partial?: boolean } = {},
): Promise<Result> => {
  if (!session || session.expiresAt - Date.now() < 30_000) await refreshSession();
  const send = () =>
    fetch(API.graphql, {
      method: "POST",
      credentials: "same-origin",
      signal: options.signal,
      headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json", ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}) },
      body: JSON.stringify({ query: source(document), variables: variables ?? {}, operationName: operationName(document) }),
    });
  let response = await send();
  if (response.status === 401 && (await refreshSession())) response = await send();
  const json = (await response.json().catch(() => null)) as { data?: Result; errors?: { message: string; extensions?: { code?: string } }[] } | null;
  const error = json?.errors?.[0];
  const unauthenticated = error?.extensions?.code === "UNAUTHENTICATED";
  if (unauthenticated) setSession(null);
  if (error && (unauthenticated || !options.partial || !json?.data)) throw new ApiError(error.message, error.extensions?.code, response.status);
  if (!json?.data) throw new ApiError(`Unexpected response (${response.status})`, "BAD_RESPONSE", response.status);
  return json.data;
};

/** Members of a mutation result union that are not expected failures. */
export type Success<T> = T extends { __typename: `${string}Error` } ? never : T;

/** Return the payload of a result union, or throw its typed error. */
export const unwrap = <T extends { __typename: string } | null | undefined>(result: T): Success<NonNullable<T>> => {
  if (!result) throw new ApiError("Empty result", "BAD_RESPONSE");
  if (result.__typename.endsWith("Error")) throw new MutationError(result as unknown as ConstructorParameters<typeof MutationError>[0]);
  return result as Success<NonNullable<T>>;
};
