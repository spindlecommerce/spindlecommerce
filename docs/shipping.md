# Shipping

A shipping **zone** is a set of countries. Each **method** in a zone (Settings › Shipping) is priced by a **provider**:

- **Built in:** `flat_rate`, `table_rate` and `free`, priced locally from the method's config.
- **From plugins**, such as the first-party [Shippo plugin](https://github.com/spindlecommerce/plugin-shippo#readme) (`@spindlecommerce/plugin-shippo` on npm), which gets live rates from carriers and buys labels. A plugin provider's methods store `{ kind: "<provider code>", options }`, with `options` checked against the provider's `methodOptions`.

A method whose provider is not installed, or whose plugin is disabled or not configured, offers no rates. The admin marks it "Not installed", or "Needs setup" with a link to the plugin's settings.

Code: [`src/modules/shipping/`](../src/modules/shipping) (providers, rate routing and cache, methods), `shipOrder` in [`src/modules/orders/service.ts`](../src/modules/orders/service.ts) (labels), and the provider contract, `ShippingProviderDefinition`, in [`src/plugins/sdk.ts`](../src/plugins/sdk.ts).

## Rates and their codes

A cart's `availableShippingMethods` lists, in method position order, every active method of a zone that covers the shipping country and is offered in the cart's channel:

- **Built-in methods** give at most one rate, whose code is the method code (`us_standard`).
- **Provider methods** give one rate per quote the provider returns, coded `<method code>:<quote code>`, e.g. `us_live:usps:usps_priority`.

Quote codes name a service, not a price, so a code stays the same when rates are fetched again, and the shopper's choice survives re-quoting. The storefront passes the code to `cartUpdate` as `shippingMethodCode`.

Each rate carries `details` (`{ provider, method, rate, data }`), which storefronts don't see. Checkout stores it with the order's shipping method, so fulfilment knows the provider, the method and the provider's own data, such as a carrier's rate id. Shipping promotions (`shipping_off` with `methodCodes`) match the method code, so they apply to every rate of a provider method.

A provider gets a `RateRequest`:

- `method`: id, code, name and the method's `options`;
- the cart's currency, locale, discounted subtotal, total weight and shippable quantity;
- `lines`: shippable lines with per-unit weights and prices;
- `destination`: the full shipping address;
- `origin`: the address of the channel's ship-from location (`shipFromLocation`), which is the first active location of the channel's stock, by priority, whose address has a country. It is null when there is none.

## Live rates and the cache

Plugin providers are **live**: they call remote services, so their rates are cached and never fetched while an order is written.

- **Key.** SHA-256 of the provider, the method's id and `updatedAt`, channel, locale, currency, discounted subtotal, weight, quantity, destination, origin, and each line's SKU, quantity, weight and unit price. The key follows the request rather than the cart, so identical carts share rates. Editing a method retires its cached rates.
- **Lifetime.** The provider's `cacheSeconds`, default 600 (`shipping_rate_cache.expires_at`).
- **Fetching.** Cart reads fetch on a miss: the storefront `Cart`, `cartUpdate` and admin draft quotes. Methods are fetched in parallel, with 10 seconds per provider. A failure or timeout is logged and not cached: that method offers no rates, and the next read asks again. An empty answer is cached like any other.
- **Checkout reads the cache only**, and accepts a cached rate until **one hour past its expiry** (`CHECKOUT_RATE_GRACE_SECONDS`). Every cart read refreshes expired rates, so checkout succeeds within an hour of the customer last seeing the cart's rates. After that it fails with `CartNotReadyError { missing: [SHIPPING_METHOD] }`. Reading the cart again fetches fresh rates under the same codes and keeps the choice, and checkout can be retried.
- **Inactive plugins.** Cart reads skip them. Checkout never runs plugin code, so it still honours a rate cached before the plugin was disabled, within that hour.
- **Housekeeping.** Each cache write also deletes up to 200 rows past the checkout window (`FOR UPDATE SKIP LOCKED`), so no scheduled job is needed.
- **Staff drafts.** `orderDraftQuote` prices the draft from the cache inside its staging transaction, then fetches the misses after it and prices the draft again. `orderCreate` warms the cache before checking out.

In code, `quoteProviders(platform)` prices with live rates. Use it only outside transactions, because plugin code reads the database outside them. Inside a transaction, pass `liveRates: false`, add `misses: []` to collect what the cache lacked, and call `fetchLiveRates(db, misses)` after the transaction.

## Labels at fulfilment

`orderFulfill` can have the shipping provider book the shipment, for example by buying a label:

```graphql
mutation ($id: ID!) {
  orderFulfill(orderId: $id, input: { createShipment: true }) {
    __typename
    ... on OrderPayload { order { fulfillments { tracking { carrier number url } shipment { provider providerTitle labelUrl cost { amount currencyCode } } } } }
    ... on InvalidStateError { message }
  }
}
```

- **The provider** is the one behind the order's shipping rate, or another one named by code in `shipmentProvider`. `Order.shipmentProviders` lists the active providers that can book shipments, the order's own first.
- **Checks first.** The order must be open, the lines and location valid, and the provider installed, active and able to book shipments. A failed check is an `InvalidStateError` (a `ValidationError` for lines), and nothing is bought.
- **Booking.** The provider's `createShipment` runs outside any transaction, with a `ShipmentRequest`: the order, the units being shipped, the origin (the fulfilment location's address, or the ship-from location), and the method's options and the chosen rate when the order used this provider.
- **Writing.** The fulfilment is then written as usual, with the tracking numbers the provider returned and `fulfillments.shipment` (`provider`, `labelUrl`, `cost`, `data`).
- **Failures.** If the provider fails, the mutation answers `InvalidStateError` ("Shippo could not book the shipment: …") and nothing is written. If writing fails after a label was bought, for instance because someone shipped the same units meanwhile, the error is returned and a note on the order names the label and asks staff to void it.
- **Tracking links.** Tracking numbers without a URL, typed by staff or returned by a provider, get a link from a provider's `trackingUrl`: the order's or the booking provider's first, then any provider that knows the carrier.

