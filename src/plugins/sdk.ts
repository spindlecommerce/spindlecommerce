/**
 * The plugin API. A plugin is a value made with `definePlugin`, listed in ecom.config.ts and bundled
 * with the app, so it runs wherever the platform does. Staff enable and configure it in the admin
 * (Settings › Plugins).
 *
 * Plugins import only this module, as @spindlecommerce/plugin-sdk: the surface kept stable across
 * releases (`apiVersion`). `ctx.platform` reaches the internals, without that promise.
 *
 * Extension points:
 * - events: domain events after they commit, delivered at least once with retries;
 * - hooks: a few synchronous checks on hot paths (checkout), each time-limited;
 * - payments and shipping: providers for payment and shipping methods;
 * - graphql: types and fields on the admin or storefront API;
 * - routes: HTTP endpoints under /plugins/<name>/, e.g. for webhooks from other services;
 * - tasks: periodic jobs run by the worker;
 * - migrations: SQL for the plugin's own tables;
 * - admin: pages, navigation entries and widgets bundled into the admin app.
 */
import type { Context as HonoContext, Hono } from "hono";
import type { Logger } from "pino";
import type { Database } from "../db/client.ts";
import type { builder as Builder, SubGraph } from "../graphql/builder.ts";
import type { GraphQLContext } from "../graphql/context.ts";
import type * as Refs from "../graphql/refs.ts";
import type { Address } from "../lib/address.ts";
import type { Platform } from "../platform.ts";

export { InvalidStateError, NotFoundError, PaymentDeclinedError, ValidationError } from "../lib/errors.ts";
export type { Address };

/** The plugin API this platform implements. A plugin built for another version is refused at startup. */
export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------- settings

type FieldBase = {
  label: string;
  description?: string;
  /**
   * An environment variable that supplies the value instead, e.g. STRIPE_SECRET_KEY. When it is set,
   * the admin shows the field read-only.
   */
  env?: string;
};
export type StringField = FieldBase & { type: "string"; required?: boolean; default?: string; placeholder?: string; multiline?: boolean };
/** Encrypted at rest and write-only: the admin API reports whether it is set, never the value. */
export type SecretField = FieldBase & { type: "secret"; required?: boolean };
export type BooleanField = FieldBase & { type: "boolean"; default?: boolean };
export type NumberField = FieldBase & { type: "number"; required?: boolean; default?: number; min?: number; max?: number; integer?: boolean };
export type SelectField<V extends string = string> = FieldBase & { type: "select"; options: readonly { value: V; label: string }[]; required?: boolean; default?: V };
export type SettingField = StringField | SecretField | BooleanField | NumberField | SelectField;
export type SettingsShape = Record<string, SettingField>;

type Present<F> = F extends { required: true } ? true : F extends { default: unknown } ? true : false;
type FieldValue<F> = F extends { type: "boolean" }
  ? boolean
  : F extends { type: "number" }
    ? Present<F> extends true ? number : number | undefined
    : F extends SelectField<infer V>
      ? Present<F> extends true ? V : V | undefined
      : Present<F> extends true ? string : string | undefined;

/**
 * Settings as plugin code sees them. Required fields are always present: a plugin's handlers and
 * providers run only once every required setting has a value ("configured").
 */
export type SettingsValues<S extends SettingsShape> = { readonly [K in keyof S]: FieldValue<S[K]> };

/** Field builders: `settings: { apiKey: setting.secret({ label: "API key", required: true, env: "ACME_API_KEY" }) }`. */
export const setting = {
  string: <const F extends Omit<StringField, "type">>(field: F) => ({ ...field, type: "string" as const }),
  secret: <const F extends Omit<SecretField, "type">>(field: F) => ({ ...field, type: "secret" as const }),
  boolean: <const F extends Omit<BooleanField, "type">>(field: F) => ({ ...field, type: "boolean" as const }),
  number: <const F extends Omit<NumberField, "type">>(field: F) => ({ ...field, type: "number" as const }),
  select: <const V extends string, const F extends Omit<SelectField<V>, "type">>(field: F & { options: readonly { value: V; label: string }[] }) => ({ ...field, type: "select" as const }),
};

// ---------------------------------------------------------------- context

/** Plugin-scoped storage (one namespace per plugin), for state that needs no table of its own. */
export type PluginKeyValueStore = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  /** Set only when absent; returns whether it was set. */
  add(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Entries whose key starts with `prefix`, in key order. */
  list<T = unknown>(prefix: string, options?: { limit?: number }): Promise<{ key: string; value: T }[]>;
};

