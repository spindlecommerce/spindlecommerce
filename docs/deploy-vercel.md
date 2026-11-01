# Deploying to Vercel

The platform (both GraphQL APIs and the admin) deploys as one Vercel project. Vercel Functions run the code, and Marketplace services hold the state:

| State | Service | What it holds |
|---|---|---|
| PostgreSQL | **Neon** (or Supabase) | Everything. Required. |
| Redis | **Upstash** | GraphQL subscriptions and cache invalidation across function instances, and the shared storefront response cache. Optional. |
| Object storage | **Vercel Blob** (or S3, R2, Supabase Storage) | Uploaded images and videos. Required for media uploads. |

## Deploy button

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fspindlecommerce%2Fspindlecommerce&project-name=spindlecommerce&repository-name=spindlecommerce&env=JWT_SECRET%2CCRON_SECRET%2CBOOTSTRAP_ADMIN_EMAIL%2CBOOTSTRAP_ADMIN_PASSWORD%2CBOOTSTRAP_DEMO_DATA%2CENABLE_EXPERIMENTAL_COREPACK&envDefaults=%7B%22BOOTSTRAP_DEMO_DATA%22%3A%22true%22%2C%22ENABLE_EXPERIMENTAL_COREPACK%22%3A%221%22%7D&envDescription=Two%20random%20secrets%20%28openssl%20rand%20-base64%2048%20makes%20one%29%2C%20and%20the%20email%20and%20password%20%2812%20or%20more%20characters%29%20of%20the%20first%20admin.%20BOOTSTRAP_DEMO_DATA%3Dtrue%20fills%20the%20store%20with%20demo%20products%2C%20pages%20and%20orders%3B%20false%20starts%20it%20empty.&envLink=https%3A%2F%2Fgithub.com%2Fspindlecommerce%2Fspindlecommerce%2Fblob%2Fmain%2Fdocs%2Fdeploy-vercel.md%23deploy-button&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D)

