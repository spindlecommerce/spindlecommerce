# Architecture

SpindleCommerce is a headless commerce platform written in TypeScript, on PostgreSQL behind a GraphQL-first API. It renders no storefront. Clients such as a Next.js storefront, mobile apps, POS and ERP integrations use two GraphQL APIs built from one schema definition.

[`graphql.md`](graphql.md) defines the API conventions. [`admin.md`](admin.md) covers the admin app.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript (strict) on Node.js ≥ 24.12, run with native type stripping, so there is no build step | One typed language from schema to SQL |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server` | Web-standard `Request`/`Response`. Runs on Node, Bun, Deno, edge, or inside a Next.js route handler |
| GraphQL server | [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) 6 (graphql-js 17) | Spec-compliant, with plugins for SSE subscriptions, persisted operations and response caching |
| Schema | [Pothos](https://pothos-graphql.dev) code-first, with the sub-graph, errors, scope-auth, relay, complexity and simple-objects plugins, and request-scoped DataLoaders | Resolvers are type-checked against the schema. One definition is split into storefront and admin APIs |
| Database | PostgreSQL ≥ 16 through [Drizzle ORM](https://orm.drizzle.team), and [PGlite](https://pglite.dev) (Postgres in WASM) for local development and tests | Typed attribute values in JSONB with GIN indexes. Full-text search and projections live in the same database |
| Validation | Zod 4 | One schema per input, shared by GraphQL and services |
| Auth | Argon2id password hashes, 15-minute JWT access tokens (`jose`) with rotating refresh tokens, scoped API keys | Stateless reads, revocable sessions, least-privilege integrations |
| Jobs and events | Transactional outbox in Postgres, drained by a worker that runs projections and signed webhooks | Events commit atomically with state, with no message broker |
| Search | Postgres full-text search plus JSONB facets over a `product_search` projection, behind a `SearchEngine` interface | No extra infrastructure. An external engine can be swapped in behind the interface |
| Caching | Yoga response cache keyed by channel, locale, currency and customer group, and invalidated by entity id from the outbox | Caches GraphQL results, not pages |

### Why the core is not a Next.js app

Next.js is a rendering framework. A commerce core needs things it handles poorly or not at all: a long-lived worker that drains the outbox and retries webhooks, a database connection pool rather than per-invocation connections, streaming subscriptions, and a deployment model not bound to serverless request lifetimes.

The core still fits a Next.js stack. Every endpoint is a Web-standard `fetch` handler, so for a single deployment it can be mounted inside a Next.js route handler, as `test/integration/app.test.ts` checks:

```ts
// app/api/[...ecom]/route.ts in a Next.js app → /api/graphql and /api/admin/graphql
import { createApp } from "ecom/src/app.ts";
const { fetch } = await createApp({ basePath: "/api" });
export { fetch as GET, fetch as POST, fetch as OPTIONS };
```

## Module map

Each module in `src/modules/<name>/` owns its tables (`tables.ts`) and domain logic (`service.ts`, pure functions where possible). Its GraphQL types are in `src/graphql/types/`. Modules call each other through exported service functions, never through another module's tables.

| Module | Responsibility |
|---|---|
| `channels` | Sales channels: currencies, locales, countries, stock, tax display, order numbering |
| `catalog` | Attribute definitions, product types, products, variants, translations, media, categories, channel listings, redirects |
| `pricing` | Price lists per channel and currency: dated, compare-at, tier and customer-group prices, exchange-rate fallback. Also the pure totals pipeline (`totals.ts`): lines → discounts → shipping → shipping discount → tax → grand total |
| `inventory` | Stock locations, stocks, stock levels, reservations, salable quantity |
| `search` | `product_search` projection, full-text search with prefix matching, disjunctive facets and a price range, sorting, including each category's merchandised order |
| `customers` | Customers, addresses, groups |
| `auth` | Password hashing, JWT access tokens, refresh-token rotation, password reset, API keys |
| `carts` | Carts and lines, guest and customer carts, merge on login. Checkout details in one call (`cartUpdate`), with incomplete addresses priced as far as they go |
| `promotions` | Cart rules with typed conditions and actions (`percentage_off`, `fixed_off_each`, `fixed_off_cart`, `buy_x_get_y`, and `shipping_off` for shipping discounts and free shipping), applied in priority order, each able to stop the rules after it. Coupons, coupon generation, usage limits |
| `tax` | Tax classes, rates, rules, compounding by priority, inclusive and exclusive prices |
| `shipping` | Zones and methods: flat rate, table rate, free shipping, and live carrier rates from plugins |
| `payments` | Provider registry: offline methods (bank transfer, check or money order, cash on delivery), a test card gateway and plugins' providers. Transactions |
| `checkout` | Idempotent order placement: one transaction, then payment authorization with a compensating rollback on decline |
| `orders` | Orders, lines, captures and invoices, fulfilments, refunds with prorated amounts and restocking, cancellation, timeline |
| `builder` | Page builder: component library, pages as component trees with drafts, versions, schedules and releases, product and category templates, storefront previews and deploys |
| `staff` | Staff users, roles, permissions, lockout, TOTP two-factor, per-user preferences |
| `audit` | Who did what in the admin: every mutation and sign-in, with redacted input |
| `reports` | Live dashboard and reports: sales by period, best sellers, customers, promotions, low stock, abandoned carts |
| `integrations` | Webhook subscriptions, deliveries, outbox worker |
| `media` | Media library: assets, presigned uploads, storage on Vercel Blob, S3-compatible services or local disk, file type checks |
| `plugins` | Plugin runtime: registry, settings, event delivery, scheduled tasks, routes, payment and shipping providers, migrations, key-value store |

## Admin app

The admin is a React single-page app in `admin/`, built with Vite and served by the API at `/admin/`. Its page editor frames registered storefronts and talks to them through the visual editing bridge (`src/visual-editing/bridge.js`, see [visual-editing.md](visual-editing.md)). The admin's CSP allows framing exactly those origins. In development, Vite runs in middleware mode inside the API process (`src/http/admin-dev.ts`), so `pnpm dev` serves the API and a hot-reloading admin on one port. Browsers sign in through `/admin/auth/*`, which keeps the refresh token in an httpOnly cookie. See [`admin.md`](admin.md).

## Data model principles

- **UUIDv7 primary keys.** Time-ordered, so they index well and the application can generate them. The API exposes them as global IDs: `gid://ecom/Product/<uuid>`.
- **Money as integer minor units** (`bigint`) with an ISO 4217 currency, never floats. Sales tables keep one amount per concept, in the order currency.
- **Every product has at least one variant.** A simple product has one variant, and a configurable product has variants along `variant_attributes` axes. Carts and orders reference variants, so one add-to-cart operation serves every product type. A product type can be non-shippable, for virtual products such as gift cards.
- **Attributes are typed definitions plus JSONB values** (`products.attributes`, `product_variants.attributes`), validated against their definitions on write, with GIN indexes for filtering.
- **Localized text lives in `*_translations` tables** keyed by BCP 47 locale, with a unique slug per locale. Changing a product's or category's slug records a 301 redirect from the old path.
- **Categories form a materialized-path tree**: moving a category moves its subtree with it.
- **Inventory is reservation-based.** Salable quantity is the stock levels at a stock's locations plus that stock's reservations. Placing an order adds a negative reservation. Fulfilment deducts stock at a location and adds a compensating reservation, and cancellation compensates. Nothing locks a stock-level row at checkout.
- **Order state is three state machines:** `status` (open / completed / canceled), `paymentStatus` and `fulfillmentStatus`. Each change appends an `order_events` row and an outbox event.
- **Projections are updated in the transaction that changes their source**, so they never lag behind it. `searchReindex` rebuilds the search projection in full.

## Request flow

```
HTTP ─► Hono ─► /graphql ───────► Yoga (storefront sub-graph) ┐
             └► /admin/graphql ─► Yoga (admin sub-graph) ─────┤ context: channel, locale, currency,
                                                              │ customer or staff or API key, loaders
                                                              ▼
                                               Pothos resolvers ─► module services ─► Drizzle ─► Postgres
                                                                         │                 (same transaction)
                                                                         └─► outbox_events
worker ─► drains outbox ─► webhooks (HMAC-signed, retried) / subscription pubsub / cache invalidation
```

## Order placement

`checkoutPlaceOrder` runs as a two-step saga, so no external call happens inside a database transaction. Details sent with it (`input`) are first saved to the cart, as `cartUpdate` saves them.

1. **One transaction:**
   - lock the cart row and re-price it with `buildQuote`;
   - refuse with `CartNotReadyError` if anything is missing, field by field;
   - reserve stock under per-variant advisory locks;
   - write the order, its lines and its totals snapshot;
   - record promotion usage;
   - mark the cart converted;
   - emit `order.placed`.
2. **Authorize the payment with the provider.**
   - On success, record the transaction and update the payment status. With capture at checkout, also create the invoice.
   - On decline, a compensating transaction releases the reservations, reverses promotion usage, cancels the order, reopens the cart and frees the idempotency key, so the shopper can retry with another card.

Retrying with the same `idempotencyKey` (scoped to the cart) returns the existing order.

## Operations and limits

- **Processes.** `pnpm start` serves both APIs and drains the outbox in-process. To separate them, run `pnpm worker` processes and set `WORKER=external`. Any number of workers can run, since batches are claimed with `FOR UPDATE SKIP LOCKED`.
- **Fan-out across instances.** Response-cache invalidation and `orderUpdated` subscriptions use a pub/sub fed by the worker. Without Redis it runs in-process, which is exact in a single process. With Redis (`REDIS_URL`, or Upstash's `KV_URL`), the response cache and subscriptions are shared across instances, as several replicas or serverless functions need. See [Deploying to Vercel](deploy-vercel.md).
- **Search paging.** Search results use offset cursors capped at 10,000 results, since relevance ranking has no stable keyset. Every other list uses keyset cursors on time-ordered ids.
- **PGlite is for development and tests.** It runs one connection in-process. Production uses PostgreSQL ≥ 16 through `pg` (`DATABASE_URL=postgres://…`, `pnpm db:migrate`).
- **Secrets.** Webhook secrets and API keys are shown once. API keys and refresh tokens are stored as SHA-256 hashes, passwords as Argon2id. Webhook signing secrets are stored in plaintext because HMAC needs them. Encrypting them at rest is future work.
- **Webhook targets.** Loopback, link-local (cloud metadata) and private-network URLs are refused, unless `ALLOW_PRIVATE_WEBHOOK_URLS=true` for local development. A URL is checked when it is saved, and every delivery checks the addresses its host resolves to before connecting, so DNS can't point a webhook at an internal service later. Deliveries don't follow redirects.
- **Rate limiting.** Staff sign-in locks an account after repeated failures (`STAFF_LOCKOUT_FAILURES`, `STAFF_LOCKOUT_MINUTES`). Customer sign-in throttling and per-client rate limits are not built in, and query cost limits cover only expensive queries. Put the API behind a gateway or WAF that enforces them.

## Scope

- **Not built yet:**
  - Bundle, grouped and downloadable products. They would fit the variant model as bundle components or link entitlements.
  - Rule-based discounts on catalog prices. Use dated prices, or promotions, which apply in the cart.
  - CSV import beyond stock levels, tax rates and redirects. Every admin grid exports CSV.
- **Out of scope:** wishlists, compare lists, reviews, newsletters, gift messages, returns (RMA), B2B and multi-address checkout.
- **Not applicable:** themes, layouts, full-page caching and storefront JavaScript. The platform is headless, and caching is per GraphQL result.

## Extending the platform

Code extends the platform at typed extension points, not by replacing its methods, so behaviour stays easy to trace:

1. **Domain events** (`order.placed`, `product.updated`, …), written to the outbox in the state change's transaction and delivered at least once to in-process handlers and webhooks.
2. **Provider interfaces** for payments, shipping rates, search and tax, registered at startup.
3. **Typed rule data.** Promotion conditions and actions are serializable JSON validated by Zod, so new behaviour is data, not code patches.

[Plugins](plugins.md) build on the first two: they handle events and provide payment and shipping providers. They can also check orders before they are placed, and add GraphQL fields, HTTP routes, scheduled tasks, tables, permissions and admin pages.
