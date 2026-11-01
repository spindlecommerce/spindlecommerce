import type { Logger } from "pino";
import type { ShippingRateRequest } from "../../src/modules/shipping/providers.ts";
import type { ShipmentRequest, ShipmentResult } from "../../src/plugins/sdk.ts";
import { createShippingRegistry, type ShippingProvider } from "../../src/modules/shipping/providers.ts";
import { createShippingMethod, listShippingZones } from "../../src/modules/shipping/service.ts";
import type { Platform } from "../../src/platform.ts";

/** A live carrier standing in for a plugin's provider. It records each call; `state` steers it. */
export const createFakeCarrier = (code = "fakeship") => {
  const state = {
    active: true,
    fail: false,
    rateCalls: [] as ShippingRateRequest[],
    shipmentCalls: [] as ShipmentRequest[],
    shipmentError: null as Error | null,
    /** Runs inside createShipment, after the "label" is bought. */
    duringShipment: null as (() => Promise<void>) | null,
  };
  const provider: ShippingProvider = {
    code,
    title: "FakeShip",
    description: "A pretend carrier API.",
    plugin: code,
    cacheSeconds: 600,
    methodOptions: {
      markupPercent: { type: "number", label: "Markup (%)", default: 0, min: 0, max: 100 },
      service: { type: "select", label: "Services", options: [{ value: "all", label: "All" }, { value: "ground", label: "Ground only" }], default: "all" },
      account: { type: "string", label: "Account", required: true, placeholder: "ACME-1" },
    },
    isActive: async () => state.active,
    rates: async (input) => {
      state.rateCalls.push(input);
      if (state.fail) throw new Error("FakeShip is down");
      const markup = 1 + Number(input.method.options.markupPercent ?? 0) / 100;
      const quotes = [
        { code: "ground", name: "FakeShip Ground", amount: Math.round((500 + input.weightGrams) * markup), carrier: "FakeShip", minDeliveryDays: 3, maxDeliveryDays: 5, data: { rateId: `ground_${state.rateCalls.length}` } },
        { code: "express", name: "FakeShip Express", amount: Math.round(1500 * markup), carrier: "FakeShip", minDeliveryDays: 1, maxDeliveryDays: 1, data: { rateId: `express_${state.rateCalls.length}` } },
      ];
      return input.method.options.service === "ground" ? quotes.slice(0, 1) : quotes;
    },
    createShipment: async (input): Promise<ShipmentResult> => {
      state.shipmentCalls.push(input);
      if (state.shipmentError) throw state.shipmentError;
      await state.duringShipment?.();
      return {
        tracking: [{ carrier: "FakeShip", number: `FS${String(state.shipmentCalls.length).padStart(4, "0")}` }],
        labelUrl: `https://labels.fakeship.test/${state.shipmentCalls.length}.pdf`,
        cost: { amount: 640, currency: "USD" },
        data: { transactionId: `tx_${state.shipmentCalls.length}` },
      };
    },
    trackingUrl: ({ carrier, number }) => (carrier === "FakeShip" ? `https://fakeship.test/track/${number}` : null),
  };
  return { provider, state };
};

/** Install the providers as the plugin runtime would, and add a US method using the first. */
export const addLiveMethod = async (platform: Platform, providers: ShippingProvider[], method: { code?: string; options?: Record<string, unknown>; position?: number } = {}) => {
  platform.shipping = createShippingRegistry(...providers);
  const zone = (await listShippingZones(platform.db)).find((z) => z.countries.includes("US"))!;
  return createShippingMethod(
    platform.db,
    { code: method.code ?? "us_live", name: { "en-US": "Live carrier rates" }, zoneId: zone.id, config: { kind: providers[0]!.code, options: method.options ?? { account: "ACME-1" } }, position: method.position ?? 5 },
    platform.shipping,
  );
};

/** A logger that keeps warnings, for asserting that failures are reported. */
export const recordingLogger = () => {
  const warnings: { data: unknown; message: string }[] = [];
  const warn = (data: unknown, message?: string) => void warnings.push({ data, message: message ?? String(data) });
  return { warnings, logger: { warn } as unknown as Pick<Logger, "warn"> };
};
