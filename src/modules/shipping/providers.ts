import { completeAddress, type AddressDraft } from "../../lib/address.ts";
import type { RateQuote, RateRequest, SettingsShape, ShipmentRequest, ShipmentResult, ShippingProviderDefinition } from "../../plugins/sdk.ts";
import type { PluginRuntime } from "../plugins/types.ts";
import type { BuiltInShippingConfig, ShippingMethodConfig } from "./tables.ts";

export type { RateQuote, RateRequest, ShipmentRequest, ShipmentResult };

/**
 * The destination may be incomplete while the shopper types it: built-in providers price by
 * country, and live providers are asked only once it is complete.
 */
export type ShippingRateRequest = Omit<RateRequest, "destination"> & { destination: AddressDraft };

/** For live providers that set no cacheSeconds. */
export const DEFAULT_RATE_CACHE_SECONDS = 600;

/** Built in, or a bound plugin ShippingProviderDefinition. A method's `config.kind` names it. */
export interface ShippingProvider {
  readonly code: string;
  readonly title: string;
  readonly description?: string;
  /** Unset for built-in providers. */
  readonly plugin?: string;
  /** Options per method for plugin providers; built-in providers have typed configs instead. */
  readonly methodOptions?: SettingsShape;
  /** Seconds to cache rates; setting it marks the provider live. Plugin providers always are. */
  readonly cacheSeconds?: number;
  /** False while the plugin is disabled or unconfigured; its methods then offer no rates. */
  isActive?(): Promise<boolean>;
  rates(input: ShippingRateRequest): Promise<RateQuote[]>;
  createShipment?(input: ShipmentRequest): Promise<ShipmentResult>;
  trackingUrl?(tracking: { carrier: string; number: string }): string | null;
}

export type ShippingProviderRegistry = ReadonlyMap<string, ShippingProvider>;

/** Remote rates: cached, and never fetched while an order is being written. */
export const isLiveProvider = (provider: ShippingProvider) => provider.plugin !== undefined || provider.cacheSeconds !== undefined;

export type RateContext = {
  currency: string;
  /** Subtotal after line discounts, minor units. */
  subtotal: number;
  weightGrams: number;
  /** Shippable units. */
  quantity: number;
};

/** Null when the method does not apply, e.g. it has no amount in the currency. */
export const computeRate = (config: BuiltInShippingConfig, ctx: RateContext): number | null => {
  switch (config.kind) {
    case "flat_rate": {
      const amount = config.amounts[ctx.currency];
      if (amount === undefined) return null;
      return config.per === "item" ? amount * ctx.quantity : amount;
    }
    case "table_rate": {
      const basis = config.basis === "weight" ? ctx.weightGrams : config.basis === "subtotal" ? ctx.subtotal : ctx.quantity;
      const tier = [...config.tiers].sort((a, b) => a.from - b.from).filter((t) => t.from <= basis).pop();
      return tier?.amounts[ctx.currency] ?? null;
    }
    case "free": {
      const minimum = config.minimumSubtotals[ctx.currency];
      return minimum !== undefined && ctx.subtotal >= minimum ? 0 : null;
    }
  }
};

export const BUILT_IN_SHIPPING_KINDS: ReadonlySet<string> = new Set<BuiltInShippingConfig["kind"]>(["flat_rate", "table_rate", "free"]);

export const isBuiltInConfig = (config: ShippingMethodConfig): config is BuiltInShippingConfig => BUILT_IN_SHIPPING_KINDS.has(config.kind);

/** Priced from the method's config (`input.method.options`); one rate per method. */
const builtIn = (code: BuiltInShippingConfig["kind"], title: string, description: string): ShippingProvider => ({
  code,
  title,
  description,
  rates: async (input) => {
    const amount = computeRate(input.method.options as BuiltInShippingConfig, input);
    return amount === null ? [] : [{ code: input.method.code, name: input.method.name, amount }];
  },
});

export const BUILT_IN_SHIPPING_PROVIDERS: readonly ShippingProvider[] = [
  builtIn("flat_rate", "Flat rate", "A fixed price per order or per item, per currency."),
  builtIn("table_rate", "Table rate", "Prices by weight, subtotal or quantity tiers."),
  builtIn("free", "Free shipping", "Free above a minimum subtotal."),
];

export const createShippingRegistry = (...providers: ShippingProvider[]): ShippingProviderRegistry =>
  new Map([...BUILT_IN_SHIPPING_PROVIDERS, ...providers].map((p) => [p.code, p]));

/** Each call resolves the plugin's context, which fails while it is disabled or unconfigured. */
export const bindShippingProvider = (definition: ShippingProviderDefinition<any>, plugin: string, runtime: Pick<PluginRuntime, "isActive" | "context">): ShippingProvider => {
  const create = definition.createShipment;
  return {
    code: definition.code,
    title: definition.title,
    description: definition.description,
    plugin,
    methodOptions: definition.methodOptions,
    cacheSeconds: definition.cacheSeconds ?? DEFAULT_RATE_CACHE_SECONDS,
    isActive: () => runtime.isActive(plugin),
    rates: async (input) => {
      const destination = completeAddress(input.destination);
      return destination ? definition.rates({ ...input, destination }, await runtime.context(plugin)) : [];
    },
    ...(create ? { createShipment: async (input: ShipmentRequest) => create.call(definition, input, await runtime.context(plugin)) } : {}),
    ...(definition.trackingUrl ? { trackingUrl: (tracking: { carrier: string; number: string }) => definition.trackingUrl!(tracking) } : {}),
  };
};