export type TrackingNumber = { carrier: string; number: string; url?: string | null };

/** An order as plugins see it. Amounts are integer minor units in the order's currency. */
export type PluginOrder = {
  id: string;
  number: string;
  channelId: string;
  customerId: string | null;
  email: string;
  locale: string;
  currency: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  pricesIncludeTax: boolean;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  /** The shipping rate chosen at checkout; `details` comes from its provider (see RateQuote.data). */
  shippingMethod: { code: string; name: string; carrier: string; amount: number; details?: ShippingRateDetails | null } | null;
  paymentMethodCode: string;
  lines: {
    id: string;
    productId: string | null;
    variantId: string | null;
    sku: string;
    name: string;
    variantAttributes: Record<string, string>;
    quantity: number;
    quantityFulfilled: number;
    unitPrice: number;
    total: number;
    weightGrams: number | null;
    isShippable: boolean;
  }[];
  fulfillments: { id: string; number: string; tracking: TrackingNumber[]; lines: { orderLineId: string; quantity: number }[]; createdAt: Date }[];
  /** Codes the customer entered, as entered (SDK 1.1). */
  couponCodes: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type PluginChannel = { id: string; code: string; name: string; defaultLocale: string; storefrontUrl: string | null };

export type PluginCustomer = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** The locale they last shopped in: their latest order's, else latest cart's; null with neither. */
  locale: string | null;
  /** SDK 1.1. */
  phone: string | null;
  /** Whether they agreed to marketing email (SDK 1.1). Send marketing only when true. */
  acceptsMarketing: boolean;
};

/**
 * The channel, locale and currency a product is shown for. A locale the channel lacks falls back
 * to the same language, then the channel's default; an unknown currency to the default currency.
 */
export type CatalogScope = { channelId: string; locale?: string; currency?: string };

/**
 * A product as the channel's storefront shows it, priced for a guest (SDK 1.1). Amounts are integer
 * minor units in `currency`, tax included when `pricesIncludeTax`.
 */
export type PluginProduct = {
  id: string;
  channelId: string;
  /** The locale and currency actually used (see CatalogScope). */
  locale: string;
  currency: string;
  pricesIncludeTax: boolean;
  name: string;
  slug: string;
  /** HTML. */
  description: string | null;
  seo: { title: string | null; description: string | null };
  /** `/products/<slug>`. Prefixes such as a language are the storefront's own. */
  path: string;
  /** The channel's storefront (Settings › Storefronts) followed by `path`; null when there is none. */
  url: string | null;
  /** False when kept out of listings and search: reachable by its URL only. */
  visibleInListings: boolean;
  productType: { code: string; name: string; isShippable: boolean };
  /** Product-level attributes with a value, e.g. `{ code: "brand", name: "Brand", value: "Trail Co", raw: "trail-co" }`. */
  attributes: { code: string; name: string; value: string; raw: unknown }[];
  /** Active categories, with the names and slugs of their path from the top (the category's own last). */
  categories: { id: string; name: string; slug: string; path: string[]; slugPath: string }[];
  /** In order. `variantId` marks an image of one variant. */
  media: { url: string; alt: string | null; kind: "image" | "video"; variantId: string | null }[];
  /** Over the variants with a price; null when none has one. */
  priceRange: { min: number; max: number; compareAtMin: number | null } | null;
  /** Whether any variant can be bought now. */
  available: boolean;
  /** Active variants, in order. */
  variants: PluginProductVariant[];
  createdAt: Date;
  updatedAt: Date;
};

export type PluginProductVariant = {
  id: string;
  sku: string;
  /** The product name with the variant's options, e.g. "Oxford Shirt – Blue / M". */
  name: string;
  /** GTIN, EAN or UPC, as entered. */
  barcode: string | null;
  weightGrams: number | null;
  /** Its value on each variant attribute, e.g. `{ attribute: "size", name: "Size", value: "m", label: "M" }`. */
  options: { attribute: string; name: string; value: string; label: string }[];
  /** Null when the variant has no price in the currency (nor one to convert). */
  price: number | null;
  /** The price before a reduction; null when there is none. */
  compareAtPrice: number | null;
  available: boolean;
  /** Salable quantity in the channel's stock; null when the variant does not track inventory. */
  quantityAvailable: number | null;
};

