import type { Logger } from "pino";
import type { PaymentProviderDefinition } from "../../plugins/sdk.ts";
import type { PaymentProvider } from "../payments/providers.ts";
import type { PluginRuntime } from "./types.ts";

/**
 * Resolves the plugin's context on each call, so settings changes apply without a restart. While
 * the plugin is inactive, isAvailable is false and other methods throw InvalidStateError.
 */
export const bindPaymentProvider = (
  definition: PaymentProviderDefinition<any>,
  plugin: string,
  runtime: Pick<PluginRuntime, "isActive" | "context">,
  logger: Logger,
): PaymentProvider => {
  const ctx = () => runtime.context(plugin);
  const { createSession, webhook } = definition;
  return {
    code: definition.code,
    title: definition.title,
    description: definition.description,
    plugin,
    isAvailable: async (input) => {
      if (!(await runtime.isActive(plugin))) return false;
      if (!definition.isAvailable) return true;
      try {
        return (await definition.isAvailable(input, await ctx())) === true;
      } catch (error) {
        // Methods are listed on every cart read: a failing check hides the method, not the cart.
        logger.error({ err: error, plugin, provider: definition.code }, "payment provider isAvailable failed; hiding it");
        return false;
      }
    },
    ...(createSession ? { createSession: async (input: Parameters<typeof createSession>[0]) => createSession.call(definition, input, await ctx()) } : {}),
    authorize: async (input) => definition.authorize(input, await ctx()),
    capture: async (input) => definition.capture(input, await ctx()),
    refund: async (input) => definition.refund(input, await ctx()),
    void: async (input) => definition.void(input, await ctx()),
    ...(webhook ? { webhook: async (request: Request) => webhook.call(definition, request, await ctx()) } : {}),
  };
};