The button deploys a demo store in one flow. Vercel copies this repository to your GitHub, GitLab or Bitbucket account, creates a project with a Neon database and a Blob store ([step 2](#2-add-postgres-redis-and-blob-from-the-marketplace)), asks for these variables, then builds and deploys:

| Variable | What to enter |
|---|---|
| `JWT_SECRET`, `CRON_SECRET` | Two different random strings. `openssl rand -base64 48` makes one. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | The first admin. The password needs 12 characters or more. |
| `BOOTSTRAP_DEMO_DATA` | Filled in as `true`: the build loads the demo store, with products, pages and three months of orders. `false` starts with an empty store. |
| `ENABLE_EXPERIMENTAL_COREPACK` | Filled in as `1`, so the build uses pnpm 11. Leave it. |

When the deployment is ready:

1. Open `https://<project domain>/admin/` and sign in as the first admin. Then delete `BOOTSTRAP_ADMIN_PASSWORD` under **Settings › Environment Variables** and change your password ([step 4](#4-deploy-migrations-and-the-first-admin)).
2. Deploy the sample storefront with the button in [its README](https://github.com/chachakawooka/Ecom-storefront#deploy-on-vercel). It asks for this project's URL.
3. In the admin, under **Settings › Storefronts**, change the Sample storefront's URL to the storefront's, so the page editor previews in it ([step 8](#8-connect-a-storefront)).

The project runs on any plan. On Hobby, background work runs after changes, with traffic and once a day ([step 5](#5-background-work-and-cron-limits)). Redis is left out: add it for subscriptions across instances ([step 2](#2-add-postgres-redis-and-blob-from-the-marketplace)). The demo takes payments with the test card gateway and offline methods, so no money moves. For a real store, start empty (`BOOTSTRAP_DEMO_DATA=false`) or first remove the demo's products, promotions and payment methods.

## How it works

**Build.** `vercel.json` sets the build command to `pnpm vercel:build`. It builds the admin, then [`scripts/vercel-build.ts`](../scripts/vercel-build.ts) writes `.vercel/output` in the [Build Output API v3](https://vercel.com/docs/build-output-api) format. Because the build leaves `.vercel/output/config.json` behind, Vercel deploys that directory as is ([`@vercel/static-build`](https://github.com/vercel/vercel/blob/main/packages/static-build/src/utils/build-output-v3.ts) detects it right after the build command). `vercel.json` also sets `"framework": null`, so Vercel doesn't detect Hono and try its zero-config Hono deployment, which knows nothing of this layout.

```
.vercel/output/
  config.json                 routes and the worker cron
  static/admin/assets/…       the admin's hashed JS, CSS and fonts (CDN, cached for a year)
  static/admin/favicon.svg
  functions/index.func/
    .vc-config.json           nodejs24.x, Node.js launcher, response streaming, maxDuration 300
    index.mjs (+ .map)        the API: one esbuild ESM bundle of src/vercel/handler.ts and its dependencies
    admin/dist/index.html     the admin page, served by the function with a per-request CSP
    src/db/migrations/        for PGlite only; Postgres is migrated by the build
    src/visual-editing/bridge.js
    node_modules/@node-rs/argon2, …/argon2-linux-x64-gnu   password hashing (native, so not bundled)
```

Routing checks static files first, then sends every other path to the function at its original path: `/graphql`, `/admin/graphql`, `/admin/auth/…`, `/admin/…`, `/media/…`, `/visual-editing/…`, `/payments/webhooks/…`, `/plugins/…` (plugins' own routes), `/health` and `/internal/worker`. A missing `/admin/assets/…` file, such as a chunk from an older deployment, is a plain 404. PGlite is not bundled: [`src/db/client.ts`](../src/db/client.ts) imports it only for `memory:` and `pglite:` URLs.

**Runtime.** One Node.js 24 function with [Fluid compute](https://vercel.com/docs/fluid-compute) (`"fluid": true` in `vercel.json`, the default for new projects). [`src/vercel/handler.ts`](../src/vercel/handler.ts) creates the app on an instance's first request and reuses it for later requests, several at a time. The PostgreSQL pool has 5 connections and is registered with `attachDatabasePool`, so idle connections close before Vercel suspends the instance. `NODE_ENV` defaults to `production`: `JWT_SECRET` is required, and introspection, GraphiQL and detailed errors are off.

**Background work.** The [worker](../src/modules/integrations/worker.ts) runs in three ways, all safe on several instances at once:

1. **Vercel Cron** calls `GET /internal/worker` with `Authorization: Bearer $CRON_SECRET`, once a day by default ([step 5](#5-background-work-and-cron-limits)). A tick publishes scheduled pages and releases, drains the outbox (webhooks, subscriptions, cache invalidation) and delivers due webhooks.
2. **After a change.** A request that wrote outbox events, such as an admin mutation, checkout or a password reset request, drains the outbox under `waitUntil` after its response. A publish reaches the storefront's revalidation webhook within seconds.
3. **With traffic.** The first request an instance serves each minute runs a full tick under `waitUntil`, so Hobby projects publish scheduled content while they have traffic.

Outbox batches are claimed with `FOR UPDATE SKIP LOCKED`, webhook deliveries one at a time under a lease, and scheduled publishing runs under an advisory lock. Two instances never send the same delivery at once or publish a page twice. Delivery stays at least once: if a run dies mid-send, the delivery is retried when its lease runs out.

**Across instances.** With Redis (Upstash):

- **Pub/sub.** `orderUpdated`, `orderActivity` and `invalidate` travel over Redis pub/sub ([`src/lib/redis-event-target.ts`](../src/lib/redis-event-target.ts)), so a subscription on one instance sees events processed on any other.
- **Response cache.** The storefront response cache lives in Redis ([`src/graphql/response-cache.ts`](../src/graphql/response-cache.ts)). The worker that processes a change invalidates it for every instance before delivering that change's webhooks, so a storefront revalidating on the webhook never gets a response cached before the change.
- **Isolation.** Keys and channels are prefixed with a hash of the database URL, and cache keys also with the deployment id. Production and a preview on its own Neon branch can share one Upstash database without seeing each other's events or cache.

Without Redis:

- **The response cache is off.** An instance cannot invalidate another's memory, so the revalidating storefront could read a response cached before a publish. `GRAPHQL_RESPONSE_CACHE=memory` turns it back on, accepting up to `GRAPHQL_RESPONSE_CACHE_TTL_MS` (60 s) of staleness.
- **Subscriptions see only events processed on their own instance.** The worker runs wherever the cron request or the change landed, often another instance. Add Redis if staff watch orders live or customers follow order status.

## 1. Create the project

1. In Vercel, **Add New › Project** and import the repository.
   - Leave the framework preset, build and output settings alone: `vercel.json` sets them (Other, `pnpm vercel:build`).
   - Keep the default install command, `pnpm install`.
   - Node.js 24 comes from `engines` in `package.json`.
2. Add `ENABLE_EXPERIMENTAL_COREPACK=1` before the first deployment. [Vercel then uses Corepack](https://vercel.com/docs/builds/configure-a-build#corepack) to install the pnpm version in `packageManager` (`pnpm@11.13.1`). Without it, Vercel picks pnpm 9 or 10 from the lockfile version (`9.0`), which ignore pnpm 11 settings such as `allowBuilds` in `pnpm-workspace.yaml`.
3. Keep **Automatically expose System Environment Variables** on (the default). The API reads `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` and `VERCEL_DEPLOYMENT_ID`.
4. Under **Settings › Functions**, set the function region to the database's region.

The first deployment can fail until `JWT_SECRET` is set ([step 3](#3-environment-variables)).

## 2. Add Postgres, Redis and Blob from the Marketplace

On the project's **Storage** tab:

1. **Neon** (Postgres). Create a database and connect it to the project for all environments. It sets `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct) and the older `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING`, among others. The API connects through the pooled URL, and the build migrates over the direct one. For previews on their own database branch, see [Preview deployments](#6-preview-deployments-with-neon-branches).

   **Or Supabase.** It sets `POSTGRES_URL` (the pooler) and `POSTGRES_URL_NON_POOLING`, among others, which the API falls back to. Supabase's certificates are signed by its own CA, and node-postgres treats `sslmode=require` as `verify-full`. If connections fail with `self-signed certificate in certificate chain`, set `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the integration's two URLs with `&uselibpqcompat=true` appended. TLS stays on but the chain is not verified, as with libpq's `require`. Your own variables take precedence over the integration's.

2. **Upstash** (Redis). Create a Redis database and connect it.
   - The API needs the TCP URL, `rediss://default:<password>@<host>:6379`. It reads `REDIS_URL`, then `KV_URL`.
   - The integration sets the REST pair (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_*`) and usually a TCP URL in `KV_URL` or `REDIS_URL`. If it set only the REST pair, copy the TCP URL from the Upstash console into `REDIS_URL`. The REST API cannot carry pub/sub.

3. **Blob** (media). Create a Blob store and connect it. See [Media storage](#media-storage).

## 3. Environment variables

Set these under **Settings › Environment Variables**. "Integration" means a Marketplace integration sets it when connected.

| Variable | Required | Set by | Notes |
|---|---|---|---|
| `ENABLE_EXPERIMENTAL_COREPACK` | yes | you | `1`, so the build uses pnpm 11 ([step 1](#1-create-the-project)). |
| `JWT_SECRET` | yes | you | Signs tokens and seals staff two-factor secrets. Generate it with `openssl rand -base64 48`. Set it once: changing it signs everyone out, and staff who use two-factor can't sign in until an administrator resets their two-factor. |
| `CRON_SECRET` | yes | you | Vercel Cron sends it as a bearer token, and the worker route refuses requests without it. Generate it with `openssl rand -base64 48`. |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | yes | Neon | Or `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING` (Supabase, Neon). |
| `REDIS_URL` or `KV_URL` | no | Upstash | A `rediss://` URL. |
| `BLOB_READ_WRITE_TOKEN` | for media | Blob | Or the `S3_*` variables. |
| `ADMIN_URL` | no | | Default: `https://<production domain>/admin`, or the branch URL on previews. Used in password reset links and as the visual editing origin. Set it if staff use another domain. |
| `WORKER_CRON_SCHEDULE` | no | you | The cron schedule, read at build time. Default `0 5 * * *`. `off` leaves the cron out ([step 5](#5-background-work-and-cron-limits)). |
| `MIGRATE_ON_BUILD` | no | | Production builds migrate whenever a Postgres URL is set, preview builds only with `true`. `false` turns migration off everywhere. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME` | no | you | The first staff user, created by the build in a database with none ([step 4](#4-deploy-migrations-and-the-first-admin)). |
| `BOOTSTRAP_DEMO_DATA` | no | you | `true` makes the build load the demo data into a store with no channels ([step 4](#4-deploy-migrations-and-the-first-admin)). |
| `STOREFRONT_CORS_ORIGINS`, `ADMIN_CORS_ORIGINS` | no | | Browser origins allowed to call the APIs. Storefront default: any. The admin needs none, since the API serves it from its own origin. |
| `DEFAULT_CHANNEL` | no | | The channel used when a request names none. |
| `GRAPHQL_RESPONSE_CACHE` | no | | `auto` (Redis when set, otherwise off on Vercel), `memory`, `redis` or `off`. |
| `DATABASE_POOL_SIZE` | no | | Connections per instance. Default 5 on Vercel. |
| `MEDIA_STORAGE`, `MEDIA_PATH_PREFIX`, `MEDIA_MAX_BYTES`, `S3_*` | no | | See [Media storage](#media-storage). |
| `LOG_LEVEL`, `GRAPHQL_INTROSPECTION`, `PERSISTED_OPERATIONS_FILE` | no | | See [Configuration](../README.md#configuration). A relative `PERSISTED_OPERATIONS_FILE` is copied into the function at build time. |

Vercel itself sets `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` and `VERCEL_DEPLOYMENT_ID`. Leave `NODE_ENV`, `PORT` and `ALLOW_PRIVATE_WEBHOOK_URLS` unset.

## 4. Deploy: migrations and the first admin

Deploy by pushing to the production branch, or with **Redeploy**. The build log shows each step.

- **Migrations.** Production builds apply pending migrations over `DATABASE_URL_UNPOOLED` (or `POSTGRES_URL_NON_POOLING`, else the pooled URL) before the new code goes live. A failed migration fails the build. Builds against the same database take turns under an advisory lock. To migrate by hand, set `MIGRATE_ON_BUILD=false` and run from a checkout:

  ```sh
  DATABASE_URL="<the unpooled URL>" pnpm db:migrate
  ```

- **The first admin.** Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (12 characters or more) for the Production environment, then deploy. While the database has no staff, the build creates that user with an Administrator role holding every permission. Then delete `BOOTSTRAP_ADMIN_PASSWORD`, sign in and change the password.

- **The demo data,** for a demo or staging store. Also set `BOOTSTRAP_DEMO_DATA=true`. In a store with no channels, the build adds channels `us` and `eu`, a catalog, taxes, shipping, payments, page builder content, a demo customer, and orders from the last 90 days for the dashboard and reports. The orders go through the real checkout, so that build takes a little longer.
  - It adds no staff user: sign in as the first admin. The demo customer's password is random.
  - A store that has channels is left alone, so the variable can stay set.
  - The page editor previews in the Sample storefront, at `SAMPLE_STOREFRONT_URL` (default `http://localhost:3000`). Change its URL under **Settings › Storefronts** once your storefront is deployed ([step 8](#8-connect-a-storefront)).

  Or seed from a checkout. That also creates the admin you name, and adds no orders:

  ```sh
  DATABASE_URL="<the unpooled URL>" SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a-long-password' SAMPLE_STOREFRONT_URL=https://shop.example.com pnpm db:seed
  ```

  The seed refuses to run with `NODE_ENV=production`, and skips a database that already has channels.

- **Then.** Open `https://<your domain>/admin/` and sign in. Without the demo data, first create a channel under **Settings › Channels**: the storefront API resolves every request to a channel. `GET /health` reports `{ "status": "ok", "database": "postgres" }`.

## 5. Background work and cron limits

The build adds one cron job: `/internal/worker`, once a day at 05:00 UTC unless `WORKER_CRON_SCHEDULE` says otherwise. The daily default works on every plan. Cron jobs run only for production deployments.

| Plan | Cron | Background work |
|---|---|---|
| Pro, Enterprise | Set `WORKER_CRON_SCHEDULE` to `* * * * *` to run it every minute, invoked within the minute. | Scheduled content publishes within a minute. Webhooks go out right after changes, and failed ones are retried on schedule. |
| Hobby | **Once a day** (the default). A more frequent schedule fails the deployment ("Hobby accounts are limited to daily cron jobs"). Vercel may invoke it any time within the scheduled hour. | Webhooks still go out right after changes. Scheduled content publishes on the first request after its time. Retries of failed webhooks wait for traffic or the daily run. |

Run a tick by hand, or from another scheduler:

```sh
curl -H "Authorization: Bearer $CRON_SECRET" https://<your domain>/internal/worker
```

It answers with what it did:

```json
{ "ok": true, "published": { "pages": 0, "releases": 0 }, "events": 3, "webhooks": { "delivered": 2, "failed": 0 }, "durationMs": 412 }
```

## 6. Preview deployments with Neon branches

By default, preview deployments use production's variables, and so its database. Their builds therefore do not migrate: a pull request's migrations must not reach the production database before it merges. To give previews their own database:

1. In the Neon integration's settings, turn on preview branching. Each preview deployment then gets a branch of the production database with its own `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
2. Set `MIGRATE_ON_BUILD=true` for the **Preview** environment only, so each preview migrates its own branch.
3. For staff with two-factor to sign in to previews, use the production `JWT_SECRET` there too. A branch copies production's staff, whose two-factor secrets are sealed with it.

On previews, traffic and changes drive the worker, since cron jobs do not run. [Deployment Protection](https://vercel.com/docs/deployment-protection) puts previews behind Vercel Authentication by default, so a storefront or webhook receiver calling a preview's API needs a bypass, such as Protection Bypass for Automation.

## 7. Custom domains

Add the domain under **Settings › Domains**, then redeploy.

- `VERCEL_PROJECT_PRODUCTION_URL` becomes the shortest production custom domain, and the default `ADMIN_URL` follows it after a redeploy.
- If staff open the admin on any other domain, set `ADMIN_URL`. The visual editing bridge talks only to that origin, and storefronts let only it frame them.
- Update the storefront's `SPINDLE_API_URL`, and `SPINDLE_ADMIN_ORIGIN` if you set it, to the new domain.

## 8. Connect a storefront

The sample Next.js storefront is [its own repository](https://github.com/chachakawooka/Ecom-storefront) and its own Vercel project. Its README has the details, and a Deploy button that does steps 1 and 2.

1. Import it as a new Vercel project, with `ENABLE_EXPERIMENTAL_COREPACK=1`.
2. Set its variables:
   - `SPINDLE_API_URL`: this project's URL, such as `https://shop-api.example.com`.
   - `SPINDLE_CHANNEL`: `eu` for the demo data's Europe store, which the storefront offers in English, German and French, in pounds or euros. To offer other languages or currencies of the channel, set `SPINDLE_LOCALES` and `SPINDLE_CURRENCIES` (for `us`: `en-US` and `USD`).
   - `SPINDLE_ADMIN_ORIGIN`: only if staff open the admin somewhere other than `SPINDLE_API_URL`. By default the storefront lets that URL's origin frame it, since it serves the admin.
   - `SPINDLE_MEDIA_HOSTS`: only for S3 or a CDN. Vercel Blob hosts are built in.
3. Deploy it, then register it in the admin under **Settings › Storefronts**: its production URL, the preview route `/api/draft` and the revalidate route `/api/revalidate`. With the demo data, edit the Sample storefront instead of adding one. Copy the signing secret the admin shows once into the storefront's `SPINDLE_REVALIDATE_SECRET`, and redeploy the storefront.
4. For a statically built site, create a Deploy Hook in the storefront's project (**Settings › Git › Deploy Hooks**) and paste its URL into the storefront's settings in the admin. **Deploy** in the admin then rebuilds it.

The revalidation webhook and the deploy hook use public HTTPS URLs, so the check that refuses private-network webhook targets doesn't block them.

## Media storage

Functions on Vercel have no persistent disk, so on Vercel local media storage refuses uploads with an `InvalidStateError` that says so.

- **Vercel Blob (recommended).** Connect a Blob store under **Storage › Blob**. It sets `BLOB_READ_WRITE_TOKEN`, and the platform picks Vercel Blob by itself.
- **S3, R2 or Supabase Storage.** Set `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_PUBLIC_URL`, plus `S3_REGION` or `S3_FORCE_PATH_STYLE` where needed. The bucket needs a CORS rule that allows `PUT` with a `Content-Type` header from the admin's origin.

The admin's CSP (`connect-src`) allows the storage's upload origin. [docs/media.md](media.md) covers every variable, the providers and the upload flow.

## Plugins

`pnpm vercel:build` bundles the plugins listed in `ecom.config.ts` into the function, applies their SQL migrations after the platform's own, and copies the directories they reference. Enable and configure them in the admin under **Settings › Plugins**. See [docs/plugins.md](plugins.md).

- **Keys.** On Vercel, put a plugin's secrets in environment variables rather than the admin. They then stay out of the database, and the admin shows them as set by the environment.
  - **Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET`.
  - **Shippo:** `SHIPPO_API_TOKEN`.
  - **Email:** `RESEND_API_KEY`, which the Resend Marketplace integration sets, or `POSTMARK_SERVER_TOKEN`. Then choose the transport and sender in the admin.
- **Stripe webhooks.** In the Stripe dashboard, add an endpoint for `https://<your domain>/payments/webhooks/stripe` with the events in [plugins/stripe/README.md](../plugins/stripe/README.md). Webhooks complete orders whose customer paid but never came back, and record refunds and disputes made in Stripe.
- **Preview deployments.** Deployment Protection must let the PSP through too ([step 6](#6-preview-deployments-with-neon-branches)).
- **Tasks and events.** Plugin event handlers and scheduled tasks run with the worker: after each change, on traffic, and on the cron. On Hobby, a plugin task runs no more often than that allows.
- **Routes.** A plugin's own HTTP routes, at `/plugins/<name>/…`, reach the function through its catch-all route.

## 9. Limits

- **Request and response bodies: 4.5 MB.** Larger ones fail with `413 FUNCTION_PAYLOAD_TOO_LARGE`. Media uploads go straight to storage, but `POST /admin/media` sends the file through the API, so it is limited to 4.5 MB here.
- **Subscriptions (SSE).** Each open stream keeps a function invocation running, up to `maxDuration` (300 seconds, Hobby's maximum). Then Vercel ends it, and `EventSource` reconnects by itself.
- **Cold starts.** An instance's first request loads the bundle (about 5 MB), creates the app and opens a database connection. A suspended Neon compute adds its own wake-up. Fluid compute reuses warm instances, and production deployments get bytecode caching.
- **Duration.** A worker run starts no new batch after 240 seconds (the worker route) or 120 seconds (background runs), within the 300-second limit.
- **Native code.** `@node-rs/argon2` ships platform binaries, and Vercel's build (Linux x64) installs the right one. `pnpm vercel:build` on macOS warns that its output only runs locally: `vercel deploy --prebuilt` from a Mac would fail at sign-in.
- **`vercel dev`** cannot run Build Output API output. Use `pnpm dev` locally.

## Checking a build locally

```sh
pnpm vercel:build    # without a database URL it skips migrations
pnpm vercel:smoke    # runs the built function on a local port, empty and with demo data
```

The smoke test runs `functions/index.func/index.mjs` as Vercel's Node.js launcher does, in an HTTP server calling its default export. It checks:

- `/health`, the storefront and admin APIs, and staff sign-in (argon2 and a `Secure` cookie);
- a media upload target on Vercel Blob (the bundled SDK signs a client token, and nothing is uploaded);
- the admin page, its client-side routes and its CSP;
- the visual editing bridge, and the worker route with and without the secret.

Node finds PGlite, which is not bundled, in the project's `node_modules`, because `.vercel` sits inside the project.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build: `Hobby accounts are limited to daily cron jobs` | `WORKER_CRON_SCHEDULE` runs more often than daily. On Hobby, use a daily schedule or `off`. |
| Build: `ERR_PNPM_…` or a lockfile error | Add `ENABLE_EXPERIMENTAL_COREPACK=1`. |
| `The API failed to start`; logs: `JWT_SECRET must be set in production` | Set `JWT_SECRET`. |
| Logs: `DATABASE_URL (or POSTGRES_URL) must be a PostgreSQL URL on Vercel` | Connect Neon or Supabase, or set `DATABASE_URL`. |
| Logs: `self-signed certificate in certificate chain` | Supabase: see [step 2](#2-add-postgres-redis-and-blob-from-the-marketplace). |
| Logs: `SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'` | Informational, from node-postgres: `sslmode=require` URLs are verified in full. Neon's certificates pass. |
| Worker route answers 403 | Set `CRON_SECRET` and redeploy. |
| Webhooks or scheduled pages are late | Check the cron under **Settings › Cron Jobs**, and on Hobby read [step 5](#5-background-work-and-cron-limits). |
| Media uploads fail with `InvalidStateError` | Connect a Blob store, or configure S3 ([Media storage](#media-storage)). |