In the admin, the fulfil dialog offers "Buy a label with …" when a provider can, checked by default when the order's rate came from that provider. Each shipment then shows the label's cost and a "Print label" link.

## Admin API

- `shippingProviders` lists `{ code title description plugin builtIn active live canCreateShipment methodOptions }`. `methodOptions` describes the provider's options as plugin settings are described (`key label type required options placeholder min max integer defaultValue`), so the admin renders them with its settings form.
- `ShippingMethod` has `provider` (the provider's code) and `providerOptions`. `kind` is null for provider methods.
- `ShippingRateConfigInput` takes `provider: { code, options }` besides `flatRate`, `tableRate` and `free`. Option problems are field errors at `["input", "config", "options", <key>]`. Blank options take their defaults, and unknown keys are dropped.

```graphql
mutation ($zone: ID!) {
  shippingMethodCreate(input: {
    code: "us_live", zoneId: $zone, names: [{ locale: "en-US", value: "Carrier rates" }]
    rate: { provider: { code: "shippo", options: { carriers: "USPS, UPS", markupPercent: 10 } } }
  }) { __typename ... on ValidationError { fieldErrors { path message } } }
}
```

## Writing a shipping provider

A plugin lists providers in `shipping: [...]` (`ShippingProviderDefinition` in the SDK):

```ts
export const acmeFreight: ShippingProviderDefinition<typeof settings> = {
  code: "acme_freight",
  title: "Acme Freight",
  methodOptions: { service: setting.select({ label: "Service", options: [{ value: "std", label: "Standard" }], default: "std" }) },
  async rates(input, ctx) {
    const quotes = await quoteAcme(ctx, input); // ctx.fetch, ctx.settings
    return quotes.map((q) => ({ code: q.service, name: q.label, amount: q.cents, carrier: "Acme", data: { quoteId: q.id } }));
  },
  async createShipment(input, ctx) {
    const label = await buyAcmeLabel(ctx, input);
    return { tracking: [{ carrier: "Acme", number: label.tracking }], labelUrl: label.pdf, cost: { amount: label.cents, currency: "USD" } };
  },
  trackingUrl: ({ number }) => `https://acme.example/track/${encodeURIComponent(number)}`,
};
```

- **Rates depend only on the request and settings**, since they are cached by request. A change to plugin-wide settings applies as cached rates expire.
- **Quote codes are stable and unique within the method.** Use a service level, never a rate id. `data` is kept with the order.
- **Amounts are integer minor units** in `input.currency`. Invalid quotes are dropped and logged, and duplicate codes keep the first.
- **Failures.** Throw for a failure, and return `[]` when nothing applies.
- **Secrets** go in plugin settings, not `methodOptions`, which staff with `settings:read` can read.

## Limitations

- Live rates have no currency conversion: a provider quotes in the cart's currency or not at all.
- Products have weights but no dimensions. Providers quote one parcel, and Shippo uses a configured default size.
- Labels are voided with the provider, for example in Shippo's dashboard.