/** Read models and a few operations, stable across releases. */
export type PluginServices = {
  orders: {
    get(id: string): Promise<PluginOrder | null>;
    getByNumber(number: string): Promise<PluginOrder | null>;
    /** A note in the order's history, attributed to the plugin. */
    addNote(orderId: string, message: string): Promise<void>;
  };
  customers: {
    get(id: string): Promise<PluginCustomer | null>;
  };
  /** Products as a channel's storefront shows them (SDK 1.1). NotFoundError for an unknown or inactive channel. */
  catalog: {
    /** Null unless the product is sold in the channel: active and published there. */
    getProduct(id: string, scope: CatalogScope): Promise<PluginProduct | null>;
    /**
     * Every product sold in the channel, a page at a time (`first`, at most 100, default 100), oldest
     * first; pass `next` back as `after` until it is null. Includes products kept out of listings.
     */
    listProducts(scope: CatalogScope & { first?: number; after?: string | null }): Promise<{ products: PluginProduct[]; next: string | null }>;
  };
  channels: {
    /** `storefrontUrl`: the first storefront registered for the channel (Settings › Storefronts), if any. */
    get(id: string): Promise<PluginChannel | null>;
    /** An active channel by its code, e.g. "eu" (SDK 1.1); null for unknown or inactive codes. */
    getByCode(code: string): Promise<PluginChannel | null>;
    /** The active channels, by code (SDK 1.1). */
    list(): Promise<PluginChannel[]>;
    /**
     * The channel a request that names none uses (DEFAULT_CHANNEL, else the first active channel),
     * e.g. for messages to customers and staff, who belong to no channel.
     */
    getDefault(): Promise<PluginChannel | null>;
  };
  locations: {
    /** Where a channel's orders ship from: its first active stock location with an address. */
    shipFrom(channelId: string): Promise<{ id: string; name: string; address: Partial<Address> } | null>;
  };
};

export type PluginContext<S extends SettingsShape = SettingsShape> = {
  plugin: { name: string; version: string };
  settings: SettingsValues<S>;
  db: Database;
  /** A child logger tagged with the plugin's name. */
  logger: Logger;
  kv: PluginKeyValueStore;
  /** The platform's fetch: use it rather than the global one, so tests can stand in for remote services. */
  fetch: typeof fetch;
  /**
   * Run `fn` once per key across retries and instances (e.g. one confirmation email per order).
   * Returns false when it had already run. A throwing `fn` does not count as run.
   */
  once(key: string, fn: () => Promise<void>): Promise<boolean>;
  /**
   * Emit one of the plugin's declared events (`emits`). Pass the transaction's `db` to commit it with
   * other writes; webhooks and other plugins receive it like a platform event.
   */
  emit(event: { type: string; aggregateType: string; aggregateId: string; payload?: Record<string, unknown> }, db?: Database): Promise<void>;
  services: PluginServices;
  urls: {
    /** The admin's public URL, e.g. https://shop-api.example.com/admin. */
    admin: string;
    /** This API's public base URL; the plugin's routes are at `${urls.api}/plugins/<name>/…`. */
    api: string;
  };
  production: boolean;
  /** Everything else, internal and not covered by `apiVersion`. */
  platform: Platform;
};

// ---------------------------------------------------------------- events

/** A committed domain event: platform events (see EVENT_TYPES) and plugins' declared events. */
export type PluginEvent = { id: string; type: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: Date };

/**
 * Runs after the event commits, outside any request, at least once: a handler that throws is
 * retried with backoff, so make it idempotent (see `ctx.once`). Order across events is not guaranteed.
 */
export type EventHandler<S extends SettingsShape = SettingsShape> = (event: PluginEvent, ctx: PluginContext<S>) => Promise<void>;

// ---------------------------------------------------------------- hooks

export type CheckoutValidateInput = {
  cartId: string;
  channelId: string;
  customerId: string | null;
  email: string | null;
  currency: string;
  grandTotal: number;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  shippingMethodCode: string | null;
  paymentMethodCode: string | null;
  lines: { productId: string; variantId: string; sku: string; quantity: number; unitPrice: number }[];
};
export type CheckoutIssue = { code: string; message: string; field?: string[] };

