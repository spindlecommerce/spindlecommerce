import type { AnyPluginDefinition, CheckoutIssue, CheckoutValidateInput, PluginContext, PluginErrorSource, SettingField } from "../../plugins/sdk.ts";
import type { PaymentProvider } from "../payments/providers.ts";
import type { ShippingProvider } from "../shipping/providers.ts";

/** The runtime behind platform.plugins. */
export type PluginRuntime = {
  /** The configured plugins (ecom.config.ts), in order. */
  readonly definitions: readonly AnyPluginDefinition[];
  get(name: string): AnyPluginDefinition | undefined;
  /** Enabled, and every required setting has a value. Settings changes apply within seconds. */
  isActive(name: string): Promise<boolean>;
  /** Throws InvalidStateError while the plugin is inactive. */
  context(name: string): Promise<PluginContext>;
  /** Fails open: a hook that throws or times out adds no issues. */
  checkoutValidate(input: CheckoutValidateInput): Promise<CheckoutIssue[]>;
  /** For errors the caller already logged. Never throws, and need not be awaited. */
  reportError(error: unknown, where: { source: PluginErrorSource; plugin?: string | null; details?: Record<string, unknown> }): Promise<void>;
  /** Bound to their plugins' contexts; createPlatform adds them to platform.payments. */
  readonly paymentProviders: readonly PaymentProvider[];
  /** Bound likewise; createPlatform adds them to platform.shipping. */
  readonly shippingProviders: readonly ShippingProvider[];
  /** Runs each active plugin's onStart once per runtime. Failures are logged. */
  start(): Promise<void>;
  /** Re-reads every plugin's settings. Never throws: failures are logged. */
  refresh(): Promise<void>;
  /** Secret values left out. `fresh` reads from the database. NotFoundError for unknown names. */
  status(name: string, options?: { fresh?: boolean }): Promise<PluginStatus>;
  /** A value sets, null clears, a missing key keeps; errors at ["input", "settings", key]. */
  update(name: string, input: { enabled?: boolean | null; settings?: unknown }, actor?: { staffId: string | null }): Promise<PluginStatus>;
  /** "Test connection", enabled or not, with a 15-second limit. */
  check(name: string): Promise<{ ok: boolean; message: string }>;
};

export type PluginSettingSource = "env" | "admin" | "default" | "unset";

export type PluginSettingStatus = {
  key: string;
  field: SettingField;
  /** Always null for secrets, which never leave the server. */
  value: unknown;
  isSet: boolean;
  source: PluginSettingSource;
};

export type PluginStatus = {
  name: string;
  enabled: boolean;
  /** Every required setting has a value. */
  configured: boolean;
  active: boolean;
  missing: string[];
  settings: PluginSettingStatus[];
};
