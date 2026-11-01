export class PluginTimeoutError extends Error {}

/**
 * Plugin code cannot be cancelled: past the limit the caller moves on and the work runs on
 * unobserved, so handlers must be idempotent.
 */
export const withTimeout = <T>(work: Promise<T> | T, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginTimeoutError(`${what} timed out after ${ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`}`)), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(work), limit]).finally(() => clearTimeout(timer));
};

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