/** Where the platform caught an unexpected error. */
export type PluginErrorSource =
  /** A GraphQL request (masked as INTERNAL_SERVER_ERROR in production). */
  | "graphql"
  /** A plugin's HTTP route. */
  | "route"
  /** A payment webhook that could not be processed. */
  | "payment-webhook"
  /** A plugin's event handler (the delivery is retried). */
  | "plugin-event"
  /** A plugin's scheduled task. */
  | "plugin-task"
  /** A plugin's checkoutValidate (ignored for that checkout). */
  | "plugin-hook"
  /** A plugin's onStart. */
  | "plugin-start"
  /** A background worker run. */
  | "worker";

/**
 * An unexpected error the platform caught and logged (SDK 1.1). Expected outcomes of requests,
 * such as validation errors, declined payments or unknown ids, are not reported.
 */
export type PluginErrorReport = {
  source: PluginErrorSource;
  error: { name: string; message: string; stack: string | null };
  /** The plugin involved, for plugin sources, plugin routes and plugin payment providers; else null. */
  plugin: string | null;
  /** What was happening, e.g. `{ path }` for a route or `{ eventType, attempt }` for an event handler. */
  details: Record<string, unknown>;
  occurredAt: Date;
};

export type PluginHooks<S extends SettingsShape> = {
  /** Before an order is placed. Any issue refuses the order with a validation error. Limited to 5 seconds. */
  checkoutValidate?: (input: CheckoutValidateInput, ctx: PluginContext<S>) => Promise<CheckoutIssue[]> | CheckoutIssue[];
  /**
   * Every unexpected error the platform catches, e.g. for an error tracker (SDK 1.1). Runs in the
   * background, limited to 5 seconds; what it throws is logged, never reported again.
   */
  onError?: (report: PluginErrorReport, ctx: PluginContext<S>) => Promise<void> | void;
};

// ---------------------------------------------------------------- payments

export type PaymentSessionInput = {
  cartId: string;
  methodCode: string;
  amount: number;
  currency: string;
  locale: string;
  email: string | null;
  customerId: string | null;
  billingAddress: Address | null;
  shippingAddress: Address | null;
  lines: { sku: string; name: string; quantity: number; unitPrice: number; total: number }[];
  captureImmediately: boolean;
  /** This cart's last session with the same provider: update it (e.g. a new amount) rather than start over. */
  previous: Record<string, unknown> | null;
};

/** `data` stays on the server with the cart; `clientData` goes to the storefront (e.g. a client secret). */
export type PaymentSession = { data: Record<string, unknown>; clientData: Record<string, unknown> };

export type AuthorizeInput = {
  orderId: string;
  orderNumber: string;
  cartId: string | null;
  amount: number;
  currency: string;
  /**
   * What the storefront sent with the order (e.g. a test token). When a webhook places the order
   * (the customer paid but never came back), it is `{ pspReference }` from the PSP.
   */
  paymentData: Record<string, unknown>;
  captureImmediately: boolean;
  /** The cart's session `data`, when the provider created one. */
  session: Record<string, unknown> | null;
};
/** Throw PaymentDeclinedError to decline: the order is canceled, its stock released and the cart reopened. */
export type AuthorizeResult = { status: "authorized" | "captured" | "pending"; pspReference: string | null; raw?: Record<string, unknown> };
export type ProviderResult = { pspReference: string | null; raw?: Record<string, unknown> };

/** A payment event a provider reports from a webhook. The platform applies each once, by `id`. */
export type PaymentWebhookEvent = {
  /** The PSP's own event id, for idempotency. */
  id: string;
  type: "authorized" | "captured" | "failed" | "canceled" | "refunded" | "dispute_opened" | "dispute_closed";
  /** The payment's reference (what authorize returned as pspReference). */
  pspReference: string;
  /** Required for `refunded`: the refund's own reference, so each refund is recorded once. */
  refundReference?: string;
  /** Minor units. For `captured`, the total captured so far (cumulative), not this capture alone. */
  amount?: number;
  currency?: string;
  /** Where the PSP carries them (e.g. metadata): lets a payment completed without the storefront still become an order. */
  orderId?: string;
  cartId?: string;
  reason?: string;
  raw?: Record<string, unknown>;
};
/** `response` replaces the default 200 `{ "received": true }`. */
export type PaymentWebhookResult = { events: PaymentWebhookEvent[]; response?: Response };

/**
 * A payment service provider (PSP). Payment methods (Settings › Payments) pick a provider; the
 * platform owns orders, transactions and invoices, the provider talks to the PSP.
 *
 * Checkout: the storefront may ask for a session (createSession) to render the PSP's payment UI,
 * then places the order, and authorize confirms the payment with the PSP. Later changes arrive as
 * webhooks (POST /payments/webhooks/<code>), which also complete orders whose customer never came
 * back from the PSP.
 */
