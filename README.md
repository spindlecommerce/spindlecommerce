# SpindleCommerce

A headless commerce platform in TypeScript. It covers catalog, pricing, inventory, customers, carts, checkout, orders, promotions, tax, shipping, payments and page content, on PostgreSQL behind two GraphQL APIs built from one schema definition:

- **Storefront** at `/graphql`, for web, mobile and POS clients.
- **Admin** at `/admin/graphql`, for the back office and integrations.

It renders no storefront. A storefront in Next.js, or anything else, consumes the API. The back office is a React app at `/admin/`, built on the admin API.

- **[Architecture](docs/architecture.md)**: stack, modules, data model, request flow, order placement, limits and scope.
- **[GraphQL design](docs/graphql.md)**: API conventions, the schema's figures, caching, subscriptions and the main storefront operations.
- **[Admin](docs/admin.md)**: the back-office app, its screens and how it works, the admin API behind it, and its security model.
- **[Page builder and visual editing](docs/visual-editing.md)**: component-based pages, drafts, releases, previews, the visual editing protocol and connecting a frontend.
- **[Media library](docs/media.md)**: uploads straight to Vercel Blob, S3-compatible storage or local disk.
- **[Plugins](docs/plugins.md)**: events, checkout checks, payment and shipping providers, GraphQL, routes, tasks, tables and admin pages.
- **[Payments](docs/payments.md)**, **[shipping](docs/shipping.md)** and **[email](docs/email.md)**: payment sessions and PSP webhooks (Stripe), carrier rates and labels (Shippo), and transactional email.
- **[Deploying to Vercel](docs/deploy-vercel.md)**: the API and admin on Vercel Functions, with Neon or Supabase, Upstash Redis and Vercel Blob.
- **Schema:** [`schema/storefront.graphql`](schema/storefront.graphql) and [`schema/admin.graphql`](schema/admin.graphql) (generated SDL, checked in).

## Quick start

Requires Node.js ≥ 24.12 and pnpm. Development and tests need no database server: they use [PGlite](https://pglite.dev), Postgres compiled to WebAssembly. To use PostgreSQL in Docker instead, see [Docker](#docker).

```bash
pnpm install
cp .env.example .env
pnpm db:seed
pnpm dev
```

Open http://localhost:4000/admin/ and sign in with the seeded staff account from `.env`. GraphiQL is at http://localhost:4000/graphql and `/admin/graphql`.

The seed creates two channels:

- **`us`**: USD, prices exclude tax.
- **`eu`**: EUR and GBP in German, English and French, prices include tax.

It also loads configurable apparel and footwear, a virtual gift card, tax rules, shipping and payment methods, promotions (including the codes `SUMMER20` and `FREESHIP`), a staff user and a customer. Their dev credentials are in `.env.example`.

With the server running, `pnpm e2e` walks the whole order lifecycle over HTTP. It searches, builds a cart and checks out as a customer with a live `orderUpdated` subscription, then captures, ships and refunds as staff.

## Docker

Needs only Docker with Compose 2.24 or later (Docker Desktop, OrbStack, colima, or Docker Engine on Linux), not Node.js, pnpm or PostgreSQL. On colima, start the VM with `colima start --mount-inotify`, or file changes won't reach the container and `pnpm dev` won't reload. colima remembers the flag, and other runtimes pass file events through by default.

```bash
docker compose up --build
```

This builds the development image (Node.js 26.12.1, pnpm 11.13.1 and the dependencies) and starts PostgreSQL 18. On first start it migrates and seeds the database. Then it runs `pnpm dev` with your checkout mounted at `/app`, so edits reload without a rebuild.

| Service | Address |
|---|---|
| Admin | http://localhost:4000/admin/ (hot reload) |
| Storefront GraphiQL | http://localhost:4000/graphql |
| Admin GraphiQL | http://localhost:4000/admin/graphql |
| PostgreSQL | `localhost:5432`, database, user and password all `ecom` |

Change the host ports with `APP_PORT` and `POSTGRES_PORT`.

| Command | What it does |
|---|---|
| `docker compose exec app pnpm e2e` | End-to-end walkthrough against the running server |
| `docker compose run --rm app pnpm test` | Unit and integration tests |
| `docker compose exec app pnpm typecheck` | Typecheck |
| `docker compose exec postgres psql -U ecom` | SQL shell |
| `docker compose down -v` | Full reset: stop and delete the database and dependency volumes |

- **Dependencies.** A `node_modules` volume holds Linux builds, separate from any install on your machine. The entrypoint syncs it with `pnpm-lock.yaml` on every start, so a dependency change needs only a restart. Rebuild (`docker compose up --build`) when the `Dockerfile` changes.
- **Environment.** `compose.yaml` sets the server's environment. A `.env` in your checkout is read only for variables Compose doesn't set. Without one, the log line `.env not found. Continuing without it.` is expected.
- **Webhooks.** The compose environment allows private webhook URLs, so `http://host.docker.internal:<port>` reaches a receiver on your machine.
- **Dev container.** In VS Code, *Dev Containers: Reopen in Container* runs the same `app` service through [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json). Install extra tools in the `Dockerfile`, not as dev container features. Features make the tooling build from a generated Dockerfile that current Buildx Bake refuses to read (see [`.devcontainer/compose.devcontainer.yaml`](.devcontainer/compose.devcontainer.yaml)).
- **File ownership.** The container runs as the `node` user (uid 1000). On a Linux host where your uid differs, commands that write into the checkout from inside the container, such as `pnpm schema:print`, need a matching `user:` override in `compose.yaml`.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fspindlecommerce%2Fspindlecommerce&project-name=spindlecommerce&repository-name=spindlecommerce&env=JWT_SECRET%2CCRON_SECRET%2CBOOTSTRAP_ADMIN_EMAIL%2CBOOTSTRAP_ADMIN_PASSWORD%2CBOOTSTRAP_DEMO_DATA%2CENABLE_EXPERIMENTAL_COREPACK&envDefaults=%7B%22BOOTSTRAP_DEMO_DATA%22%3A%22true%22%2C%22ENABLE_EXPERIMENTAL_COREPACK%22%3A%221%22%7D&envDescription=Two%20random%20secrets%20%28openssl%20rand%20-base64%2048%20makes%20one%29%2C%20and%20the%20email%20and%20password%20%2812%20or%20more%20characters%29%20of%20the%20first%20admin.%20BOOTSTRAP_DEMO_DATA%3Dtrue%20fills%20the%20store%20with%20demo%20products%2C%20pages%20and%20orders%3B%20false%20starts%20it%20empty.&envLink=https%3A%2F%2Fgithub.com%2Fspindlecommerce%2Fspindlecommerce%2Fblob%2Fmain%2Fdocs%2Fdeploy-vercel.md%23deploy-button&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D)

