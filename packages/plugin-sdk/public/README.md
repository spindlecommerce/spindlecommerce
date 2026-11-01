# @spindlecommerce/plugin-sdk

The plugin API for [SpindleCommerce](https://spindlecommerce.com). A plugin adds to the platform
without changing its code: a payment or shipping provider, an email or ERP integration, a fraud
check, GraphQL fields, HTTP routes or scheduled tasks. Staff switch plugins on and fill in their
settings in the admin, under **Settings › Plugins**.

## Writing a plugin

Start from the template,
[spindlecommerce/plugin-hello-world](https://github.com/spindlecommerce/plugin-hello-world), or by
hand:

```bash
pnpm add -D @spindlecommerce/plugin-sdk
```

```jsonc
// package.json
"peerDependencies": { "@spindlecommerce/plugin-sdk": "^1.0.0" }
```

```ts
import { definePlugin, setting } from "@spindlecommerce/plugin-sdk";

export const hello = () =>
  definePlugin({
    name: "hello",
    version: "1.0.0",
    apiVersion: 1,
    title: "Hello",
    settings: { greeting: setting.string({ label: "Greeting", default: "Hello" }) },
    events: {
      "order.placed": async (event, ctx) => ctx.logger.info({ orderId: event.aggregateId }, ctx.settings.greeting),
    },
  });
```

- **The peer dependency matters.** In an installation, it makes your plugin use the platform's own
  SDK, so errors such as `PaymentDeclinedError` are the ones the platform checks for.
- **Write `apiVersion` as a number.** In an installation, `PLUGIN_API_VERSION` is the platform's
  own, so a plugin that used it would always claim to match.
- **Publish JavaScript.** Build with `tsc` to `dist/`. Installations load plugins from
  `node_modules`, where Node does not strip TypeScript types.
- **Handlers run at least once.** An event can be delivered again after a timeout. Use `ctx.once`
  for anything that must happen once, such as sending an email.

## Installing a plugin

In an installation:

```bash
pnpm add @spindlecommerce/plugin-hello-world
```

```ts
// ecom.config.ts
import { helloWorld } from "@spindlecommerce/plugin-hello-world";

export default defineConfig({ plugins: [stripe(), email(), helloWorld()] });
```

Deploy, then open **Settings › Plugins**. A plugin starts working once every required setting has a
value.

## What's in it

- `definePlugin`, `defineConfig`, `setting` and `PLUGIN_API_VERSION`.
- The errors plugins throw: `ValidationError`, `NotFoundError`, `InvalidStateError` and
  `PaymentDeclinedError`.
- Types for every extension point: events, the checkout hook, error reports (`onError`), payment and
  shipping providers, HTTP routes, scheduled tasks, migrations and GraphQL.
- The handler context, `PluginContext`: settings, logger, key-value storage, `once`, `emit`, `fetch`
  and the platform's services for orders, customers, channels, locations and the catalog. The
  catalog gives products as a channel's storefront shows them, page by page, for feeds and syncs.

`ctx.db` is the platform's PostgreSQL database (Drizzle), for your plugin's own tables. In this
package, `ctx.platform` and the GraphQL builder, refs and context have loose types, since they are
internal to the platform. In an installation they have its precise types.

## Versions

The major version is the plugin API version: 1.x is `apiVersion: 1`. At startup, a platform refuses
a plugin written for another API version. Minor versions add to the API without breaking plugins.

**What 1.1 added:**
- `services.catalog`;
- `services.channels.getByCode` and `channels.list`;
- the `onError` hook;
- `phone` and `acceptsMarketing` on customers;
- `couponCodes` on orders.

A plugin that uses any of them should peer-depend on `^1.1.0`.

## License

MIT
