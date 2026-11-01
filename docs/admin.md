# Admin

The admin is the back office for running the store: orders, catalog, customers, promotions, content, reports, settings and staff. This single-page app in [`admin/`](../admin), served at `/admin/`, talks only to the [admin GraphQL API](graphql.md), a few sign-in endpoints, and media storage, which browsers upload to directly ([media.md](media.md)).

## Running it

| Where | URL | How |
|---|---|---|
| Development | http://localhost:4000/admin/ | `pnpm dev`. Vite runs inside the API process, so the admin hot-reloads on the API's own port. |
| Docker | http://localhost:4000/admin/ | `docker compose up`, as in development. |
| Production | `https://<api-host>/admin/` | `pnpm admin:build`, then `pnpm start`. The API serves `admin/dist` with a strict CSP. |
| Standalone Vite | http://localhost:5173/admin/ | `pnpm admin:vite`, proxying to `ADMIN_API_URL` (default `http://localhost:4000`). |

Sign in with the seeded staff account (`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `.env`).

For a dashboard and reports with some history, run `pnpm db:seed:orders`. It places 80 demo orders through the real checkout, captures, ships, refunds or cancels them as staff would, then backdates them over the last 90 days. With PGlite, stop the server first, since only one process can open the database.

## How it works

- **The app.** A React single-page app with typed routes and data. gql.tada type-checks every query and mutation against `schema/admin.graphql`.
- **Lists.** One grid for every list: cursor paging, per-user saved views and columns stored on the server, bulk actions, and CSV export of the page or of everything matching.
- **Command palette.** ⌘K searches products, orders and customers in one GraphQL request, finds pages, jumps to any screen and runs actions.
- **Dashboard and reports.** Live SQL aggregates per currency, bucketed in the viewer's time zone, compared with the previous period.
- **Orders.** One order page: capture, ship with tracking, refund (lines, shipping, restock), cancel, address correction, notes and a live timeline. Documents print from HTML, which also saves as PDF.
- **Media.** Browsers upload straight to local disk, S3-compatible storage or Vercel Blob, with progress and cancel. Files have alt text per language, and are found by name or alt text.
- **Rich text.** One Tiptap editor (`components/rich-text.tsx`) for product and category descriptions (HTML) and the page builder's rich text fields (Markdown). Markdown works while typing (`## `, `- `, `1. `, `> `), and pasted Markdown is formatted. A source view edits the HTML or Markdown directly, and text with markup the editor can't show, such as tables or inline styles, opens there.
- **Creating orders.** A staff order is a stateless draft, priced on each edit by the storefront's checkout pipeline (`orderDraftQuote` stages a cart and rolls it back) and placed by the same checkout (`orderCreate`).
- **Permissions.** 10 permission areas, each with read or write. Write implies read, and `*` grants everything.
- **Caches and the search index** need no flushing or reindexing by hand: caches invalidate per entity on write, and the search projection updates in the same transaction. A "rebuild search index" button exists for maintenance.
- **Bulk changes** run in one transaction (`productBulkUpdate`) or as a client-side batch with per-item results.
- **CSV import** of stock levels, tax rates and redirects runs the same mutations a user would.

Not included:
- Storefront design (themes, design configuration, sitemaps). Storefronts are separate apps, and the page builder designs their pages.
- Newsletters, reviews and ratings.
- Built-in payment and carrier integrations, which plugins provide ([Plugins](#plugins)).
- Email template editing. Emails are left to whatever subscribes to the platform's events, such as the email plugin ([email.md](email.md)).
- Checkout terms and conditions.
- A configuration tree with values per store. Settings live on channels, payment and shipping methods, and rules.

## Screens

| Section | Screens |
|---|---|
| Dashboard | Revenue, orders, average order value and new customers, compared with the previous period. Daily revenue chart, work waiting (orders to ship, awaiting payment, low stock, failed webhooks), top products, recent orders and a live order feed. |
| Sales | Orders grid. Order detail. Create order. Printable invoice and packing slip. Abandoned carts. |
| Catalog | Products grid with bulk status, category, channel, attribute and delete actions. Product editor: translations, typed attributes, variants and variant generation, prices per channel, currency, group, tier and date, stock per location, media from uploads or the media library, categories, channels and duplication. Category tree, with a merchandising board per category. Inventory grid with CSV import. Attributes. Product types. |
| Customers | Customers grid. Customer detail: profile, addresses, orders, password reset, sign out everywhere, delete. Customer groups. |
| Marketing | Promotions with a visual condition and action builder, coupons, generation and export. Redirects. |
| Content | Pages built from components in a full-window visual editor: structure tree with drag and drop, the real storefront framed with click-to-edit outlines and live text updates, inspector per component, device and locale previews, autosave with undo, history and restore, publish, schedule and releases. Product and category page templates, edited the same way, previewed on any product or category, and assigned to products, categories or as the default (also from the product and category screens). The component library with a field builder, import/export and deploy-from-code. Simple pages and reusable blocks have no screens of their own: a simple page is a builder page with a rich text section, and reusable content is a component or a singleton such as the header and footer. The media library: images and videos, where each is used, and bulk delete. |
| Reports | Sales over time, best sellers, customers, promotion usage and low stock, each with CSV export. |
| Settings | Channels, taxes (classes, rates with CSV import and export, rules), shipping zones and rate tables, payment methods, currencies and exchange rates, stock locations and stocks, storefronts (preview routes, revalidation webhooks, deploy hooks), and [plugins](#plugins). |
| System | Staff (create, roles, lock and unlock, set password, reset two-factor), roles with a permission matrix (the platform's areas, then each plugin's permissions), API keys, webhooks with a delivery log and retry, audit log, maintenance. |
| Plugins | Pages that plugins' admin modules add, in the sidebar group each names (or Plugins) and in ⌘K, and their widgets on the order, product and customer screens and the dashboard. See [Plugins](#plugins). |
| Account | Profile, password change, two-factor setup with QR code and recovery codes. |

## Working in the admin

- **Lists:**
  - Filters, sort, page and saved views live in the URL, so detail pages' back links, Back and reloads return to the list as you left it.
  - Products sort by name or lowest price, pages by path or last edit.
  - A failed load shows the error with Try again, never an empty list.
  - Table headers stay on screen, and the selection bar sticks to the bottom of the window.
- **Keyboard:**
  - In lists:
    - `/` searches.
    - `j`/`k` or the arrow keys move between rows. Enter opens a row, ⌘Enter opens it in a new tab.
    - `x` selects a row, Shift-click or Shift+`x` selects a range, and Esc clears.
    - `?` lists the shortcuts.
  - On an order, `j`/`k` (or `[`/`]`) step through the list it was opened from.
  - In the media library and the media picker, the arrow keys move between files. Enter opens a file in the library and picks it in the picker. `x` selects in the library, Space in the picker.
  - ⌘S saves in editors.
  - In inventory, Enter saves a count and moves down, and Tab moves across.
- **Safeguards:**
  - The product, component, promotion, customer, new-order and category editors, the merchandising board, plugin settings and the media file panel ask before you leave with unsaved changes. Dialogs and side panels ask before discarding edits.
  - Deleting a media file that products or pages use says where it is used, and needs Delete anyway.
  - Problems are marked on their field, or on the promotion rule, and the page scrolls to the first one.
  - A new order keeps its draft through a reload.
- **Bulk work:**
  - Order actions show how many orders they apply to, show progress with Stop, and list failures, which stay selected.
  - Packing slips and invoices print for many orders at once.
  - One grid edits every variant's prices and stock.
  - Inventory counts update at once, with Undo.
- **Merchandising:**
  - **Merchandise** on a category's screen opens its board: the products its page shows, as cards with price, stock and status, in three zones. Pinned products come first, in the order you drag them into. The rest, new products included, follow newest first. Hidden products stay in the category but are left off its page in every sort.
  - Drag a card between zones, or within Pinned to reorder. Each card's buttons (pin, move earlier or later, hide, show) do the same without a mouse.
  - Drafts can be pinned before they go live. Nothing changes on the storefront until you save. Categories never merchandised keep their newest-first order.
- **Media:**
  - On the Media screen, drop or paste files anywhere, or use Upload. Three files upload at a time.
  - Product media, page builder image fields and the rich text image tool offer Upload and the media library. A library image brings its alt text to a field that has none.

## Plugins

Plugins ([plugins.md](plugins.md)) are code listed in `ecom.config.ts`. The admin turns them on and off, configures them and shows what their admin modules add.

- **Settings › Plugins** (`settings:read` to see, `settings:write` to change) lists the installed plugins with their version, state and what they add (payment or shipping providers, event handlers, GraphQL fields, routes, tasks, tables, admin pages). A plugin is **Active** when it is enabled and every required setting has a value. **Needs setup** names the missing settings.
- **A plugin's screen:**
  - The **Enabled** switch applies at once.
  - **Settings**: a form generated from the plugin's typed settings (text, numbers, switches, choices), or the plugin's own panel if its admin module has one. Defaults show as placeholders. Secrets are write-only, shown as Set or Not set, with Replace and Clear. A setting from an environment variable is read-only and badged with the variable's name. Problems show on their fields, and Save, Discard, ⌘S and the "Leave without saving?" guard work as in other editors.
  - **Test connection**, for plugins with a check, runs it with the saved settings.
  - **Scheduled tasks**, with their last run and result, and **Run now**.
  - **Failed event deliveries** (failed ones are retried with backoff, dead ones gave up), with the error and **Retry**.
  - The permissions it adds, links to its admin pages, and where its widgets show.
- **Pages, navigation and widgets** from plugins' admin modules show while the plugin is active, to staff with their permission. Any staff user may read `activePlugins`, the list of active plugins. A page's address is `/admin/plugins/<plugin>/<path>`. An inactive plugin or a missing page shows a notice instead. A widget or page that fails shows its error in its place, and the rest of the screen keeps working.
- **Roles and API keys** list the plugins' permissions under the platform's areas, grouped by plugin, one checkbox each. A held permission that no installed plugin still offers is listed under "No longer installed", so it can be removed: the API refuses it on save.

**How admin modules get into the admin.** A plugin's `admin` URL names a module made with `defineAdminPlugin` ([plugins.md](plugins.md#writing-admin-modules) explains how to write one). When Vite starts, `admin/vite.config.ts` imports `ecom.config.ts` and serves `virtual:ecom/admin-plugins`: `{ name, title, load }` for each listed plugin with an admin module. The same list lets Vite serve files outside `admin/`, and adds an `@source` line per module directory to `app.css` so Tailwind generates their classes. Each module is a chunk of its own, loaded once its plugin is active, or in any state by Settings › Plugins for its settings panel. This works the same in `pnpm dev`, `pnpm admin:vite`, `pnpm admin:build` and the Vercel build. After adding a plugin, restart `pnpm admin:vite` (`pnpm dev` restarts by itself). `pnpm typecheck` checks `plugins/**/admin.tsx`, `admin/` directories under plugins and the fixtures in `test/fixtures/plugins/` with the admin.

## Admin API added for the admin

The admin API grew from 34 queries and 62 mutations to 66 queries, 139 mutations and one subscription ([`schema/stats.json`](../schema/stats.json)). The screens above needed these additions:

- **Staff security:**
  - `staffLogin` returns a `twoFactorChallenge` for users with two-factor enabled, and `staffLoginVerify` completes it.
  - `staffTwoFactorSetup`, `staffTwoFactorEnable` and `staffTwoFactorDisable` manage enrollment.
  - `staffPasswordChange`, `staffPasswordResetRequest` and `staffPasswordReset` handle passwords.
  - `staffProfileUpdate` edits your own profile.
  - Administrators get `staffUserUnlock`, `staffUserSetPassword` and `staffUserResetTwoFactor`.
- **Preferences:** `staffPreferenceSet` and `viewer.preferences` store saved views and column choices on the server, so they follow the user across devices.
- **Audit:** `auditLog`, filtered by actor, operation, target, outcome and time, with a `search` that matches part of an operation name or of the actor's email or key name.
- **Reports:** `dashboard`, `salesReport`, `productSalesReport`, `customerSalesReport`, `customerSignupsReport`, `promotionUsageReport`, `lowStockReport` and `abandonedCartsReport`, gated by the new `reports` permission area.
- **Orders:**
  - `orderDraftQuote` and `orderCreate` for orders created by staff.
  - `orderUpdateAddresses` corrects addresses.
  - The `orderActivity` subscription streams every order event over SSE.
- **Catalog:**
  - `productBulkUpdate` changes status, categories, channel listings and attribute values for up to 500 products in one transaction. Attribute values are checked against each product's type, and localized text is merged per language. `productBulkDelete` and `productDuplicate` complete the set.
  - Product editing: `Product.taxClass` is the product's own override (null follows its type's class), `Media.alts` returns alt text in every locale, and `removeTranslations` deletes a locale's translation but never the last one.
  - `attributeDefinitionDelete` and `productTypeDelete`. `ProductType.productCount` shows what blocks a delete.
  - `categories` lists every category depth first, optionally filtered by name. A category's `position` is its index among its siblings, and every create, update and move renumbers that level.
  - Merchandising: `Category.merchandising` lists the category's products as its board shows them (pinned in order, hidden, then the rest newest first), and `categoryMerchandisingUpdate` replaces what is pinned and hidden. The storefront's `FEATURED` sort follows it, and category listings use it by default. Pins and hides belong to one category's listing, not its parent's or subcategories'.
  - `productVariants` searches by SKU, barcode or name.
  - `urlRedirects`, `urlRedirectCreate` and `urlRedirectDelete`.
- **Customers:**
  - `customerAddressCreate`, `customerAddressUpdate` and `customerAddressDelete` take a `customerId` in the admin API.
  - New: `customerDelete`, `customerPasswordResetSend`, `customerSessionsRevoke`, `customerGroupUpdate` and `customerGroupDelete`.
- **Page builder** ([visual-editing.md](visual-editing.md)):
  - Components: `components`, `componentCreate`, `componentUpdate`, `componentDelete`, and `componentsSync` to deploy definitions from code.
  - Pages: `pageCreate`, `pageSaveDraft` (with a base version against lost updates), `pagePublish`, `pageUnpublish`, `pageDiscardDraft`, `pageSchedule`, `pageDuplicate`, `pageDelete`, `pageSettingsUpdate`, `pageVersionSave` and `pageVersionRestore`.
  - Releases: `releaseCreate`, `releaseUpdate`, `releaseAddPages`, `releaseRemovePages`, `releasePublish`, `releaseDelete`, with `Release.problems` as a dry run.
  - Storefronts and previews: `frontendCreate`, `frontendUpdate`, `frontendDelete`, `frontendDeploy` and `previewSessionCreate` (for a template, on a product or category of your choice).
  - Product and category templates: `pageTemplateTargetsUpdate` assigns a template to products, categories or the default, `pageTemplateCustomize` gives one product or category its own copy, and `Product.templateMatch` / `Category.templateMatch` say which template applies and why.
  - Product and category sections: `pageSectionsCreate` gives one product or category components of its own, shown where its template places them. `Product.sections` / `Category.sections` return them.
- **Media library** ([media.md](media.md)):
  - `mediaAssets` (searched by name and alt text, filtered by kind), `mediaAsset` and `mediaStorage`.
  - `mediaUploadCreate` and `mediaAssetCreate` upload a file straight to storage and register it. `mediaAssetUpdate` renames it and sets its alt text, and `mediaAssetDelete` deletes it.
  - `MediaAsset.usage` lists the products and pages that use a file. A delete is refused while there are any, unless `force: true`.
- **Promotions:** `promotions(query:, isActive:)` searches by name or exact coupon code, and `couponsDelete` removes codes.
- **Settings:**
  - Tax: update and delete for classes and rules, delete for rates.
  - Shipping: zone update and delete, method delete. A method can move to another zone and take its own tax class.
  - Payments: methods can be limited to channels, and `captureMode: null` returns a method to its provider's default.
  - Inventory: `stockLocationUpdate` and `stockUpdate`, plus `stockLevelsImport`, which sets up to 5000 counts by SKU and location code in one transaction and reports the rows it skipped.
  - Currencies: `exchangeRates` and `exchangeRateDelete`.
  - Webhooks: `webhookDeliveries` across subscriptions.
  - Staff: `roleDelete`.

In update inputs, an omitted field is left unchanged and an explicit `null` clears it, wherever clearing makes sense: a promotion's schedule and limits, a customer's phone, birth date and note, a tax rate's region and postal pattern, a product's or shipping method's tax class override.

Deletes that would break references, such as a tax class still assigned to product types, a zone that has methods or a role assigned to someone, are refused with an `InvalidStateError` that says what still uses the object.

## Security model

- **Sign-in.** The browser uses `POST /admin/auth/login`, `/verify`, `/refresh` and `/logout`.
  - The refresh token rotates, and lives in an httpOnly, SameSite=Strict cookie scoped to `/admin/auth`.
  - The app holds only the 15-minute access token, in memory, and refreshes it silently.
  - Every route requires a JSON body or an `X-Requested-With` header, so cross-site forms cannot use the cookie.
  - API clients keep using the `staffLogin` mutation and bearer tokens or API keys.
- **Lockout.** After `STAFF_LOCKOUT_FAILURES` consecutive failures (default 5), including two-factor failures, the account locks for `STAFF_LOCKOUT_MINUTES` (default 15). A wrong password, an unknown account and a locked one get the same message, so responses never reveal which accounts exist.
- **Two-factor.** TOTP (RFC 6238), with one time step of drift and no code replay within its window, plus 10 single-use recovery codes stored as hashes. Seeds are encrypted with AES-256-GCM using a key derived from `JWT_SECRET`, so setup is refused while `JWT_SECRET` is unset.
- **Password reset.** Requests emit `staff.password_reset_requested` with the reset link. Only plugins receive it, never webhooks, so `integrations:write` cannot take over staff accounts. The email plugin sends the link, and outside production it is also logged. Resetting signs the user out everywhere.
- **Customer password resets** emit `customer.password_reset_requested`, which is plugin-only too: webhooks never receive it, not even subscriptions to `*`. Deliveries queued before it became plugin-only are never sent, and the delivery log shows them with the token redacted, so `integrations:read` cannot expose it.
- **Staff management stays within your own permissions.** `staff:write` grants only permissions you hold, in a role you create or edit or through the roles you assign. It edits only roles, and changes only staff (roles, status, lockout, password, two-factor), whose permissions you hold too. So it cannot gain `*` or take over an administrator: only administrators manage administrators.
- **Audit.** Every admin mutation and sign-in is recorded with actor, operation, target, outcome, IP and input. The IP is the connection's address, or behind `TRUST_PROXY` proxies, the one they report in `X-Forwarded-For`. Mutations are recorded after they run, with passwords, tokens, secrets and one-time codes redacted. Failed sign-ins are recorded against the email that was tried.
- **Media uploads** go from the browser straight to storage, which for local disk is the API's own upload link ([media.md](media.md)):
  - `mediaUploadCreate` checks the declared type and size and returns a target valid for 15 minutes, limited to one key, type and size: an upload link on the API signed with `JWT_SECRET` (local disk), a presigned PUT (S3) or a client token (Vercel Blob).
  - `mediaAssetCreate` then reads what storage holds and takes the type from the file's bytes. JPEG, PNG, GIF, WebP, AVIF and MP4 are accepted, SVG never is. A file that is not what it claimed is deleted.
  - Uploading, editing and deleting need `content:write` or `catalog:write`, and reading the library `content:read` or `catalog:read`.
  - Keys are random and never reused, so files are served with immutable caching. The API serves local files with `nosniff`.
  - `POST /admin/media` still takes multipart uploads from API clients. These pass through the API, which Vercel limits to 4.5 MB.
- **The built app** is served with `script-src 'self'`, `connect-src 'self'` plus the media storage's upload origin (Vercel Blob's API or the S3 bucket), and `frame-ancestors 'none'`.

## Code map

```
admin/
  index.html, vite.config.ts, tsconfig.json
  src/
    main.tsx             providers: React Query, auth, router, toasts
    router.tsx           every route, code-split; list filters live in the URL
    graphql/             gql.tada setup; graphql-env.d.ts is generated from schema/admin.graphql
    lib/                 api client (session refresh, typed results), auth, hooks, live (SSE), format, theme,
                         media uploads (media-upload.ts)
    plugin-sdk.ts        the API plugin admin modules import as `@ecom/admin` (plugins.md, Writing admin modules)
    components/
      plugin-runtime.tsx the bundled plugin modules, active plugins, page matching, PluginLink, error boundary
      plugin-page.tsx    /plugins/<plugin>/<path>; plugin-widgets.tsx, the widget slots
      settings-form.tsx  forms generated from typed setting descriptors (plugins, shipping provider options)
      ui/                buttons, inputs, menus, dialogs, tables, comboboxes (Radix + Tailwind)
      layout/            app shell, navigation, command palette, page header
      data-table.tsx     the admin grid
      media.tsx          the media grid's pieces; media-picker.tsx, the dialog fields choose files with
      form.tsx, inputs.tsx, status.tsx
    routes/              one folder per section
src/http/
  admin-auth.ts          browser sign-in endpoints and the session cookie
  admin-app.ts           serves admin/dist with client-side routing and CSP
  admin-dev.ts           Vite middleware for `pnpm dev`
  media.ts               local-disk uploads, the multipart endpoint, and serving local files
```

After changing the API, run `pnpm schema:print`. It prints the SDL and regenerates `admin/src/graphql/graphql-env.d.ts`, and `pnpm typecheck` then checks every admin query against the new schema.
