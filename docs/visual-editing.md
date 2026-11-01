# Page builder and visual editing

Merchandisers build pages from components and edit them visually: the admin frames the real storefront, outlines what is editable, and updates the preview as they type. Developers own the components, each a definition the platform validates content against and a frontend component that renders it.

## Concepts

| Concept | What it is | Where |
|---|---|---|
| **Component** | A definition: code, name, fields, optional variations. Kind `component` nests inside `blocks` fields. | `builder_components`, admin › Content › Components |
| **Content type** | A component of kind `content_type`: the root of a page. Routable types have paths (landing pages). Singletons have one page (site header, footer). | same |
| **Page** | A document: a tree of component instances (nodes), plus title, path and SEO. It has a working draft and a published version, both whole documents. | `builder_pages`, admin › Content › Pages |
| **Template** | A page of a content type that is a template for products or categories. It has no path: product and category pages render with it, and its product and category components show that page's data. | `builder_template_targets`; see [templates](#product-and-category-templates) |
| **Sections** | One product's or category's own components: a page of a content type with `sectionsFor`, belonging to that product or category. Its template shows them where it places a sections component. | `builder_pages.product_id`, `category_id`; see [sections](#product-and-category-sections) |
| **Version** | A snapshot: every publish and restore, named saves, and an autosave checkpoint at most every 10 minutes (the newest 100 autosaves are kept). | `builder_page_versions` |
| **Release** | Pages to publish together, now or at a scheduled time. All publish or none do. | `builder_releases`, admin › Content › Releases |
| **Storefront** | A frontend app the builder previews in and deploys to: preview route, revalidation webhook, optional deploy hook. | `builder_frontends`, admin › Settings › Storefronts |

### Field types

| Type | Stored value | Delivered value |
|---|---|---|
| `text` | string, or `{ locale: string }` when `localized` | string in the request locale |
| `richText` | Markdown, optionally localized | Markdown string |
| `number`, `boolean`, `select`, `color`, `date` | the value | the value (`select` is an option value; `boolean` defaults to false) |
| `image` | `{ url, alt?, width?, height? }`, alt optionally per locale | `{ url, alt, width, height }` |
| `link` | `{ kind: "url", url }` or `{ kind: "page" \| "product" \| "category", id }`, plus `newTab` | `{ kind, href, id, newTab }`, with `href` resolved for the request locale |
| `product`, `category` | global id | global id; the objects are in `Page.references` |
| `products` | ordered global ids | the same; objects in `references.products` |
| `blocks` | child nodes, limited by `allowedComponents`, `min`, `max` | visible child nodes |
| `list` | items `{ id, fields }` with the field's `fields` (no blocks or lists inside) | items with delivered fields |

A node is `{ id, component, variation?, hidden?, visibility?, fields }`. `visibility` targets channels, locales and a time window, so one page can carry a campaign banner that appears on Friday in the EU only. Ids are stable for the life of the node, and key list rendering and visual editing.

Text is translated field by field: the structure is shared, and each localized field holds a value per locale. The storefront API falls back to the channel's default locale.

### Validation

Every draft save checks structure: known components and variations, components allowed where they sit, value shapes, unique ids, at most 1,000 nodes and 12 levels. Publishing also checks required fields, counts and the path. Errors carry paths that point at the node, such as `["node", "<nodeId>", "title"]`, so the editor can select it. Values of fields a definition no longer has are kept, so removing and re-adding a field loses nothing.

## Lifecycle

```
pageCreate ──▶ draft ──pageSaveDraft (baseVersion)──▶ draft … ──pagePublish──▶ published
                  ▲                                                   │
                  └──── pageDiscardDraft / pageVersionRestore ◀───────┘
pageSchedule(at) ─▶ worker publishes at `at`        releasePublish ─▶ every page at once
```

- **Concurrency.** Each save sends the version it loaded. If someone else has saved since, the save fails with `ConflictError` instead of overwriting.
- **Status.** `DRAFT` (never published), `PUBLISHED`, `CHANGED` (published, with newer draft changes), `SCHEDULED`.
- **Paths.** A page's path can change in its draft, and publishing the move records a 301 redirect from the old path. `/products/…`, `/categories/…`, `/api/…`, `/_next/…` and `/admin/…` are reserved for storefront routes.
- **Scheduling.** The worker publishes due pages and releases on every tick. A page that fails validation at its scheduled time keeps its draft, and the reason appears on the page (`scheduleError`). A release is marked `FAILED`.
- **Events.** `page.published`, `page.unpublished`, `page.targets_updated`, `release.published` and `component.updated` go through the outbox, so webhooks receive them after the change commits, and published pages are evicted from the storefront API's response cache.

## Storefront API

```graphql
query Home {
  route(path: "/") { __typename ... on Page { id title seo { title description image { url } } content references { products { id name slug } categories { id name } pages { id path title } } } }
  header: singletonPage(type: "site_header") { id content }
}
```

- `route(path)` resolves any storefront URL. A page at exactly that path wins over a product or category with the same last slug, and redirects come last.
- `page(path)`, `singletonPage(type)` and `pages(type, first, after)` read pages directly.
- `Page.content` is the delivered tree, without hidden nodes and nodes targeted at other channels, locales or times.
- With an `x-preview-token` header, these return drafts (`isPreview: true`) and are never cached. `previewSession` describes the token: when it expires, the admin's origin and the preview time.

## Product and category templates

Product and category pages are designed in the same editor. A content type with `templateFor: "product"` or `"category"` makes its pages [templates](#concepts). Their product and category components also carry `templateFor`, and validation keeps them out of other pages. The demo library has these:

| Template | Components with data | Seeded templates |
|---|---|---|
| `product_page` | `product_details` (gallery, price, options, add to cart), `product_description`, `product_specs`, `related_products`, `product_sections` (the product's [own sections](#product-and-category-sections)) | "Product page", the default |
| `category_page` | `category_header`, `subcategories`, `category_products` (the Featured order merchandised in the admin, other sorts, and pages), `category_sections` | "Category page", the default; "Women's landing" for Women |

Every general component (hero, FAQ, product grid, …) fits templates too, so a template can put a promo banner above a product's details or an FAQ below a category's products.

**Which template renders a page.** The most specific one wins:

- **Product:** the template assigned to the product, then one assigned to its nearest category, then the default. Nearest means the product's categories and their parents, deepest first, as category listings include subcategories.
- **Category:** the template assigned to the category, then the default.

Only published templates count for visitors. A template restricted to some channels is skipped in the others. With no template at all, `template` is null and the storefront uses its built-in layout.

**Assigning.** Visitors get one published template for each product, category and default:

- `pageTemplateTargetsUpdate(id, { isDefault, productIds, categoryIds })` assigns a template. A published template takes what it is assigned from the template that had it at once. A draft template takes it over when it is published. Until then, visitors keep the current design, while the admin and previews already show the draft.
- `pageTemplateCustomize(productId | categoryId)` gives one product or category a draft copy of the template it uses now, assigned to it. The live page keeps its current template until the copy is published.
- In the admin, these actions are in the template's page settings, and on the product and category screens ("Page design").

`Product.templateMatch` and `Category.templateMatch` (admin) say which template applies and why: `PRODUCT`, `CATEGORY` (naming the category) or `DEFAULT`. Pass `live: true` to see only what visitors see.

**Storefront.** `Product.template` and `Category.template` return the page to render. Its `content` is delivered like any page's, and the frontend passes the product or category to the data components:

```graphql
query Product($path: String!) {
  route(path: $path) { ... on Product { id name slug template { id content references { products { id name slug } } } } }
}
```

**Preview.** `previewSessionCreate(pageId: <template>)` opens on a product or category the template is assigned to, or on the `productId` or `categoryId` you pass, and its `path` names that page. The session's token renders every product (or category) page with the template being edited, so the editor can browse to other products and check the design on each.

**Caching.** Publishing, unpublishing or assigning a template can change any product or category page. Those events (`page.published`, `page.unpublished`, `page.targets_updated`) carry `templateFor`. The API then evicts every cached response holding a product (or category), and the sample storefront expires its `ecom:templates:<kind>` tag.

## Product and category sections

Sections give one product or category components of its own inside its template's layout: a story and a video on one product, reviews and an FAQ on another, a buying guide on a category. Sections are a page like any other, with the same editor, drafts, scheduling, releases and history.

- **The content type.** A content type with `sectionsFor: "product"` or `"category"` holds them. Each of its pages belongs to one product or category (`builder_pages.product_id` or `category_id`), one page each, deleted with its product or category. It has no path, is not a singleton, and stays out of the `pages` list.
- **What goes in.** Its blocks fields take what their `allowedComponents` allow. Components with `templateFor` fit too, with the product or category as their data. The demo's `product_sections_page` takes the general sections plus `product_description`, `product_specs` and `related_products`, and `category_sections_page` takes the general sections plus `subcategories`. The main blocks stay in the template.
- **Where they show.** A template places a component that shows them: in the demo, `product_sections` and `category_sections` (no fields, `templateFor` set). The storefront renders the product's or category's sections there, and nothing for products without any. A template that places none shows none.
- **Adding them.** `pageSectionsCreate(productId | categoryId)` returns the product's sections, creating an empty draft the first time. `pageCreate` and `pageDuplicate` refuse sections types. `Page.product` and `Page.category` (admin) name the owner, and `Page.sectionsFor` says which kind it is.
- **Storefront.** `Product.sections` and `Category.sections` return the page: published for visitors, drafts too with a preview token, and null when there are none. Render its `content` as a document of its own (`data-ecom-document` with its id, and its own `references`), with the same product or category, where the template places the sections component. Don't render sections inside sections.
- **Preview.** `previewSessionCreate(pageId: <sections>)` opens the product's or category's page. Clicking the template's components there offers to open the template, and the other way round.
- **Caching.** Their events carry `sectionsFor` and the `productId` or `categoryId`. The API evicts that product's or category's cached responses, and the sample storefront expires its `ecom:sections:<kind>` tag.
- **Admin.** "Page design" on the product and category screens shows the sections, with *Add sections* and *Edit sections*. The editor's top bar names the owner, and the component library sets this under "Its pages are".

The demo seeds sections for the Trail Runner GTX, The Trail Guide and the Men category. On a database seeded before sections existed, `pnpm db:seed` adds the content types and components, places the components in the demo templates, and adds those sections. A template you changed is left for you to place them in.

## Visual editing

```
 Admin (page editor)                        Storefront (draft mode)
┌──────────────────────────┐   iframe   ┌─────────────────────────────────────┐
│ structure │ preview │ insp│──────────▶│ /api/draft?token=…&path=/sale       │
│   tree    │ ┌─────┐ │ ector│          │   → previewSession check, draft mode │
│           │ │     │ │     │ postMessage│   → render drafts with x-preview-token│
│           │ └─────┘ │     │◀─────────▶│ bridge.js: outlines, clicks, patches │
└──────────────────────────┘ (origin-   └─────────────────────────────────────┘
      pageSaveDraft (autosave)   checked)          ▲ router.refresh()
             └──────────────────────────────────────┘  re-fetches the saved draft
```

1. The editor creates a preview session (`previewSessionCreate`): a read-only token for drafts that lasts two hours, and the storefront URL to frame (`<frontend url><previewPath>?token=…&path=…&locale=…&channel=…`).
2. The storefront's preview route checks the token with `previewSession`, turns on draft mode, keeps the token in an httpOnly cookie and redirects to the path. In draft mode it fetches with `x-preview-token`, annotates what it renders and loads the bridge from `<api>/visual-editing/bridge.js`.
3. The bridge (`src/visual-editing/bridge.js`, framework-agnostic, about 15 KB) handshakes with the admin and draws outlines in a shadow root. A click on an annotated element selects that component and focuses the field in the inspector. The selected component gets a toolbar to select its parent, move, duplicate, remove or insert next to it, with only the actions its definition allows enabled. Double-clicking a plain-text field edits it in place.
4. As the editor types, the admin patches plain-text fields in the preview immediately. Once the debounced autosave lands, it asks the page to re-render, and the frontend refetches the saved draft (Next.js: `router.refresh()`). Structural edits (add, move, remove) take the refresh path.
5. Navigating inside the preview reports the new path, and the editor offers to open the page there.

### Markup

```html
<div data-ecom-document="gid://ecom/Page/…">                          <!-- each document on screen: page, header, footer -->
  <section data-ecom-node="home-hero" data-ecom-component="hero">     <!-- a component -->
    <h1 data-ecom-field="home-hero.title" data-ecom-patch="text">…</h1> <!-- a field; text patched live -->
    <li data-ecom-field="faq.items.q1">…</li>                         <!-- a list item -->
    <h3 data-ecom-field="faq.items.q1.question" data-ecom-patch="text">…</h3>
```

`data-ecom-patch="text"` promises the element's text is exactly the field's value, so the bridge may replace it while the editor types. You may render the attributes only in draft mode. The bridge ignores pages without them.

### Protocol (version 1)

All messages are objects `{ source, version: 1, type, … }`. The bridge posts only to the admin origin it was given (from `previewSession.adminOrigin`), and accepts messages only from that origin and its parent window. The admin accepts messages only from the framed storefront's origin and window.

| Message | Direction | Payload | Purpose |
|---|---|---|---|
| `bridge:ready` | storefront → admin | `path, url, title, bridgeVersion, features` | The bridge loaded (also after full reloads). `features` lists capabilities: `inline-text`, `actions`, `documents`. |
| `editor:connect` | admin → storefront | `documentId, labels, mode` | Start editing: the page being edited, component names for outline labels, edit or browse. |
| `bridge:connected` | storefront → admin | `path` | Overlays are active. |
| `bridge:select` | storefront → admin | `nodeId, path, documentId` | A click selected a component (`path: []`) or a field (`[field]`, `[field, itemId, subField]`). Another `documentId` means another document, such as the header. |
| `editor:select` | admin → storefront | `nodeId, path, scroll?, actions?` | Selection made in the admin; outline it and scroll to it. `actions` enables toolbar buttons from the node's slot (`min`, `max`, position). |
| `bridge:hover` / `editor:hover` | both | `nodeId, path` | Hover feedback between preview and structure tree. |
| `editor:patch` | admin → storefront | `nodeId, path, value` | Instant text update while typing. |
| `editor:refresh` | admin → storefront | `reason?` | The draft was saved; re-render. |
| `bridge:rendered` | storefront → admin | `path` | The re-render finished. |
| `bridge:action` | storefront → admin | `action, nodeId` | Toolbar: `selectParent`, `moveUp`, `moveDown`, `duplicate`, `remove`, `insertBefore`, `insertAfter`. The admin applies it, since the document lives there. |
| `bridge:input` | storefront → admin | `nodeId, path, value, documentId, done?` | In-place editing of a `data-ecom-patch="text"` field: the new text, debounced, and once more with `done` when editing ends (Esc reverts). The bridge holds `editor:refresh` until then, so a save never re-renders under the caret. |
| `bridge:navigated` / `editor:navigate` | both | `path` | The preview moved to another page, or the admin asks it to. |
| `editor:mode` | admin → storefront | `mode` | `edit` (clicks select; Alt-click follows links) or `browse` (the page behaves normally). |
| `editor:ping` | admin → storefront | | Ask for `bridge:ready` again. |

### Connecting a frontend

1. Register it under Settings › Storefronts: its URL, the preview route (default `/api/draft`) and, for revalidation on publish, a revalidate route (default `/api/revalidate`). The signing secret is shown once.
2. Implement the preview route: validate the token with `previewSession`, enable draft mode, store the token in an httpOnly cookie (with `SameSite=None; Secure; Partitioned` when the admin and storefront are on different sites), and redirect.
3. In draft mode, send `x-preview-token` on storefront API requests, render the attributes above, load the bridge and call `EcomVisualEditing.init({ adminOrigin, onRefresh, navigate })`. Allow framing by the admin with `Content-Security-Policy: frame-ancestors <admin origin>`.
4. Implement the revalidate route: verify `x-spindle-signature` (`t=<unix>,v1=<HMAC-SHA256 of "t.body">`, as for every webhook) and revalidate the paths or tags the event names (`data.path`, `data.previousPath`).
5. For statically built sites, add a deploy hook URL, which Deploy on the storefront calls.

In Next.js, [`@spindlecommerce/storefront-next`](https://github.com/spindlecommerce/storefront-sdk/tree/main/packages/storefront-next) does steps 2 to 4: `createDraftRoute`, `<VisualEditing>`, reads that send the token in draft mode, and `createRevalidateRoute`. The Next.js sample uses it. The sample lives in [its own repository](https://github.com/chachakawooka/Ecom-storefront), cloned into `storefront/`, and its README walks through it.

## Components in code

Definitions can live in the frontend's repository and be deployed like code, with [`@spindlecommerce/storefront-cli`](https://github.com/spindlecommerce/storefront-sdk/tree/main/packages/storefront-cli).

```bash
spindle-storefront components pull --out components.json                        # export the library
spindle-storefront components push components.json [--prune]                     # deploy definitions (content:write API key)
spindle-storefront components types --from components.json --out builder-components.ts   # TypeScript types for delivered content
```

`push` upserts by code and marks components as managed in code, and the admin warns before editing those. `--prune` deletes code-managed components missing from the file, and is refused while pages use them. The whole push is one transaction. Pass `--url` and `--key`, or set `SPINDLE_API_URL` and `SPINDLE_API_KEY`; `--env-file` also reads them from a file. Create the key under System › API keys.

## Code map

```
src/modules/builder/
  model.ts       field types, definitions schema, document validation, paths
  components.ts  library CRUD, usage, sync from code
  pages.ts       drafts, publish, unpublish, schedule, versions, duplicate, lookups
  releases.ts    releases and scheduled release publishing
  templates.ts   which template renders a product or category, assigning, customizing, preview targets
  sections.ts    a product's or category's own sections
  frontends.ts   storefronts, revalidation webhooks, deploy hooks, frame origins
  preview.ts     preview tokens and URLs
  delivery.ts    documents → delivered content (locale, visibility, links)
src/graphql/types/builder.ts   Page, Component, Release, Frontend, PreviewSession, templates and mutations
src/visual-editing/bridge.js   the bridge served at /visual-editing/bridge.js
src/db/seed-builder.ts         demo library, pages and templates
admin/src/routes/builder/      pages list, visual editor, component library, releases
```
