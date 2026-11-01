# Plugins

A plugin adds to the platform without changing its code: a payment or shipping provider, an email or ERP integration, a fraud check, admin pages, GraphQL fields. Plugins are TypeScript modules made with `definePlugin`, listed in [`ecom.config.ts`](../ecom.config.ts) and bundled with the app, whether they live in [`plugins/`](../plugins) or come from npm, like `@spindlecommerce/plugin-hello-world`. Staff enable and configure them under **Settings › Plugins**.

Code: `@spindlecommerce/plugin-sdk`, the API plugins import ([`packages/plugin-sdk`](../packages/plugin-sdk), which is [`src/plugins/sdk.ts`](../src/plugins/sdk.ts)), the runtime in [`src/modules/plugins/`](../src/modules/plugins) and the admin API in [`src/graphql/types/plugins.ts`](../src/graphql/types/plugins.ts). [payments.md](payments.md) and [shipping.md](shipping.md) cover providers, and [admin.md](admin.md) covers admin modules.

## Why plugins are code

Plugins are not uploaded or installed at runtime:

- **Serverless.** A Vercel function is an immutable bundle with no persistent disk, and every instance must run the same code. Plugins are bundled into it like any other module.
- **Reviewable.** Adding or upgrading a plugin is a commit: it goes through code review and CI, its version is pinned in the lockfile, and it rolls back with the deployment.
- **Typed.** Plugins compile against the SDK. One written for another plugin API version is refused at startup, not halfway through a checkout.

Only data changes at runtime: whether a plugin is enabled, and its settings. Both live in the database (`plugin_settings`), so they apply to every instance.

## Installing a plugin

Add the npm package, then list it in `ecom.config.ts` beside the plugins in `plugins/`, which are imported by path:

```bash
pnpm add @spindlecommerce/plugin-hello-world
```

```ts
// ecom.config.ts
import { defineConfig } from "@spindlecommerce/plugin-sdk";
import { helloWorld } from "@spindlecommerce/plugin-hello-world";
import { stripe } from "./plugins/stripe/index.ts";

export default defineConfig({ plugins: [stripe(), helloWorld()] });
```

Then:

1. Migrate (`pnpm db:migrate`), since plugins with tables bring their own migrations. Vercel builds and `pnpm dev` with PGlite migrate by themselves.
2. If the plugin adds GraphQL fields, run `pnpm schema:print` to add them to `schema/*.graphql` and the admin's typed queries.
3. Deploy, fill in the plugin's settings under **Settings › Plugins**, and press **Test connection** if it has one. Plugins are enabled by default, and become active once every required setting has a value.

## Lifecycle