The button deploys a demo store: a copy of this repository in your Git account, and a Vercel project with a Neon database and a Blob store. It asks for two secrets and the first admin, and the first build loads the demo data. Then deploy the [sample storefront](https://github.com/chachakawooka/Ecom-storefront) with the button in its README. See [Deploy button](docs/deploy-vercel.md#deploy-button).

The API and the admin deploy as one Vercel project, with state in Marketplace services: Neon or Supabase for PostgreSQL, Upstash for Redis (optional) and Vercel Blob for media. [docs/deploy-vercel.md](docs/deploy-vercel.md) has the steps.

- **Build.** `vercel.json` runs `pnpm vercel:build`. It builds the admin and writes `.vercel/output` in the Build Output API format: one Node.js 24 function for the API (an esbuild bundle), and the admin's assets on the CDN.
- **Settings.** Add `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel installs with pnpm 11. Set `JWT_SECRET` and `CRON_SECRET`.
- **Database.** Production builds apply migrations. `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` create the first admin, and `BOOTSTRAP_DEMO_DATA=true` loads the demo data into an empty store.
- **Background work.** A cron calls `/internal/worker` once a day, which every plan allows. On Pro, `WORKER_CRON_SCHEDULE="* * * * *"` runs it every minute. Changes also drain the outbox right after their request, so storefront revalidation webhooks go out within seconds, and traffic runs the worker in between.
- **Redis.** With it, subscriptions and the storefront response cache work across function instances. Without it, the cache is off.
- **Plugins.** Give them their keys as environment variables (`STRIPE_SECRET_KEY`, `SHIPPO_API_TOKEN`, `RESEND_API_KEY` from the Resend integration…) or in the admin. Stripe sends webhooks to `/payments/webhooks/stripe`.
- **Media.** Connect a Vercel Blob store (it sets `BLOB_READ_WRITE_TOKEN`), or use S3, R2 or Supabase Storage with the `S3_*` variables and a bucket CORS rule allowing `PUT` from the admin's origin. Local storage refuses uploads on Vercel. Browsers upload straight to storage, so the 4.5 MB function body limit does not apply. Storefronts need `SPINDLE_MEDIA_HOSTS` only for S3 or a CDN. See [docs/media.md](docs/media.md).

`pnpm vercel:build` and then `pnpm vercel:smoke` check the output locally.

## Admin

The admin at `/admin/` covers the store's day-to-day work:
- **Orders:** the grid with saved views, order detail with capture, ship, refund and cancel, creating orders for customers, and printable documents.
- **Catalog:** products with variants, prices per channel and currency, stock per location and media upload, plus categories with a merchandising board (drag to order, pin and hide what a category's page shows first), inventory, attributes and product types.
- **Customers and marketing:** customers and groups, promotions with a visual condition builder and coupons, and redirects.
- **Content:** pages built from components in a visual editor that frames the real storefront, product and category page templates, the component library and releases.
- **Reports:** live reports and a dashboard.
- **Settings:** channels, taxes, shipping, payments, currencies, stock locations, the storefronts pages preview in and deploy to, and plugins (enable, configure, test the connection).
- **System:** staff with two-factor sign-in and lockout, a role permission matrix, API keys, webhooks with a delivery log, and an audit log of every admin change.

`pnpm dev` serves it with hot reload. In production, `pnpm start` serves `admin/dist`, built once with `pnpm admin:build`. See [docs/admin.md](docs/admin.md).

## Plugins

Plugins are code. They are listed in [`ecom.config.ts`](ecom.config.ts) and bundled with the app, so they run wherever it does, Vercel included, and staff enable and configure them under Settings › Plugins. They extend the platform through typed extension points rather than patches, so two plugins cannot fight over the same code. The API they build on, `@spindlecommerce/plugin-sdk` (here `src/plugins/sdk.ts`), is versioned. Published plugins are npm packages: `pnpm add @spindlecommerce/plugin-hello-world`, then add `helloWorld()` to `ecom.config.ts`.

| Plugin | What it adds |
|---|---|
| [`email`](plugins/email/README.md) | Order confirmations, shipping notices with tracking, refunds, cancellations, password resets and low-stock alerts in the order's language, through Resend or Postmark, or logged only (the default). An Emails page shows what was sent. |
| [`stripe`](plugins/stripe/README.md) | Card and wallet payments with Stripe's Payment Element, captures and refunds from the admin, and webhooks that also complete orders whose customer never came back from Stripe. |
| [`shippo`](https://github.com/spindlecommerce/plugin-shippo#readme) | Live carrier rates at checkout, cached so a slow carrier never holds up an order, and labels with tracking when staff ship. Installed from npm as `@spindlecommerce/plugin-shippo`. |

A plugin can subscribe to events (after they commit, with retries), check orders before they are placed, provide payment and shipping methods, and add GraphQL types and fields, HTTP routes, scheduled tasks, its own tables, permissions, and admin pages and widgets. [docs/plugins.md](docs/plugins.md) shows how to write and publish one, and [spindlecommerce/plugin-hello-world](https://github.com/spindlecommerce/plugin-hello-world) is a template to start from.

## Page builder

Pages are trees of components such as heroes with buttons, product grids, category tiles, FAQs and columns. The component library is data the platform validates against, so developers can define components in their frontend's code and deploy them with `spindle-storefront components push` ([`@spindlecommerce/storefront-cli`](https://github.com/spindlecommerce/storefront-sdk/tree/main/packages/storefront-cli)). Editors work in a visual editor that frames the storefront: they click a component to edit it, see text change as they type, drag sections around, preview other channels, locales and dates, then publish, schedule or bundle pages into a release. Product and category pages are designed the same way, as templates whose components show the product's or category's data (gallery and add to cart, product listing). There is a default for each, and designs for particular categories or products. Publishing reaches storefronts through signed revalidation webhooks, or a deploy hook for static sites.

A Next.js sample storefront lives in its own repository, [Ecom-storefront](https://github.com/chachakawooka/Ecom-storefront). Clone it into `storefront/`, which this repository ignores. It renders the demo pages and templates, supports the visual editor end to end, and has a checkout with the test gateway, offline payments and Stripe. It is built on the storefront packages below. See [docs/visual-editing.md](docs/visual-editing.md).

## Storefront packages

Libraries for building a storefront on the Storefront API, published under `@spindlecommerce` from [spindlecommerce/storefront-sdk](https://github.com/spindlecommerce/storefront-sdk). The word after the scope says which side of the platform a package is for: `storefront-` for shop frontends, `plugin-` for extending the platform (`plugin-sdk`, `plugin-shippo`), and `admin-` for the Admin API and the admin app.

| Package | What it gives a storefront |
|---|---|
| `storefront-client` | A typed Storefront API client for any JavaScript runtime: pages, products, categories, carts and checkout, variant choice, webhook signatures, and the API's schema for your own queries. |
| `storefront-react` | Rendering page builder content with your own components, and a variant picker hook. |
| `storefront-next` | Next.js App Router integration: reads cached by tag, the cart in cookies, the preview, draft disable and revalidate routes, visual editing and `next/image` settings. |
| `storefront-cli` | `spindle-storefront components pull\|push\|types`: page builder components defined in the frontend's code. |

## Examples

Search the EU catalog in German. The operation declares its own context:

```graphql
query Search @inContext(channel: "eu", locale: "de-DE") {
  products(query: "trail", filter: { attributes: [{ code: "color", values: ["black"] }] }, first: 10) {
    totalCount
    edges { node { name slug priceRange { minVariantPrice { amount currencyCode formatted } } } }
    facets { attribute { code label } values { value label count selected } }
  }
}
```

One add-to-cart mutation works for every product type. Failures are typed results:

```graphql
mutation AddToCart($cartId: ID!) {
  cartLinesAdd(cartId: $cartId, lines: [{ sku: "TRL-BLACK-42", quantity: 1 }]) {
    __typename
    ... on CartPayload { cart { totalQuantity cost { total { formatted } } missing } }
    ... on InsufficientStockError { sku requested available }
    ... on Error { code message }
  }
}
```

Checkout has no ordered steps. `cartUpdate` saves any of the shopper's details in one call, as they type. An address can be incomplete, and shipping rates and tax follow once it has a postal code. The cheapest rate is selected until the shopper picks another, and the billing address is the shipping address unless they give one. Placing the order can send every detail in the same call, and is idempotent per key:

```graphql
mutation Checkout($cartId: ID!, $input: CartUpdateInput!) {
  checkoutPlaceOrder(cartId: $cartId, idempotencyKey: "4f1c2a9e-checkout-1", input: $input, payment: { token: "tok_visa" }) {
    ... on CheckoutPayload { order { number status paymentStatus } }
    ... on CartNotReadyError { missing fieldErrors { path message } }
    ... on ValidationError { fieldErrors { path message } }
    ... on PaymentDeclinedError { declineCode }
  }
}
```

with `input` such as `{ email: "sam@example.com", shippingAddress: { address: { firstName: "Sam", lastName: "Lee", line1: "500 Howard St", city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" } }, paymentMethodCode: "card" }`. Every problem comes back at once, field by field.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` / `pnpm start` | Run the server. The outbox worker runs in-process unless `WORKER=external`. |
| `pnpm worker` | Standalone outbox and webhook worker. Several can run at once. |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / load demo data. The seed refuses to run with `NODE_ENV=production`. |
| `pnpm db:seed:orders [count]` | Place demo orders (default 80) over the last 90 days through the real checkout, for the dashboard and reports. With PGlite, stop the server first. |
| `pnpm db:generate` | Generate a SQL migration from the Drizzle tables (`src/modules/*/tables.ts`). |
| `pnpm test` | Unit and integration tests (Vitest, in-memory PGlite). |
| `pnpm typecheck` | `tsc --noEmit` (TypeScript 7) for the server and the admin app. |
| `pnpm admin:build` | Build the admin app into `admin/dist`, which `pnpm start` serves at `/admin/`. |
| `pnpm admin:vite` | Run the admin on Vite's own dev server (port 5173), proxying API calls to `ADMIN_API_URL`. |
| `pnpm vercel:build` | Build the admin and the Vercel output (`.vercel/output`), and migrate when a PostgreSQL URL is set. See [docs/deploy-vercel.md](docs/deploy-vercel.md). |
| `pnpm vercel:smoke` | Run the built Vercel function locally against an in-memory and a seeded database, and check its routes. |
| `pnpm schema:print` | Regenerate `schema/*.graphql`, `schema/stats.json` and the admin's typed GraphQL environment. |

## Configuration

Set in the environment or `.env`. See [`src/config.ts`](src/config.ts) for every option.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | in-memory PGlite | `pglite:<dir>` for local persistence, `postgres://…` for production. Falls back to `POSTGRES_URL` |
| `REDIS_URL` | none | `redis://` or `rediss://`, falling back to `KV_URL`. Shares subscriptions and the response cache between processes |
| `GRAPHQL_RESPONSE_CACHE` | `auto` | `memory`, `redis` or `off`. `auto` is Redis when set, off on Vercel without it, memory otherwise |
| `JWT_SECRET` | random per process | Required in production |
| `PORT` | `4000` | |
| `DEFAULT_CHANNEL` | first active channel | Used when a request names no channel |
| `GRAPHQL_MAX_DEPTH` / `GRAPHQL_MAX_COMPLEXITY` | 12 / 2000 | Admin complexity budget: `GRAPHQL_ADMIN_MAX_COMPLEXITY` (20000) |
| `GRAPHQL_INTROSPECTION` | on outside production | |
| `PERSISTED_OPERATIONS_FILE` | unset | JSON map of hash → document. When set, only those operations run |
| `STOREFRONT_CORS_ORIGINS` / `ADMIN_CORS_ORIGINS` | `*` / none | Comma-separated |
| `TRUST_PROXY` | 0, or 1 on Vercel | How many reverse proxies in front of the API append to `X-Forwarded-For`. Audit entries record the address the outermost one saw; with 0, the connection's address |
| `WORKER` | in-process | `external` when running `pnpm worker` separately |
| `CRON_SECRET` | none | Bearer token for `GET`/`POST /internal/worker`, which runs one worker tick. Required to use it in production |
| `ADMIN_URL` | `http://localhost:<PORT>/admin` | Public admin URL, used in staff password reset links. On Vercel, the deployment's own domain |
| `ADMIN_APP_DIR` | `admin/dist` | Built admin app to serve at `/admin/`. Empty disables it |
| `ADMIN_DEV` | on outside production | `false` stops `pnpm dev` from serving the admin from source |
| `STAFF_LOCKOUT_FAILURES` / `STAFF_LOCKOUT_MINUTES` | 5 / 15 | Failed staff sign-ins before an account locks, and for how long |
| `MEDIA_STORAGE` | see notes | `local`, `vercel-blob` or `s3`. Unset: Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, else S3 when `S3_BUCKET` is set, else local. See [docs/media.md](docs/media.md) |
| `BLOB_READ_WRITE_TOKEN` | none | Vercel Blob. Set when a Blob store is connected to the Vercel project |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | none / `auto` / AWS | S3-compatible storage (AWS, R2, Supabase, MinIO), with `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` and `S3_FORCE_PATH_STYLE` |
| `MEDIA_PATH_PREFIX` | `media` | Object key prefix for Vercel Blob and S3 |
| `MEDIA_DIR` / `MEDIA_PUBLIC_URL` / `MEDIA_MAX_BYTES` | `.data/media` / `ADMIN_URL` without `/admin` / 20 MB | Local storage, and the upload size limit for every provider |
| `ALLOW_PRIVATE_WEBHOOK_URLS` | off | `true` lets webhooks, including storefront revalidation, target localhost and private networks. Development only. Docker Compose sets it |
| `SAMPLE_STOREFRONT_URL` | `http://localhost:3000` | The seeded storefront the page editor previews in |

In production, point `DATABASE_URL` at PostgreSQL ≥ 16 and run `pnpm db:migrate`.

## Using it from Next.js

The app is a Web-standard fetch handler, so it can also be mounted in a Next.js catch-all route handler:

```ts
// app/api/[...ecom]/route.ts → /api/graphql and /api/admin/graphql
import { createApp } from "ecom/src/app.ts";

const { fetch } = await createApp({ basePath: "/api" });
export { fetch as GET, fetch as POST, fetch as OPTIONS };
```

Mounted this way, outbox events are processed only while the app is loaded. In production, run `pnpm worker` alongside it, or call `/api/internal/worker` from a scheduler with `CRON_SECRET`.

## Layout

```
src/
  modules/<domain>/   tables.ts (Drizzle), service.ts and read.ts (domain logic), engine.ts (pure rules)
  graphql/            builder (Pothos plugins), context, loaders, pagination, types/ per domain, schema, Yoga
  db/                 client (PGlite | node-postgres), migrations, seed
  http/               browser sign-in, media upload, admin app serving (built and dev)
  vercel/             the Vercel function (handler.ts), background work without a server, build-time database steps
  plugins/sdk.ts      the plugin API (definePlugin and every extension point's types)
  app.ts server.ts worker.ts platform.ts config.ts
plugins/              first-party plugins: email and stripe (listed in ecom.config.ts, with Shippo from npm)
packages/plugin-sdk/  @spindlecommerce/plugin-sdk, the plugin API as a package (pnpm sdk:package builds it for npm)
test/                 unit/ (pure engines) and integration/ (domain lifecycle, storefront API, admin API, back office)
admin/                admin app (React, Vite, TanStack Router and Query, Tailwind, gql.tada)
docs/                 architecture, GraphQL design, admin, page builder, media, plugins, payments, shipping, email, Vercel
schema/               generated SDL and statistics
```