export interface PaymentProviderDefinition<S extends SettingsShape = SettingsShape> {
  /** Unique across plugins, e.g. "stripe". */
  readonly code: string;
  readonly title: string;
  readonly description?: string;
  /** Offered at checkout only when this returns true (defaults to true). */
  isAvailable?(input: { currency: string; countryCode: string | null; amount: number }, ctx: PluginContext<S>): boolean | Promise<boolean>;
  createSession?(input: PaymentSessionInput, ctx: PluginContext<S>): Promise<PaymentSession>;
  authorize(input: AuthorizeInput, ctx: PluginContext<S>): Promise<AuthorizeResult>;
  capture(input: { orderId: string; amount: number; currency: string; pspReference: string | null }, ctx: PluginContext<S>): Promise<ProviderResult>;
  refund(input: { orderId: string; amount: number; currency: string; pspReference: string | null }, ctx: PluginContext<S>): Promise<ProviderResult>;
  /**
   * Cancel an order's authorization. An empty `orderId` means a session's payment that no order came
   * of (stock ran out, a check refused the order): give back whatever it secured, found by
   * `pspReference` or `session`, and leave an unpaid one usable.
   */
  void(input: { orderId: string; pspReference: string | null; session?: Record<string, unknown> | null }, ctx: PluginContext<S>): Promise<ProviderResult>;
  /**
   * Verify the signature and translate a PSP webhook. Throw ValidationError when the request can't
   * be verified: the route answers 400 without details.
   */
  webhook?(request: Request, ctx: PluginContext<S>): Promise<PaymentWebhookResult>;
}

// ---------------------------------------------------------------- shipping

export type RateRequest = {
  /** The shipping method being priced; `options` are its provider options (ShippingProviderDefinition.methodOptions). */
  method: { id: string; code: string; name: string; options: Record<string, unknown> };
  channelId: string;
  locale: string;
  currency: string;
  /** After discounts, minor units. */
  subtotal: number;
  weightGrams: number;
  quantity: number;
  destination: Address;
  origin: Partial<Address> | null;
  /** `weightGrams` and `unitPrice` are per unit. */
  lines: { sku: string; name: string; quantity: number; weightGrams: number; unitPrice: number }[];
};
/** One rate. `code` is unique within the method (e.g. a service level); `data` is kept with the order (e.g. a carrier rate id). */
export type RateQuote = {
  code: string;
  name: string;
  amount: number;
  carrier?: string | null;
  minDeliveryDays?: number | null;
  maxDeliveryDays?: number | null;
  data?: Record<string, unknown>;
};
/** Stored with the order's shipping method, so fulfilment knows the provider, method and rate chosen. */
export type ShippingRateDetails = { provider: string; method: string; rate: string; data: Record<string, unknown> };

export type ShipmentRequest = {
  order: PluginOrder;
  /** The units being shipped. */
  lines: { orderLineId: string; sku: string; name: string; quantity: number; weightGrams: number | null }[];
  origin: Partial<Address> | null;
  /** The method's provider options and the rate chosen at checkout, when the order used this provider. */
  method: { code: string; options: Record<string, unknown> } | null;
  rate: ShippingRateDetails | null;
};
export type ShipmentResult = {
  tracking: TrackingNumber[];
  labelUrl?: string | null;
  cost?: { amount: number; currency: string } | null;
  data?: Record<string, unknown>;
};

/**
 * A carrier or rate engine. Shipping methods (Settings › Shipping) pick a provider and set its
 * options. Live rates are cached per request for `cacheSeconds` (default 600) and never fetched
 * while an order is being written, so slow carriers cannot hold up checkout.
 */
export interface ShippingProviderDefinition<S extends SettingsShape = SettingsShape> {
  /** Unique across plugins, e.g. "shippo". */
  readonly code: string;
  readonly title: string;
  readonly description?: string;
  /** Options per shipping method, e.g. carriers or a markup. Secrets belong in plugin settings, not here. */
  readonly methodOptions?: SettingsShape;
  readonly cacheSeconds?: number;
  /** Rates for a cart; [] when none apply. Limited to 10 seconds. */
  rates(input: RateRequest, ctx: PluginContext<S>): Promise<RateQuote[]>;
  /** Buy a label or book the shipment when staff fulfil (on request). */
  createShipment?(input: ShipmentRequest, ctx: PluginContext<S>): Promise<ShipmentResult>;
  trackingUrl?(tracking: { carrier: string; number: string }): string | null;
}