1. **Validation.** Before anything runs, the platform checks every configured plugin, and fails startup with a list of the problems: names (`^[a-z][a-z0-9-]{1,39}$`, unique, not a platform event namespace such as `order`), `apiVersion`, provider codes (unique, and not `offline`, `test_gateway`, `flat_rate`, `table_rate` or `free`), `emits` (each `<name>.<something>`), `events` keys (each matching a platform or plugin event), permissions (`area:action`, not a platform permission or another plugin's), settings and tasks.
2. **Migrations** run after the platform's, wherever those run (below).
3. **Settings** are read at startup, kept in memory, and read again in the background once more than 5 seconds old, so a change reaches other instances within seconds. The instance that saves a change applies it at once.
4. **Active** means enabled and configured, with every required setting set. Only active plugins receive events, run tasks and hooks, and serve their providers, routes and GraphQL fields. The sections below say what happens meanwhile.
5. **`onStart`** runs once per process for each active plugin: at startup (`pnpm dev`, `pnpm start`, `pnpm worker`, a Vercel instance's first request), or when staff activate the plugin in that process. It doesn't hold up startup, and failures are logged.
6. **GraphQL** extensions are registered once per process, before the schema is built.

## Writing a plugin

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

Export a function that returns the definition, so an installation can pass options. Import only `@spindlecommerce/plugin-sdk`, the API kept stable across releases ([Compatibility](#compatibility)). In this repository it is `src/plugins/sdk.ts`, which the plugins in `plugins/` import by path. `apiVersion` is the plugin API version the plugin was written for, as a number. Plugins in `plugins/` use `PLUGIN_API_VERSION`, and published plugins must not ([Publishing a plugin](#publishing-a-plugin)). `pnpm typecheck` covers the plugins in `plugins/`, their server code with the platform's and their admin modules with the admin's.

## Settings, secrets and environment variables

| Builder | Value in `ctx.settings` | Options |
|---|---|---|
| `setting.string` | `string` | `required`, `default`, `placeholder`, `multiline` |
| `setting.secret` | `string` | `required` |
| `setting.boolean` | `boolean` (false when unset) | `default` |
| `setting.number` | `number` | `required`, `default`, `min`, `max`, `integer` |
| `setting.select` | one of the option values | `options`, `required`, `default` |

Every field takes `label`, `description` and `env`. A required or defaulted field is never undefined in `ctx.settings`, since the platform runs a plugin only once it is configured.

- **Precedence.** The field's environment variable (`env`, when set and not empty), then the value saved in the admin, then the default. The admin shows a field set by its environment variable as such, and can't change it. Use environment variables for secrets managed with the deployment, such as `STRIPE_SECRET_KEY`.
- **Secrets** are encrypted at rest (AES-256-GCM, one sealed object per plugin, with a key derived from `JWT_SECRET`) and write-only: the admin API only says whether one is set, and the audit log records `[redacted]`. Plugin code gets the opened value. Changing `JWT_SECRET` makes stored secrets unreadable, so the plugin is not configured, with a warning, until they are entered again.
- **Saving** (`pluginUpdate`): a value sets, `null` clears, and a key left out keeps its value. An empty string clears a text setting but keeps a secret, because forms show secrets blank. Invalid values fail with field errors at `["input", "settings", <key>]`.
- A saved value that no longer fits its field, such as an option the plugin removed, is ignored with a warning.

## The context

Every handler, provider method, task, hook and route gets a `PluginContext`:

| Member | |
|---|---|
| `plugin` | `{ name, version }` |
| `settings` | The typed settings. |
| `db` | The platform's database (Drizzle). Plugins own the tables of their migrations. |
| `logger` | A pino logger tagged with the plugin's name. |
| `kv` | Storage in the plugin's own namespace: `get`, `set`, `add` (set if absent), `delete`, `list(prefix)`, each with an optional `ttlSeconds`. Expired entries are ignored on read and deleted by the worker. |
| `once(key, fn)` | Runs `fn` once per key across retries and instances, and returns whether it ran. A throwing `fn` doesn't count. If a process dies while `fn` runs, the key is freed after 15 minutes. |
| `emit(event, db?)` | Writes one of the plugin's declared events (`emits`) to the outbox, in the transaction you pass, if any. `aggregateId` is the UUID of the entity the event is about. |
| `fetch` | The platform's `fetch`, which tests replace. Use it rather than the global one. |
| `services` | Read models and operations that stay stable: `orders.get`, `orders.getByNumber`, `orders.addNote` (a note in the order's history naming the plugin), `customers.get` (with the locale they last shopped in, and whether they accept marketing), `catalog.getProduct` and `catalog.listProducts` (products as a channel's storefront shows them, below), `channels.get` (with the storefront URL), `channels.getByCode` and `channels.list` (active channels), `channels.getDefault` (the channel used when none is named, for messages to customers and staff), `locations.shipFrom`. |
| `urls` | `admin` is the admin's public URL. `api` is this API's public base URL, found as media URLs are (`MEDIA_PUBLIC_URL`, else `ADMIN_URL` without `/admin`, else `http://localhost:PORT`). The plugin's routes are at `${urls.api}/plugins/<name>/`. |
| `production` | True in production. |
| `platform` | Everything else. Internal, and not covered by `apiVersion`. |

## Extension points

### Events

```ts
emits: ["loyalty.points_awarded"],
events: {
  "order.completed": async (event, ctx) => { … },
  "customer.*": async (event, ctx) => { … },
},
```

Keys are an event type, a prefix (`order.*`) or `*`, naming platform events (`EVENT_TYPES` in [`src/modules/integrations/outbox.ts`](../src/modules/integrations/outbox.ts)) or any plugin's declared events. `customer.password_reset_requested` and `staff.password_reset_requested` carry password reset links, so they reach plugins only, never webhooks (`PLUGIN_ONLY_EVENT_TYPES`). Events reach handlers as they reach webhooks:

- **After commit, at least once.** The outbox worker creates one delivery (`plugin_event_deliveries`) per matching handler of each active plugin. Deliveries run one at a time, with up to 30 seconds per handler. A handler that throws or times out is retried with backoff (about 30 s, 1 min, 2 min … up to 6 h) until `WEBHOOK_MAX_ATTEMPTS` (8), then the delivery is dead. Staff can see and retry deliveries under the plugin in the admin.
- **Idempotent handlers.** A delivery can run twice, after a timeout or when a worker dies. Use `ctx.once` for effects that must happen once, such as an email.
- **Order** across events is not guaranteed.
- **While a plugin is inactive** it gets no deliveries for the events processed meanwhile. Deliveries created before it was disabled fail and retry, so re-enabling it in time still delivers them.
- **Emitting.** Declare event types in `emits`, named `<plugin>.<something>`. Webhook subscriptions and other plugins can subscribe to them, and the admin lists them among the event types.

### Checkout hook

```ts
hooks: {
  checkoutValidate: async (input, ctx) =>
    input.grandTotal > 500_000 ? [{ code: "TOO_LARGE", message: "Call us for orders over 5,000", field: ["cartId"] }] : [],
},
```

It runs before an order is placed, outside any transaction, for every active plugin at once, with 5 seconds each. Any issue refuses the order with a `ValidationError` whose field errors are the issues (`field` defaults to `["cartId"]`).

Checkout **fails open**: a hook that throws or times out is logged and ignored, so a broken plugin or a fraud service that is down can't stop every sale. A check that must always hold belongs in local code with no remote calls.

### Error reports

```ts
hooks: {
  onError: async (report, ctx) => {
    await ctx.fetch(trackerUrl, { method: "POST", body: JSON.stringify(report) });
  },
},
```

`onError` (SDK 1.1) receives every unexpected error the platform catches and logs, for an error tracker such as Sentry:

- **Sources.** `source` says where the error was caught:
  - `graphql`: a GraphQL request, masked as `INTERNAL_SERVER_ERROR` in production.
  - `route`: a plugin's HTTP route.
  - `payment-webhook`: a payment webhook.
  - `plugin-event`: a plugin's event handler, on each attempt.
  - `plugin-task`: a plugin's scheduled task.
  - `plugin-hook`: a plugin's `checkoutValidate`.
  - `plugin-start`: a plugin's `onStart`.
  - `worker`: a background worker run.
- **Contents.** `error` has the name, message and stack. `plugin` is the plugin involved, or null. `details` describes what was going on, such as the route's path or the event type and attempt.
- **Not reported:** expected outcomes of requests, such as validation errors, declined payments and unknown ids.
- **How it runs.** In the background, kept alive on Vercel, with 5 seconds per plugin. What the hook throws is logged, not reported again, so a tracker that is down can't cause a loop. Rate-limit repeated errors in the plugin.

### The catalog

`ctx.services.catalog` (SDK 1.1) shows products as a channel's storefront does, for search indexes, product feeds and marketing syncs. It uses the storefront API's own code (`src/modules/catalog/view.ts`).

```ts
let after: string | null = null;
do {
  const page = await ctx.services.catalog.listProducts({ channelId, locale: "en-GB", currency: "GBP", after });
  for (const product of page.products) await index(product);
  after = page.next;
} while (after);
```

- **Which products.** Only products sold in the channel, meaning active and published there, including those kept out of listings and search (`visibleInListings: false`). `listProducts` pages oldest first, at most 100 a page. `getProduct(id, scope)` returns null for a product the channel doesn't sell.
- **Locale and currency.** Texts are in the scope's locale, and prices in its currency, as a guest pays them, in minor units. Both fall back as the storefront API does, and each product says which locale and currency it used.
- **What a product holds.**
  - Name, slug, HTML description and SEO texts.
  - `path` (`/products/<slug>`) and `url` (the channel's storefront from Settings › Storefronts, then `path`).
  - Formatted attributes, categories with the names and slugs of their path, and media.
  - A price range and availability.
  - Active variants, with SKU, barcode, weight, options, price, compare-at price, availability and salable quantity.
- **Staying in sync.** `product.*` events and `price.updated`, whose payload names the product, say when to refresh a product. Stock reserved by orders, scheduled prices and exchange-rate changes send no product event, so syncs should also run a full pass as a scheduled task.

### Payment providers

`payments: [provider]` adds providers that payment methods can use (Settings › Payments). The provider talks to the PSP, and the platform owns orders, transactions and invoices. Provider methods get the plugin's context as their last argument. PSP webhooks arrive at `POST /payments/webhooks/<code>`. See [payments.md](payments.md) and the Stripe plugin in [`plugins/stripe/`](../plugins/stripe).

While the plugin is inactive, `isAvailable` is false, so checkout doesn't offer its payment methods. Its other methods fail with `InvalidStateError`, so capturing or refunding an existing order waits until it is active again.

### Shipping providers

`shipping: [provider]` adds rate engines and carriers that shipping methods can use (Settings › Shipping), with `methodOptions` per method. Rates are cached (`cacheSeconds`, default 600) and never fetched while an order is written, so a slow carrier can't hold up checkout. See [shipping.md](shipping.md) and the Shippo plugin, [spindlecommerce/plugin-shippo](https://github.com/spindlecommerce/plugin-shippo).

While the plugin is inactive, the provider's `isActive()` is false and its methods offer no rates. Calls to `rates` or `createShipment` fail with `InvalidStateError`.

### GraphQL

```ts
graphql: ({ builder, refs, ADMIN, context }) => {
  builder.objectField(refs.OrderRef, "loyaltyPoints", (t) =>
    t.int({
      subGraphs: ADMIN,
      authScopes: { permission: "loyalty:read" },
      resolve: async (order, _args, graphqlContext) => {
        const ctx = await context(graphqlContext);
        return (await ctx.kv.get<number>(`points:${order.id}`)) ?? 0;
      },
    }),
  );
},
```

- `builder` is the platform's [Pothos](https://pothos-graphql.dev) builder, and `refs` holds the platform's types to add fields to (`OrderRef`, `ProductRef`, `CustomerRef`, …). `toGlobalId` and `rawId` convert ids.
- Fields go to both APIs unless you pass `subGraphs: ADMIN` (or `STOREFRONT`).
- `context(graphqlContext)` gives the plugin's context, and fails with `InvalidStateError` while the plugin is inactive.
- Mutations follow the platform's style: `errors: {}` returns a result union. Admin mutations are recorded in the audit log.
- Run `pnpm schema:print` after changing `graphql`, so the printed schema includes the plugin's fields.

### HTTP routes

```ts
routes: (router, api) => {
  router.post("/webhook", async (c) => {
    const ctx = await api.context(c);
    // verify the signature first: routes are public
    return c.json({ received: true });
  });
},
```

`router` is a [Hono](https://hono.dev) app mounted at `/plugins/<name>/`, so this route is `POST /plugins/<name>/webhook`. Routes are public: verify what arrives, such as webhook signatures, and keep staff-only operations in GraphQL, where permissions apply. While the plugin is inactive, `api.context(c)` answers 503, which senders treat as "retry later". A route that throws answers 500 and is logged.

### Scheduled tasks

```ts
tasks: [{ name: "sync-stock", description: "Pulls stock levels from the ERP.", intervalMinutes: 15, run: async (ctx) => { … } }],
```

The worker runs an active plugin's task when its last run started at least `intervalMinutes` ago. A guarded upsert in `plugin_task_runs` claims each run, so one instance runs it however many workers tick. A run may take its interval or 5 minutes, whichever is shorter. The admin shows the last run's status and error, and can run a task now. Ticks come from the worker loop (every second in `pnpm dev`), or from cron and traffic on serverless hosts, so an interval is a minimum, not a schedule. Long jobs should process a page of work per run.

### Migrations

```ts
migrations: new URL("./migrations/", import.meta.url),
```

A directory of `.sql` files, each applied once, in name order (`plugin_migrations`), after the platform's migrations. `pnpm db:migrate` applies them, as do `createPlatform` with `migrate` (PGlite does so on start in development and tests) and the Vercel build. Each file runs in a transaction, and one migrating process waits for another rather than applying a file twice. Statements are split at drizzle-kit's `--> statement-breakpoint` markers when the file has them, else at semicolons outside strings, comments and dollar-quoted bodies. Prefix tables with the plugin's name. There are no down migrations, so write new files rather than editing applied ones.

### Admin modules

`admin: new URL("./admin.tsx", import.meta.url)` points at a module, made with `defineAdminPlugin`, that the admin build bundles: pages, navigation entries and widgets on platform screens. See [Writing admin modules](#writing-admin-modules).

### Permissions

```ts
permissions: [{ code: "loyalty:adjust", description: "Change a customer's points" }],
```

Codes are `area:action`, and `area:write` implies `area:read`, as for the platform's own. Roles and API keys are granted them like the platform's: `permissions` lists them, and `pluginPermissions` adds descriptions and the plugin's title. Check them with `authScopes: { permission: "loyalty:adjust" }` in GraphQL and in the plugin's admin pages.

### Connection check

`check: async (ctx) => ({ ok, message })` backs the admin's **Test connection** button. Check the settings against the remote service, such as whether an API key works, and say what you found. It runs with the saved settings, even while the plugin is disabled, for up to 15 seconds. If it throws, its error is the message.

## Writing admin modules

An admin module adds pages, with sidebar and ⌘K entries, widgets on the order, product and customer screens and the dashboard, and, if the generated settings form is not enough, a settings panel. The plugin's `admin: new URL("./admin.tsx", import.meta.url)` points at it, and its default export comes from `defineAdminPlugin`:

```tsx
// plugins/loyalty/admin.tsx
import { Award } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, defineAdminPlugin, graphql, Page, PageHeader, request, useQuery } from "@ecom/admin";

const PointsQuery = graphql(`
  query LoyaltyPoints($id: ID!) {
    loyaltyAccount(customerId: $id) {
      points
    }
  }
`);

/** On the customer screen: `id` is the customer's ID. */
const CustomerPoints = ({ id }: { id: string }) => {
  const query = useQuery({ queryKey: ["loyalty", "account", id], queryFn: () => request(PointsQuery, { id }) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Loyalty points</CardTitle>
      </CardHeader>
      <CardContent className="tabular text-2xl font-semibold">{query.data?.loyaltyAccount?.points ?? "—"}</CardContent>
    </Card>
  );
};

const Ledger = () => (
  <Page>
    <PageHeader title="Loyalty" description="Points earned and spent." />
    {/* … */}
  </Page>
);

export default defineAdminPlugin({
  pages: [{ path: "", title: "Loyalty", component: Ledger, nav: { label: "Loyalty", group: "Customers", icon: Award, permission: "loyalty:read" } }],
  widgets: [{ zone: "customer.detail", component: CustomerPoints, permission: "loyalty:read" }],
});
```

### How it gets into the admin

- **Bundled, never loaded by the server.** The admin build (`pnpm admin:build`, and `pnpm dev` and `pnpm admin:vite` while developing) reads `ecom.config.ts` and bundles each listed plugin's admin module as a chunk of its own. The admin loads a plugin's chunk once the plugin is active, and Settings › Plugins loads it in any state, for its settings panel. After adding a plugin, build the admin again: `pnpm dev` restarts by itself, and `pnpm admin:vite` needs a restart.
- **It runs in the browser.** From the admin, import only `@ecom/admin`, plus React, `lucide-react` icons and the libraries `@ecom/admin` re-exports. Never import the plugin's server code (its `index.ts`, or anything that imports `src/`), or it is bundled into the browser with everything it imports. Put constants both sides need in a small file that imports nothing.
- **Checked with the admin.** `pnpm typecheck` checks `plugins/**/admin.tsx` and files under `plugins/**/admin/` with the admin's TypeScript settings, so `graphql` documents are checked against `schema/admin.graphql`. That schema has the plugin's own fields once the plugin is in `ecom.config.ts` and `pnpm schema:print` has run. A plugin kept elsewhere, such as an npm package, adds its admin files to `include` in `admin/tsconfig.json`.
- **Styled with the admin's Tailwind.** Tailwind scans each bundled module's directory. Use its classes and the admin's colour tokens (`bg-card`, `text-muted-foreground`, `text-primary`, `border`…), and light and dark themes work. Build from `@ecom/admin`'s components rather than restyling them.

### Pages

```ts
{ path: "reviews/$id", title: "Review", component: ReviewPage, permission: "reviews:moderate" }
```

- **Where.** `/admin/plugins/<plugin name>/<path>`. `path` is `""` for the plugin's home page, `"reviews"`, or `"reviews/$id"` with a parameter. A path segment wins over a parameter (`reviews/new` before `reviews/$id`). The component gets `params` (`{ id: "42" }`), already decoded.
- **What it renders.** The whole screen, like the admin's own: `<Page>` with a `<PageHeader>` (title, description, actions, `back` link) and cards. `title` names the page elsewhere, as in Settings › Plugins or a missing-permission notice.
- **Who.** `permission`, by default the nav entry's, is checked before the page renders. Without either, any staff user may open it. A permission is a code, or a list of codes of which any one is enough, checked like the admin's (`area:write` implies `area:read`, `*` is everything).
- **In the sidebar and ⌘K.** `nav: { label, group, icon, permission, keywords }`. `group` is one of the sidebar's groups (`Sales`, `Catalog`, `Customers`, `Marketing`, `Content`, `Analytics`, `Settings`, `System`) or `Plugins`, the default, right before Settings. `icon` is a `lucide-react` icon, and `keywords` are more words ⌘K finds the page by. Pages with parameters have no entry.
- **Links between pages.** `<PluginLink to={`reviews/${encodeURIComponent(id)}`}>` links to one of the plugin's pages. Encode values, since global IDs contain `/`. `usePluginNavigate()` goes to one, and `pluginPath(name, path)` gives the path. Link to the admin's screens with `Link` (`<Link to="/orders/$number" params={{ number }}>`, typed against the admin's routes).
- **Failures.** A page that throws while rendering shows its error in place of the screen, and the sidebar keeps working. A plugin that is off, or an address with no page, gets a notice saying so.

### Widgets

```ts
{ zone: "order.detail", component: OrderRisk, permission: "orders:read" }
```

| Zone | Where | Props |
|---|---|---|
| `order.detail` | The order screen's side column, below Details | `{ id }`: the order's ID |
| `product.detail` | The product editor's side column (saved products) | `{ id }`: the product's ID |
| `customer.detail` | The customer screen's side column | `{ id }`: the customer's ID |
| `dashboard` | A grid below the dashboard's figures, also shown to staff who cannot see the figures | none |

A widget renders its own `<Card>`. Active plugins' widgets show in plugin order, as in `ecom.config.ts`, to staff with their `permission`, by default whoever sees the screen. A widget that throws shows its error in its place, and starts afresh on the next record.

### A settings panel

Settings › Plugins generates a form from the plugin's `settings`: text, numbers, switches and choices, defaults as placeholders, secrets with Set, Replace and Clear, and environment-supplied values read-only. A plugin that needs more, such as connecting an account with OAuth instead of pasting keys, replaces it with `settings: Panel`:

```tsx
const Panel = ({ plugin, save, canEdit }: PluginSettingsPanelProps) => {
  // plugin: name, title, enabled, configured, active, missingSettings, and `settings`: the
  //   descriptors with their values, ready for <SettingsForm>.
  // save(patch): keys left out keep their values, null clears one (a secret too); it rejects with
  //   a MutationError whose field errors are at ["input", "settings", key] (settingsErrors(error)).
  // canEdit: the viewer has settings:write.
};
```

For panels that only add something around the typed settings, `SettingsForm` with `initialSettingValues`, `changedSettings`, `validateSettings` and `settingsErrors`, all in `@ecom/admin`, renders them as the generated form does. The panel renders inside the Settings card, and `SaveBar`, `useSaveShortcut` and `useUnsavedChanges` give it the admin's save behaviour.

### The `@ecom/admin` API

[`admin/src/plugin-sdk.ts`](../admin/src/plugin-sdk.ts) is the admin's stable surface for plugins, as `src/plugins/sdk.ts` is the server's. Its exports keep working across releases. The rest of `admin/src` is internal.

| | Exports |
|---|---|
| Definition | `defineAdminPlugin`; types `AdminPluginDefinition`, `AdminPage`, `PluginPageProps`, `AdminWidget`, `WidgetZone`, `WidgetZones`, `NavGroupName`, `Permission`, `PluginInfo`, `PluginSettingsPanelProps` |
| The plugin's own pages | `usePlugin()` (its name and title), `PluginLink`, `usePluginNavigate`, `pluginPath` |
| Data | `graphql` (typed with the admin schema), `ErrorFields` and `MoneyFields` fragments, `ResultOf`, `VariablesOf`; `request`, `unwrap`, `ApiError`, `MutationError`, `FieldError`; `useQuery`, `useMutation`, `useQueryClient`, `useInfiniteQuery`, `keepPreviousData` (the admin's query client: start cache keys with the plugin's name); `useAction` (a mutation with a success toast, cache invalidation and errors shown); `useListSearch` and `useCursorPages` (filters and paging in the URL, for `DataTable`); `useDebounced`; `copyText`; `useAuth` (`can(permission)`, the viewer); `Link`, `useNavigate`; `toast` |
| Formatting | `formatMoney`, `formatAmount`, `formatNumber`, `formatPercent`, `formatDate`, `formatDateTime`, `relativeTime`, `countryName`; `cn`, `humanize` |
| Layout and display | `Page`, `PageHeader`, `TwoColumn`; `Card` and its parts; `Button`; `Badge`, `StatusBadge`, `BooleanBadge`; `Alert`, `EmptyState`, `Skeleton`, `Separator`, `Kbd`, `Detail`; `Table` and its parts; `DataTable` (the admin grid: search, filters and paging in the URL, column choice, export, keyboard) with `Column`; `JsonView` |
| Forms | `Field`, `FormSection`, `reportError`; `Input`, `Textarea`, `NativeSelect`, `Label`, `Select`, `Combobox`, `MultiSelect`, `Checkbox`, `Switch`; `Tabs` and section tabs; `SettingsForm` and its helpers; `SaveBar`, `useSaveShortcut`, `useUnsavedChanges` |
| Overlays and menus | `Dialog` and its parts, `Sheet`, `SheetContent`, `ConfirmDialog`, `Popover`, `Tooltip`; `DropdownMenu` and its parts |

[`test/fixtures/plugins/admin-demo/`](../test/fixtures/plugins/admin-demo) is a small complete example: a page in the navigation, a page with a parameter, widgets on the order screen and the dashboard, and settings of every type with a secret. Add `adminDemo()` to `ecom.config.ts` to try it. The email plugin's [`admin.tsx`](../plugins/email/admin.tsx) is a real one: a log of sent emails with filters, a preview and a test send.

## Security model

A plugin runs in the platform's process with the platform's rights: full database access, `ctx.platform`, the network and the environment. There is no sandbox, so treat a plugin like any other dependency:

- Review its code and updates as you would a change to the platform, and pin package versions.
- Prefer plugins that use the SDK and `ctx.services` over ones that reach into `ctx.platform` or the platform's tables.
- Secrets in settings are encrypted at rest and never leave the server through the admin API, but plugin code can read and send them. Never log settings.
- Plugin routes are public endpoints ([HTTP routes](#http-routes)).

## Compatibility

`apiVersion` is the plugin API a plugin was written for. This platform implements `PLUGIN_API_VERSION` (1), and refuses any other at startup, naming both versions. The version covers the exports of `src/plugins/sdk.ts` (definitions, field builders, context members other than `platform`, services and their return shapes, provider interfaces) and the behaviour described here. It doesn't cover `ctx.platform`, the platform's tables behind `ctx.db`, or the internal shapes of the objects behind `refs`. Additions that keep plugins working, such as a new context member or optional hook, don't change it.

The `@spindlecommerce/plugin-sdk` package's major version is the plugin API version: 1.x is API 1, and additions raise the minor version. A published plugin states the API version twice: `apiVersion: 1` in its definition, and a peer dependency on `@spindlecommerce/plugin-sdk` `^1.0.0`, which pnpm checks on install.

**What 1.1 added:**
- `services.catalog`;
- `services.channels.getByCode` and `channels.list`;
- the `onError` hook;
- `phone` and `acceptsMarketing` from `services.customers.get`;
- `couponCodes` on orders.

A plugin that uses any of them peer-depends on `^1.1.0`, so pnpm refuses it in an installation whose platform predates them.

## Vercel and other serverless hosts

- **Bundled.** `scripts/vercel-build.ts` bundles `ecom.config.ts` and the plugins into the function, npm ones included. Modules under `plugins/` keep their own `import.meta.url`, and the directories they name, such as `migrations/`, are copied into the function. The build applies a published plugin's migrations from the package's own folder, so they need a PostgreSQL database. A deployment without one (in-memory PGlite, as in `pnpm vercel:smoke`) can't apply them yet. Admin modules are bundled into the admin, not the function.
- **Migrations** run during the build, against PostgreSQL ([deploy-vercel.md](deploy-vercel.md)).
- **Events** are delivered when the worker runs: right after a request that wrote events, on the first request an instance serves each minute, and on Vercel Cron's calls. A retry waits for the next of those.
- **Tasks** run on the same worker ticks. On Hobby, whose cron runs once a day, they run while the site has traffic. Keep runs well under the function's 300-second limit.
- **Routes** need no configuration: every path that isn't a static file reaches the function.

## Testing plugins

`createTestPlatform` and `createTestApp` (in [`test/helpers/`](../test/helpers)) take `plugins`, `fetch` (a stand-in for remote services, which plugins reach through `ctx.fetch`) and `env` (for settings' environment variables):

```ts
const sent: unknown[] = [];
const t = await createTestApp({
  plugins: [orderAlerts()],
  env: { ORDER_ALERTS_WEBHOOK_URL: "https://chat.example.test/hook" },
  fetch: async (_url, init) => (sent.push(JSON.parse(String(init?.body))), new Response("ok")),
});
await t.platform.plugins.update("order-alerts", { settings: { threshold: 0 } }); // as staff would
// … place an order, then run the worker's steps:
while ((await processOutbox(t.platform)) > 0);
await deliverDuePluginEvents(t.platform);
expect(sent).toHaveLength(1);
```

`runDuePluginTasks(platform, { now })` runs due tasks, `t.platform.plugins.context(name)` gives a context, for its `kv` say, and `t.platform.plugins.check(name)` runs the connection check. [`test/integration/plugins.test.ts`](../test/integration/plugins.test.ts) tests every extension point this way, with the fixtures in [`test/fixtures/plugins/`](../test/fixtures/plugins).

Plugins from npm are tested the same way: [`test/integration/shippo-plugin.test.ts`](../test/integration/shippo-plugin.test.ts) tests `@spindlecommerce/plugin-shippo` through the platform. [`vitest.config.ts`](../vitest.config.ts) runs `@spindlecommerce/*` packages through Vite rather than Node, so in tests, as in production, they share the platform's SDK and error classes.

## Publishing a plugin

A plugin published to npm installs with `pnpm add` and a line in `ecom.config.ts`. [spindlecommerce/plugin-hello-world](https://github.com/spindlecommerce/plugin-hello-world) is a complete one, and a template repository to start from.

- **The SDK as a peer dependency.** Depend on `@spindlecommerce/plugin-sdk` `^1.0.0` as a peer and a dev dependency. In an installation, pnpm links the peer dependency to the platform's own SDK, the workspace package `packages/plugin-sdk` ([`pnpm-workspace.yaml`](../pnpm-workspace.yaml)), so the plugin shares the platform's classes: the `PaymentDeclinedError` it throws is the one checkout catches. Outside an installation it is the npm copy, built from the same source (below).
- **`apiVersion` as a number**, `1`, not `PLUGIN_API_VERSION`. In an installation that is the platform's own version, so the startup check could never refuse the plugin.
- **JavaScript.** Build to `dist/` (JavaScript and `.d.ts`) and point `exports` at it. Installations load plugins from `node_modules`, where Node doesn't strip TypeScript types.
- **No install scripts.** Add the `spindlecommerce-plugin` keyword, so plugins can be found on npm.
- **No admin module yet.** The admin's API, `@ecom/admin`, isn't published, so a package can't build an admin module against it.
- **Migrations** work as in `plugins/`, with the caveat under [Vercel](#vercel-and-other-serverless-hosts).

Versions are staged on npm, and go live when a member of the `spindlecommerce` npm organisation approves them on npmjs.com with 2FA ([staged publishing](https://docs.npmjs.com/staged-publishing)). Hello world's release workflow stages one for each `vX.Y.Z` tag with trusted publishing: no token, and npm records which commit and workflow run built it. Its README has the one-off `npm trust` setup.

### The SDK package

`pnpm sdk:package <dir>` ([`scripts/plugin-sdk-package.ts`](../scripts/plugin-sdk-package.ts)) builds the published `@spindlecommerce/plugin-sdk` into an empty folder, from `src/plugins/sdk.ts`, with the version in `packages/plugin-sdk/package.json`. The platform types the SDK mentions are replaced by the public stand-ins in [`packages/plugin-sdk/public/`](../packages/plugin-sdk/public), so nothing else of the platform is published:

- `ctx.db` is a Drizzle PostgreSQL database.
- `ctx.platform` and the GraphQL builder, refs and context are loose.
- `Address` is spelt out, and a test keeps it equal to the platform's.

When the SDK imports something with no stand-in, the build fails until one is added. To release, raise the version, run these, then approve the staged version on npmjs.com:

```bash
pnpm sdk:package ../plugin-sdk-release
cd ../plugin-sdk-release && npm stage publish
```

## A complete example

[`test/fixtures/plugins/order-alerts/index.ts`](../test/fixtures/plugins/order-alerts/index.ts) posts orders above a threshold to a chat webhook. It uses settings with a secret from the environment, an event handler with `once`, an emitted event, a permission, a GraphQL field, a route, a task and a connection check:

```ts
import { definePlugin, PLUGIN_API_VERSION, setting, type PluginOrder } from "../../src/plugins/sdk.ts";

const text = (order: PluginOrder, mention: string | undefined) =>
  `${mention ? `${mention} ` : ""}Order ${order.number}: ${(order.grandTotal / 100).toFixed(2)} ${order.currency} from ${order.email}`;

export const orderAlerts = () =>
  definePlugin({
    name: "order-alerts",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    title: "Order alerts",
    description: "Posts orders above a threshold to a chat webhook.",
    settings: {
      webhookUrl: setting.secret({ label: "Webhook URL", description: "An incoming webhook of Slack, Discord or Teams.", required: true, env: "ORDER_ALERTS_WEBHOOK_URL" }),
      threshold: setting.number({ label: "Threshold", description: "Alert on orders of at least this total, in minor units (cents).", default: 10_000, min: 0, integer: true }),
      mention: setting.string({ label: "Mention", placeholder: "@sales" }),
    },
    permissions: [{ code: "order-alerts:read", description: "See when an order was alerted" }],
    emits: ["order-alerts.sent"],

    events: {
      "order.placed": async (event, ctx) => {
        const order = await ctx.services.orders.get(event.aggregateId);
        if (!order || order.grandTotal < ctx.settings.threshold) return;
        // Deliveries are retried and may run twice: post once per order, whatever happens.
        const posted = await ctx.once(`order:${order.id}`, async () => {
          const response = await ctx.fetch(ctx.settings.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text(order, ctx.settings.mention) }),
          });
          if (!response.ok) throw new Error(`The webhook answered ${response.status}`);
        });
        if (!posted) return;
        await ctx.kv.set(`sent:${order.id}`, new Date().toISOString());
        await ctx.emit({ type: "order-alerts.sent", aggregateType: "Order", aggregateId: order.id, payload: { number: order.number } });
      },
    },

    // Order.alertSentAt in the admin API, for staff allowed to see it.
    graphql: ({ builder, refs, ADMIN, context }) => {
      builder.objectField(refs.OrderRef, "alertSentAt", (t) =>
        t.field({
          type: "DateTime",
          nullable: true,
          subGraphs: ADMIN,
          authScopes: { permission: "order-alerts:read" },
          description: "When the order was posted to the chat (Order alerts plugin).",
          resolve: async (order, _args, graphqlContext) => {
            const ctx = await context(graphqlContext);
            const at = await ctx.kv.get<string>(`sent:${order.id}`);
            return at ? new Date(at) : null;
          },
        }),
      );
    },

    // GET /plugins/order-alerts/status
    routes: (router, api) => {
      router.get("/status", async (c) => {
        const ctx = await api.context(c);
        return c.json({ sent: (await ctx.kv.list("sent:", { limit: 1000 })).length, threshold: ctx.settings.threshold });
      });
    },

    tasks: [
      {
        name: "forget",
        description: "Forgets alerts older than 90 days.",
        intervalMinutes: 24 * 60,
        run: async (ctx) => {
          const cutoff = Date.now() - 90 * 24 * 3600_000;
          for (const { key, value } of await ctx.kv.list<string>("sent:", { limit: 1000 })) if (Date.parse(value) < cutoff) await ctx.kv.delete(key);
        },
      },
    ],

    check: async (ctx) => {
      const response = await ctx.fetch(ctx.settings.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Order alerts are connected." }),
      });
      return response.ok ? { ok: true, message: "Posted a test message" } : { ok: false, message: `The webhook answered ${response.status}` };
    },
  });
```

## The admin API

Settings › Plugins uses these admin GraphQL operations:

| Operation | Permission | |
|---|---|---|
| `plugins`, `plugin(name)` | `settings:read` | Each plugin's state (`enabled`, `configured`, `active`, `missingSettings`), settings (secrets as `isSet` only, with their `source`: `ENV`, `ADMIN`, `DEFAULT` or `UNSET`), capabilities, permissions, tasks and event deliveries. |
| `activePlugins` | any staff | Names of the active plugins, so the admin shows their pages and widgets to staff who cannot read settings. |
| `pluginPermissions` | any staff | The plugins' permissions, with descriptions and plugin titles. |
| `pluginUpdate(name, input: { enabled, settings })` | `settings:write` | Enable, disable and configure. |
| `pluginCheck(name)` | `settings:write` | Test connection. |
| `pluginTaskRun(name, task)` | `settings:write` | Run a task now and wait for it. |
| `pluginDeliveryRetry(id)` | `settings:write` | Make a failed or dead delivery due now. |

Core code reaches plugins through `platform.plugins` ([`src/modules/plugins/types.ts`](../src/modules/plugins/types.ts)): `isActive(name)`, `context(name)` and `checkoutValidate(input)`. Their providers are in `platform.payments` and `platform.shipping`.