// ---------------------------------------------------------------- tasks, routes, GraphQL

/**
 * Run by the worker at most once per interval, on one instance at a time. On serverless hosts the
 * worker runs on each cron call and with traffic, so the interval is a minimum, not a schedule.
 */
export type ScheduledTask<S extends SettingsShape = SettingsShape> = {
  name: string;
  description?: string;
  intervalMinutes: number;
  run(ctx: PluginContext<S>): Promise<void>;
};

export type RouteApi<S extends SettingsShape> = {
  /** The plugin's context for a request; answers 503 for the plugin while it is disabled or not configured. */
  context(c: HonoContext): Promise<PluginContext<S>>;
};

export type GraphQLExtensionApi<S extends SettingsShape> = {
  /** The platform's Pothos builder: add types with `builder.objectType`, fields with `builder.queryField`, … */
  builder: typeof Builder;
  /** Sub-graphs for `subGraphs`: the admin API, the storefront API or both. */
  ADMIN: SubGraph[];
  STOREFRONT: SubGraph[];
  BOTH: SubGraph[];
  /** Object refs of platform types (OrderRef, ProductRef, CustomerRef, …), to add fields to them. */
  refs: typeof Refs;
  /** The plugin's context inside a resolver; fails with InvalidStateError while it is disabled or not configured. */
  context(ctx: GraphQLContext): Promise<PluginContext<S>>;
  /** Global ids: `gid://ecom/<Type>/<uuid>`. */
  toGlobalId(type: string, id: string): string;
  rawId(id: { id: string } | string): string;
};

// ---------------------------------------------------------------- definition

export type PluginDefinition<S extends SettingsShape = SettingsShape> = {
  /** Unique: lowercase letters, digits and dashes. It namespaces settings, storage, routes and events. */
  name: string;
  /** The plugin's own version, shown in the admin. */
  version: string;
  /** The plugin API it was written for: PLUGIN_API_VERSION. */
  apiVersion: number;
  title: string;
  description?: string;
  settings?: S;
  /** Permissions it introduces, e.g. `reviews:moderate`, assignable to roles and usable in its pages and fields. */
  permissions?: { code: string; description: string }[];
  /** Event types it emits, each `<name>.<something>`, so webhooks and other plugins can subscribe. */
  emits?: string[];
  /** Keys: an event type, `prefix.*` or `*`. */
  events?: Record<string, EventHandler<S>>;
  hooks?: PluginHooks<S>;
  payments?: PaymentProviderDefinition<S>[];
  shipping?: ShippingProviderDefinition<S>[];
  /** Registered once per process, before the schema is built. */
  graphql?: (api: GraphQLExtensionApi<S>) => void;
  /** Mounted at /plugins/<name>/. */
  routes?: (router: Hono, api: RouteApi<S>) => void;
  tasks?: ScheduledTask<S>[];
  /** A directory of `.sql` files, applied once each in name order after the platform's migrations: `new URL("./migrations/", import.meta.url)`. */
  migrations?: URL;
  /** The admin module (default export from `defineAdminPlugin`), bundled into the admin at build time: `new URL("./admin.tsx", import.meta.url)`. */
  admin?: URL;
  /** Once per process, when the platform starts and the plugin is enabled and configured. */
  onStart?: (ctx: PluginContext<S>) => Promise<void> | void;
  /**
   * "Test connection" in the admin: check the settings against the remote service (e.g. that an
   * API key works) and say what was found. Limited to 15 seconds.
   */
  check?: (ctx: PluginContext<S>) => Promise<{ ok: boolean; message: string }>;
};

/** Settings types flow into every handler: `ctx.settings.apiKey` is a string when the field is required. */
export const definePlugin = <const S extends SettingsShape = Record<never, SettingField>>(definition: PluginDefinition<S>): PluginDefinition<S> => definition;

/** Any plugin, whatever its settings. */
export type AnyPluginDefinition = PluginDefinition<any>;
export type EcomConfig = { plugins: AnyPluginDefinition[] };

/** ecom.config.ts: `export default defineConfig({ plugins: [stripe(), email()] })`. */
export const defineConfig = (config: EcomConfig): EcomConfig => config;
