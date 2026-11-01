import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGlobalId } from "../../src/lib/ids.ts";
import { deployFrontend } from "../../src/modules/builder/frontends.ts";
import { publishDuePages } from "../../src/modules/builder/pages.ts";
import { publishDueReleases } from "../../src/modules/builder/releases.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;
const gid = (type: string, id: string) => toGlobalId(type, id);

beforeAll(async () => {
  t = await createTestApp();
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

const PAGE = `fragment P on Page { id type path status version document title }`;
const ERR = `... on Error { __typename message } ... on ValidationError { fieldErrors { path message } }`;

const createPage = async (title: string, path: string, type = "landing_page") => {
  const r = await t.admin(`mutation($i: PageCreateInput!) { pageCreate(input: $i) { __typename ... on PagePayload { page { ...P } } ${ERR} } } ${PAGE}`, { i: { type, titles: [{ locale: "en-US", value: title }], path } }, auth);
  return r.data.pageCreate;
};
const save = async (id: string, baseVersion: number, document: unknown) =>
  (await t.admin(`mutation($id: ID!, $v: Int!, $d: JSON!) { pageSaveDraft(id: $id, baseVersion: $v, document: $d) { __typename ... on PagePayload { page { ...P } } ${ERR} } } ${PAGE}`, { id, v: baseVersion, d: document }, auth)).data.pageSaveDraft;
const publish = async (id: string, version?: number) =>
  (await t.admin(`mutation($id: ID!, $v: Int) { pagePublish(id: $id, version: $v) { __typename ... on PagePayload { page { ...P publishedPath } } ${ERR} } } ${PAGE}`, { id, v: version }, auth)).data.pagePublish;
const storefrontPage = async (path: string, headers: Record<string, string> = {}) =>
  (await t.storefront(`query($p: String!) { page(path: $p) { id title path isPreview content seo { title description } references { products { name } categories { name } pages { path title } } } }`, { p: path }, headers)).data?.page;

const hero = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, component: "hero", variation: "centered", fields: { title: { "en-US": title }, theme: "light", ...extra } });

describe("component library", () => {
  it("creates, validates, deploys from code and protects components in use", async () => {
    const created = await t.admin(
      `mutation($i: ComponentInput!) { componentCreate(input: $i) { __typename ... on ComponentPayload { component { code kind source fields usageCount } } ${ERR} } }`,
      { i: { code: "countdown", kind: "COMPONENT", name: "Countdown", groupName: "Marketing", fields: [{ key: "endsAt", type: "date", label: "Ends at", required: true }, { key: "headline", type: "text", label: "Headline", localized: true }] } },
      auth,
    );
    expect(created.data.componentCreate).toMatchObject({ __typename: "ComponentPayload", component: { code: "countdown", kind: "COMPONENT", source: "ADMIN", usageCount: 0 } });

    const invalid = await t.admin(
      `mutation($i: ComponentInput!) { componentCreate(input: $i) { __typename ${ERR} } }`,
      { i: { code: "broken", kind: "COMPONENT", name: "Broken", fields: [{ key: "a", type: "select", label: "A" }, { key: "a", type: "number", label: "Again", localized: true }, { key: "kids", type: "blocks", label: "Kids", allowedComponents: ["nope"] }] } },
      auth,
    );
    expect(invalid.data.componentCreate.__typename).toBe("ValidationError");
    const messages = invalid.data.componentCreate.fieldErrors.map((e: { message: string }) => e.message).join(" | ");
    expect(messages).toMatch(/needs options/);
    expect(messages).toMatch(/Duplicate field key a/);
    expect(messages).toMatch(/Only text and rich text can be localized/);

    // Deploying from code: new and changed definitions, unchanged ones counted, prune refused while in use.
    const SYNC = `mutation($d: JSON!, $p: Boolean) { componentsSync(definitions: $d, prune: $p) { __typename ... on ComponentsSyncPayload { created updated unchanged removed } ${ERR} } }`;
    const definitions = (await t.admin(`{ components { definition } }`, {}, auth)).data.components.map((c: { definition: Record<string, unknown> }) => c.definition) as Record<string, unknown>[];
    const withChange = definitions.map((d) => (d.code === "spacer" ? { ...d, name: "Gap" } : d)).filter((d) => d.code !== "countdown");
    const synced = await t.admin(SYNC, { d: [...withChange, { code: "marquee", kind: "component", name: "Marquee", fields: [{ key: "text", type: "text", label: "Text" }] }] }, auth);
    expect(synced.data.componentsSync.created).toEqual(["marquee"]);
    expect(synced.data.componentsSync.updated).toContain("spacer");
    expect(synced.data.componentsSync.unchanged).toContain("hero");
    // Leaving out a component others still allow is a broken set; leaving out one pages use is refused.
    const dangling = await t.admin(SYNC, { d: withChange.filter((d) => d.code !== "hero"), p: true }, auth);
    expect(dangling.data.componentsSync).toMatchObject({ __typename: "ValidationError", fieldErrors: expect.arrayContaining([{ path: expect.any(Array), message: "No component hero" }]) });
    const pruneUsed = await t.admin(SYNC, { d: withChange.filter((d) => d.code !== "landing_page"), p: true }, auth);
    expect(pruneUsed.data.componentsSync).toMatchObject({ __typename: "InvalidStateError", message: expect.stringMatching(/landing_page is still used/) });

    const heroId = (await t.admin(`{ component(code: "hero") { id usageCount } }`, {}, auth)).data.component;
    expect(heroId.usageCount).toBeGreaterThan(0);
    const refused = await t.admin(`mutation($id: ID!) { componentDelete(id: $id) { __typename ${ERR} } }`, { id: heroId.id }, auth);
    expect(refused.data.componentDelete).toMatchObject({ __typename: "InvalidStateError", message: expect.stringMatching(/used on \d+ page/) });
  });
});

describe("pages", () => {
  it("drafts, validates and publishes, keeping drafts out of the storefront", async () => {
    const reserved = await createPage("Nope", "/products/nope");
    expect(reserved).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "path"], message: expect.stringMatching(/reserved/) }] });
    const singleton = await createPage("Another header", "", "site_header");
    expect(singleton).toMatchObject({ __typename: "InvalidStateError", message: expect.stringMatching(/only be one/) });

    const created = await createPage("Autumn", "/Autumn-Drop");
    const page = created.page;
    expect(page).toMatchObject({ path: "/autumn-drop", status: "DRAFT", version: 1 });
    expect(await storefrontPage("/autumn-drop")).toBeNull();

    // Structure is checked on every save; required fields only when publishing.
    const unknown = await save(page.id, page.version, { ...page.document, root: { ...page.document.root, fields: { sections: [{ id: "bad", component: "nope", fields: {} }] } } });
    expect(unknown).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["document", "node", "bad"], message: "Unknown component nope" }] });
    const notAllowed = await save(page.id, page.version, { ...page.document, root: { ...page.document.root, fields: { sections: [{ id: "b1", component: "button", fields: {} }] } } });
    expect(notAllowed.fieldErrors[0].message).toMatch(/not allowed here/);

    const draft = { ...page.document, root: { ...page.document.root, fields: { sections: [hero("h1", ""), { id: "g1", component: "product_grid", variation: "grid", fields: { source: "manual", products: [gid("Product", t.seed.products.oxford.id)], limit: 4, columns: "4", showPrices: true } }] } } };
    const saved = await save(page.id, page.version, draft);
    expect(saved.page).toMatchObject({ version: 2, status: "DRAFT" });

    // A stale version is refused rather than overwriting someone else's save.
    const stale = await save(page.id, 1, draft);
    expect(stale).toMatchObject({ __typename: "ConflictError" });

    const missing = await publish(page.id, 2);
    expect(missing.__typename).toBe("ValidationError");
    expect(missing.fieldErrors).toEqual(expect.arrayContaining([{ path: ["node", "h1", "title"], message: "Title is required" }]));

    const fixed = await save(page.id, 2, { ...draft, root: { ...draft.root, fields: { sections: [hero("h1", "Autumn has landed"), draft.root.fields.sections[1]] } } });
    const published = await publish(page.id, fixed.page.version);
    expect(published.page).toMatchObject({ status: "PUBLISHED", publishedPath: "/autumn-drop" });

    const live = await storefrontPage("/autumn-drop");
    expect(live).toMatchObject({ title: "Autumn", isPreview: false, references: { products: [{ name: "Oxford Shirt" }] } });
    expect(live.content.fields.sections[0]).toMatchObject({ id: "h1", component: "hero", variation: "centered", fields: { title: "Autumn has landed" } });
    // Fields restricted to other variations are not delivered.
    expect(live.content.fields.sections[0].fields).not.toHaveProperty("image");

    // Draft edits stay invisible until published again; the page reports CHANGED.
    const edited = await save(page.id, published.page.version, { ...draft, root: { ...draft.root, fields: { sections: [hero("h1", "Draft headline")] } } });
    expect(edited.page.status).toBe("CHANGED");
    expect((await storefrontPage("/autumn-drop")).content.fields.sections[0].fields.title).toBe("Autumn has landed");

    const route = await t.storefront(`{ route(path: "/autumn-drop") { __typename ... on Page { title } } }`);
    expect(route.data.route).toEqual({ __typename: "Page", title: "Autumn" });
  });

  it("previews drafts with a token, scheduled content at a time, and nothing without one", async () => {
    const created = (await createPage("Preview me", "/preview-me")).page;
    const document = {
      ...created.document,
      root: {
        ...created.document.root,
        fields: {
          sections: [
            hero("p1", "Visible"),
            hero("p2", "Hidden", {}),
            hero("p3", "Next week"),
            hero("p4", "EU only"),
          ].map((n) => (n.id === "p2" ? { ...n, hidden: true } : n.id === "p3" ? { ...n, visibility: { from: new Date(Date.now() + 7 * 86_400_000).toISOString() } } : n.id === "p4" ? { ...n, visibility: { channelIds: [gid("Channel", t.seed.channels.eu.id)] } } : n)),
        },
      },
    };
    await save(created.id, created.version, document);
    expect(await storefrontPage("/preview-me")).toBeNull();

    const session = await t.admin(`mutation($p: ID!) { previewSessionCreate(pageId: $p) { ... on PreviewSessionPayload { session { token url expiresAt adminOrigin } } } }`, { p: created.id }, auth);
    const { token, url } = session.data.previewSessionCreate.session;
    expect(url).toMatch(/^http:\/\/localhost:3000\/api\/draft\?token=.+&path=%2Fpreview-me$/);

    const preview = await storefrontPage("/preview-me", { "x-preview-token": token });
    expect(preview.isPreview).toBe(true);
    expect(preview.content.fields.sections.map((s: { id: string }) => s.id)).toEqual(["p1"]);
    const eu = await storefrontPage("/preview-me", { "x-preview-token": token, "x-channel": "eu" });
    expect(eu.content.fields.sections.map((s: { id: string }) => s.id)).toEqual(["p1", "p4"]);

    // Previewing as of next week shows the scheduled hero.
    const later = await t.admin(`mutation($p: ID!, $at: DateTime) { previewSessionCreate(pageId: $p, at: $at) { ... on PreviewSessionPayload { session { token at } } } }`, { p: created.id, at: new Date(Date.now() + 8 * 86_400_000).toISOString() }, auth);
    const future = await storefrontPage("/preview-me", { "x-preview-token": later.data.previewSessionCreate.session.token });
    expect(future.content.fields.sections.map((s: { id: string }) => s.id)).toEqual(["p1", "p3"]);

    const check = await t.storefront(`{ previewSession { expiresAt adminOrigin } }`, {}, { "x-preview-token": token });
    expect(check.data.previewSession.adminOrigin).toMatch(/^http/);
    expect((await t.storefront(`{ previewSession { expiresAt } }`)).data.previewSession).toBeNull();
    const bad = await t.storefront(`{ page(path: "/preview-me") { id } }`, {}, { "x-preview-token": "not-a-token" });
    expect(bad.status).toBe(401);

    // Previews are never served from (or stored in) the response cache.
    const again = await t.storefront(`query($p: String!) { page(path: $p) { title } }`, { p: "/preview-me" }, { "x-preview-token": token });
    expect(again.extensions?.responseCache?.hit ?? false).toBe(false);
  });

  it("keeps history, restores versions, moves paths with a redirect and unpublishes", async () => {
    const created = (await createPage("History", "/history")).page;
    const v1 = await save(created.id, created.version, { ...created.document, root: { ...created.document.root, fields: { sections: [hero("x1", "First")] } } });
    const first = await publish(created.id, v1.page.version);
    const moved = await save(created.id, first.page.version, { ...first.page.document, path: "/history-new", root: { ...first.page.document.root, fields: { sections: [hero("x1", "Second")] } } });
    await publish(created.id, moved.page.version);

    const redirect = await t.storefront(`{ route(path: "/history") { __typename ... on Redirect { location statusCode } } }`);
    expect(redirect.data.route).toEqual({ __typename: "Redirect", location: "/history-new", statusCode: 301 });

    const versions = (await t.admin(`query($id: ID!) { page(id: $id) { versions { id kind version document } } }`, { id: created.id }, auth)).data.page.versions;
    const firstPublish = versions.filter((v: { kind: string }) => v.kind === "PUBLISH").at(-1);
    expect(firstPublish.document.root.fields.sections[0].fields.title["en-US"]).toBe("First");
    const restored = await t.admin(`mutation($id: ID!, $v: ID!) { pageVersionRestore(id: $id, versionId: $v) { ... on PagePayload { page { status document } } } }`, { id: created.id, v: firstPublish.id }, auth);
    expect(restored.data.pageVersionRestore.page).toMatchObject({ status: "CHANGED", document: { path: "/history" } });

    const discarded = await t.admin(`mutation($id: ID!) { pageDiscardDraft(id: $id) { ... on PagePayload { page { status document } } } }`, { id: created.id }, auth);
    expect(discarded.data.pageDiscardDraft.page).toMatchObject({ status: "PUBLISHED", document: { path: "/history-new" } });

    const copy = await t.admin(`mutation($id: ID!) { pageDuplicate(id: $id) { ... on PagePayload { page { path status title } } } }`, { id: created.id }, auth);
    expect(copy.data.pageDuplicate.page).toMatchObject({ path: "/history-new-copy", status: "DRAFT", title: "History (copy)" });

    await t.admin(`mutation($id: ID!) { pageUnpublish(id: $id) { __typename } }`, { id: created.id }, auth);
    expect(await storefrontPage("/history-new")).toBeNull();
  });

  it("publishes on schedule, and releases all at once or not at all", async () => {
    const make = async (path: string, title: string) => {
      const p = (await createPage(title, path)).page;
      return (await save(p.id, p.version, { ...p.document, root: { ...p.document.root, fields: { sections: [hero(`${path.slice(1)}-h`, title)] } } })).page;
    };
    const scheduled = await make("/scheduled", "Scheduled");
    const when = new Date(Date.now() + 60 * 60_000);
    const s = await t.admin(`mutation($id: ID!, $at: DateTime) { pageSchedule(id: $id, at: $at) { ... on PagePayload { page { status } } } }`, { id: scheduled.id, at: when.toISOString() }, auth);
    expect(s.data.pageSchedule.page.status).toBe("SCHEDULED");
    expect(await publishDuePages(t.platform.db, new Date())).toBe(0);
    expect(await publishDuePages(t.platform.db, new Date(when.getTime() + 1000))).toBe(1);
    expect((await storefrontPage("/scheduled")).title).toBe("Scheduled");

    const ready = await make("/launch-a", "Launch A");
    const broken = await make("/launch-b", "Launch B");
    await save(broken.id, broken.version, { ...broken.document, root: { ...broken.document.root, fields: { sections: [hero("launch-b-h", "")] } } });
    const release = await t.admin(`mutation($i: ReleaseInput!, $p: [ID!]) { releaseCreate(input: $i, pageIds: $p) { ... on ReleasePayload { release { id status pages { path } } } } }`, { i: { name: "Autumn launch" }, p: [ready.id, broken.id] }, auth);
    const releaseId = release.data.releaseCreate.release.id;
    expect(release.data.releaseCreate.release.pages.map((p: { path: string }) => p.path)).toEqual(["/launch-a", "/launch-b"]);

    const failed = await t.admin(`mutation($id: ID!) { releasePublish(id: $id) { __typename ${ERR} } }`, { id: releaseId }, auth);
    expect(failed.data.releasePublish.__typename).toBe("ValidationError");
    expect(failed.data.releasePublish.fieldErrors[0].path).toEqual(["pages", broken.id.split("/").pop(), "node", "launch-b-h", "title"]);
    // Nothing went live: the valid page waits for the release too.
    expect(await storefrontPage("/launch-a")).toBeNull();

    await t.admin(`mutation($id: ID!, $p: [ID!]!) { releaseRemovePages(id: $id, pageIds: $p) { __typename } }`, { id: releaseId, p: [broken.id] }, auth);
    await t.admin(`mutation($id: ID!, $i: ReleaseInput!) { releaseUpdate(id: $id, input: $i) { __typename } }`, { id: releaseId, i: { scheduledAt: new Date(Date.now() + 60_000).toISOString() } }, auth);
    expect(await publishDueReleases(t.platform.db, new Date(Date.now() + 120_000))).toBe(1);
    expect((await storefrontPage("/launch-a")).title).toBe("Launch A");
    const done = await t.admin(`query($id: ID!) { node(id: $id) { ... on Release { status publishedAt } } }`, { id: releaseId }, auth);
    expect(done.data.node.status).toBe("PUBLISHED");
  });

  it("delivers header and footer singletons with resolved links", async () => {
    const header = (await t.storefront(`{ singletonPage(type: "site_header") { path content references { pages { path } categories { name } } } }`)).data.singletonPage;
    expect(header.path).toBeNull();
    const nav = header.content.fields.navigation as { fields: { label: string; link: { href: string; kind: string } } }[];
    expect(nav.map((n) => n.fields.link.href)).toEqual(["/categories/men", "/categories/women", "/categories/accessories", "/summer-sale", "/about"]);
    expect(header.references.categories.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["Men", "Women"]));
  });
});

describe("storefronts", () => {
  it("wires revalidation webhooks, previews and deploy hooks", async () => {
    const created = await t.admin(
      `mutation($i: FrontendInput!) { frontendCreate(input: $i) { __typename ... on FrontendPayload { revalidateSecret frontend { id name url revalidatePath webhookSubscription { url events } hasDeployHook } } ${ERR} } }`,
      { i: { name: "Production", url: "https://shop.example.test/", revalidatePath: "/api/revalidate", deployHookUrl: "https://hooks.example.test/deploy/abc" } },
      auth,
    );
    const payload = created.data.frontendCreate;
    expect(payload.revalidateSecret).toMatch(/^whsec_/);
    expect(payload.frontend).toMatchObject({ url: "https://shop.example.test", hasDeployHook: true, webhookSubscription: { url: "https://shop.example.test/api/revalidate", events: expect.arrayContaining(["page.*"]) } });

    // Publishing a page delivers a signed page.published event to the storefront.
    const page = (await createPage("Webhook", "/webhook")).page;
    const saved = await save(page.id, page.version, { ...page.document, root: { ...page.document.root, fields: { sections: [hero("w1", "Hello")] } } });
    await publish(page.id, saved.page.version);
    while ((await processOutbox(t.platform)) > 0) {
      // drain
    }
    const deliveries = await t.admin(`{ webhookDeliveries(first: 50) { edges { node { eventType subscription { url } } } } }`, {}, auth);
    expect(deliveries.data.webhookDeliveries.edges.map((e: { node: { eventType: string; subscription: { url: string } } }) => `${e.node.eventType} ${e.node.subscription.url}`)).toContain("page.published https://shop.example.test/api/revalidate");

    const calls: string[] = [];
    const deployed = await deployFrontend(t.platform.db, payload.frontend.id.split("/").pop(), { fetch: async (url) => (calls.push(url), new Response(null, { status: 201 })) });
    expect(calls).toEqual(["https://hooks.example.test/deploy/abc"]);
    expect(deployed.lastDeployStatus).toBe("Triggered (HTTP 201)");

    const off = await t.admin(`mutation($id: ID!, $i: FrontendInput!) { frontendUpdate(id: $id, input: $i) { ... on FrontendPayload { frontend { revalidatePath webhookSubscription { id } } } } }`, { id: payload.frontend.id, i: { revalidatePath: null } }, auth);
    expect(off.data.frontendUpdate.frontend).toEqual({ revalidatePath: null, webhookSubscription: null });
  });
});

describe("builder safeguards", () => {
  it("dry-runs releases, refuses to schedule unready ones and keeps discarded drafts", async () => {
    const p = (await createPage("Guarded", "/guarded")).page;
    const saved = await save(p.id, p.version, { ...p.document, root: { ...p.document.root, fields: { sections: [hero("g-h", "")] } } });
    const release = await t.admin(`mutation($i: ReleaseInput!, $p: [ID!]) { releaseCreate(input: $i, pageIds: $p) { __typename ... on ReleasePayload { release { id problems { path message } } } } }`, { i: { name: "Guarded" }, p: [p.id] }, auth);
    const { id: releaseId, problems } = release.data.releaseCreate.release;
    expect(problems).toEqual([{ path: ["pages", p.id.split("/").pop(), "node", "g-h", "title"], message: "Title is required" }]);
    const schedule = await t.admin(`mutation($id: ID!, $i: ReleaseInput!) { releaseUpdate(id: $id, input: $i) { __typename ${ERR} } }`, { id: releaseId, i: { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() } }, auth);
    expect(schedule.data.releaseUpdate).toMatchObject({ __typename: "ValidationError", message: "1 page(s) are not ready to publish" });

    const fixed = await save(p.id, saved.page.version, { ...saved.page.document, root: { ...saved.page.document.root, fields: { sections: [hero("g-h", "Ready")] } } });
    const published = await publish(p.id, fixed.page.version);
    await save(p.id, published.page.version, { ...fixed.page.document, root: { ...fixed.page.document.root, fields: { sections: [hero("g-h", "Experiment")] } } });
    await t.admin(`mutation($id: ID!) { pageDiscardDraft(id: $id) { __typename } }`, { id: p.id }, auth);
    const versions = (await t.admin(`query($id: ID!) { page(id: $id) { versions { kind label document } } }`, { id: p.id }, auth)).data.page.versions;
    const kept = versions.find((v: { label: string | null }) => v.label === "Before discarding changes");
    expect(kept.document.root.fields.sections[0].fields.title["en-US"]).toBe("Experiment");
  });

  it("validates default values and allows public hosts that look like IPv6 prefixes", async () => {
    const bad = await t.admin(`mutation($i: ComponentInput!) { componentCreate(input: $i) { __typename ${ERR} } }`, { i: { code: "badge", kind: "COMPONENT", name: "Badge", fields: [{ key: "tone", type: "select", label: "Tone", options: [{ value: "a", label: "A" }], defaultValue: "z" }] } }, auth);
    expect(bad.data.componentCreate.fieldErrors).toEqual([{ path: ["input", "fields", "0", "defaultValue"], message: "Must be one of the options" }]);
    const fd = await t.admin(`mutation($i: FrontendInput!) { frontendCreate(input: $i) { __typename ${ERR} } }`, { i: { name: "FD shop", url: "https://fdshop.example", revalidatePath: "/api/revalidate" } }, auth);
    expect(fd.data.frontendCreate.__typename).toBe("FrontendPayload");
  });
});

describe("templates", () => {
  const MATCH = `fragment M on TemplateMatch { source page { id title status } category { name } }`;
  const TARGETS = `templateTargets { isDefault products { id } categories { name } }`;
  const productTemplate = async (id: string, headers: Record<string, string> = {}) =>
    (await t.storefront(`query($id: ID!) { product(id: $id) { template { id type templateFor isPreview content } } }`, { id }, headers)).data.product.template;
  const categoryTemplate = async (id: string, headers: Record<string, string> = {}) =>
    (await t.storefront(`query($id: ID!) { category(id: $id) { template { id title isPreview } } }`, { id }, headers)).data.category.template;
  const productMatch = async (id: string, live = false) => (await t.admin(`query($id: ID!, $l: Boolean) { product(id: $id) { templateMatch(live: $l) { ...M } } } ${MATCH}`, { id, l: live }, auth)).data.product.templateMatch;
  const assign = async (id: string, input: Record<string, unknown>) =>
    (await t.admin(`mutation($id: ID!, $i: TemplateTargetsInput!) { pageTemplateTargetsUpdate(id: $id, input: $i) { __typename ... on PagePayload { page { id ${TARGETS} } } ${ERR} } }`, { id, i: input }, auth)).data.pageTemplateTargetsUpdate;
  const targetsOf = async (id: string) => (await t.admin(`query($id: ID!) { page(id: $id) { ${TARGETS} } }`, { id }, auth)).data.page.templateTargets;
  const customize = async (productId: string) => (await t.admin(`mutation($p: ID!) { pageTemplateCustomize(productId: $p) { __typename ... on PagePayload { page { id title status ${TARGETS} } } ${ERR} } }`, { p: productId }, auth)).data.pageTemplateCustomize;
  const drain = async () => {
    while ((await processOutbox(t.platform)) > 0);
  };
  const product = (key: keyof typeof t.seed.products) => gid("Product", t.seed.products[key].id);
  const category = (key: keyof typeof t.seed.categories) => gid("Category", t.seed.categories[key].id);

  it("renders products and categories with the most specific published template", async () => {
    const seeded = await productTemplate(product("oxford"));
    expect(seeded).toMatchObject({ type: "product_page", templateFor: "PRODUCT", isPreview: false });
    expect(seeded.content.fields.sections.map((s: { component: string }) => s.component)).toContain("product_details");
    expect((await productMatch(product("oxford"))).source).toBe("DEFAULT");
    // The women's category has a landing design of its own; other categories use the default.
    expect((await categoryTemplate(category("women"))).title).toBe("Women's landing");
    expect((await categoryTemplate(category("men"))).title).toBe("Category page");

    // A product's own copy stays a draft: visitors keep the default until it is published.
    const custom = (await customize(product("oxford"))).page;
    expect(custom).toMatchObject({ title: "Product page · Oxford Shirt", status: "DRAFT", templateTargets: { isDefault: false, products: [{ id: product("oxford") }] } });
    expect(await productMatch(product("oxford"))).toMatchObject({ source: "PRODUCT", page: { id: custom.id } });
    expect(await productMatch(product("oxford"), true)).toMatchObject({ source: "DEFAULT", page: { id: seeded.id } });
    expect((await productTemplate(product("oxford"))).id).toBe(seeded.id);
    expect((await customize(product("oxford"))).page.id).toBe(custom.id);

    // Publishing evicts cached product responses, so the new template shows at once.
    expect((await publish(custom.id)).__typename).toBe("PagePayload");
    await drain();
    expect((await productTemplate(product("oxford"))).id).toBe(custom.id);
    expect((await productTemplate(product("tee"))).id).toBe(seeded.id);
  });

  it("assigns templates to categories and products, one template each, and keeps data components in templates", async () => {
    const shirts = (await createPage("Shirts", "", "product_page")).page;
    expect(shirts.path).toBeNull();
    const document = { ...shirts.document, root: { ...shirts.document.root, fields: { sections: [{ id: "d1", component: "product_details", variation: "gallery_right", fields: { showBreadcrumbs: false } }] } } };
    expect((await save(shirts.id, shirts.version, document)).__typename).toBe("PagePayload");
    expect((await publish(shirts.id)).__typename).toBe("PagePayload");

    // Products in a category (or its subcategories) use the template assigned nearest to them.
    expect((await assign(shirts.id, { categoryIds: [category("men")] })).page.templateTargets).toMatchObject({ isDefault: false, products: [], categories: [{ name: "Men" }] });
    const tee = await productMatch(product("tee"));
    expect(tee).toMatchObject({ source: "CATEGORY", page: { id: shirts.id }, category: { name: "Men" } });
    const nearer = (await createPage("Shirts close-up", "", "product_page")).page;
    expect((await assign(nearer.id, { categoryIds: [category("menShirts")] })).__typename).toBe("PagePayload");
    expect(await productMatch(product("tee"))).toMatchObject({ source: "CATEGORY", page: { id: nearer.id }, category: { name: "Men's Shirts" } });
    // Visitors only see published templates, so the unpublished nearer one is skipped for them.
    await drain();
    expect((await productTemplate(product("tee"))).id).toBe(shirts.id);

    // A published template takes what it is assigned from the template that had it.
    const own = (await customize(product("socks"))).page;
    expect((await assign(shirts.id, { productIds: [product("socks")] })).page.templateTargets.products).toEqual([{ id: product("socks") }]);
    expect((await targetsOf(own.id)).products).toEqual([]);

    // One default per kind: making this published template the default takes it from the seeded one.
    // The guide is in no category with a template, so it shows the default.
    const previous = (await productMatch(product("guide"))).page.id;
    expect((await assign(shirts.id, { isDefault: true })).page.templateTargets.isDefault).toBe(true);
    expect((await targetsOf(previous)).isDefault).toBe(false);
    expect((await productMatch(product("guide"))).page.id).toBe(shirts.id);
    expect((await assign(previous, { isDefault: true })).__typename).toBe("PagePayload");
    expect((await targetsOf(shirts.id)).isDefault).toBe(false);
    expect((await assign(shirts.id, { categoryIds: [], productIds: [] })).page.templateTargets).toEqual({ isDefault: false, products: [], categories: [] });

    // A draft template waits: visitors keep the published default until the draft is published.
    const next = (await createPage("Next season", "", "product_page")).page;
    expect((await assign(next.id, { isDefault: true })).page.templateTargets.isDefault).toBe(true);
    expect((await targetsOf(previous)).isDefault).toBe(true);
    expect(await productMatch(product("guide"))).toMatchObject({ source: "DEFAULT", page: { id: next.id } });
    expect(await productMatch(product("guide"), true)).toMatchObject({ source: "DEFAULT", page: { id: previous } });
    await drain();
    expect((await productTemplate(product("guide"))).id).toBe(previous);
    expect((await publish(next.id)).__typename).toBe("PagePayload");
    expect((await targetsOf(previous)).isDefault).toBe(false);
    await drain();
    expect((await productTemplate(product("guide"))).id).toBe(next.id);
    expect((await assign(previous, { isDefault: true })).__typename).toBe("PagePayload");
    expect((await targetsOf(next.id)).isDefault).toBe(false);

    // Category templates take categories; pages with a path are not templates.
    const categoryOnly = (await createPage("Sale categories", "", "category_page")).page;
    expect((await assign(categoryOnly.id, { productIds: [product("oxford")] })).__typename).toBe("ValidationError");
    const plain = (await createPage("Plain", "/plain-not-a-template")).page;
    expect((await assign(plain.id, { isDefault: true })).__typename).toBe("InvalidStateError");
    const misplaced = await save(plain.id, plain.version, { ...plain.document, root: { ...plain.document.root, fields: { sections: [{ id: "x1", component: "product_details", fields: {} }] } } });
    expect(misplaced).toMatchObject({ __typename: "ValidationError", fieldErrors: expect.arrayContaining([expect.objectContaining({ message: "Product details shows product data, so it only works in product templates and sections" })]) });
  });

  it("previews a template on a product or category it renders, with that template everywhere", async () => {
    const landing = (await t.admin(`query($id: ID!) { category(id: $id) { templateMatch { page { id } } } }`, { id: category("women") }, auth)).data.category.templateMatch.page.id;
    const session = (await t.admin(`mutation($p: ID!) { previewSessionCreate(pageId: $p) { ... on PreviewSessionPayload { session { token url path } } } }`, { p: landing }, auth)).data.previewSessionCreate.session;
    expect(session.path).toBe("/categories/women");
    expect(session.url).toContain("path=%2Fcategories%2Fwomen");
    expect(await categoryTemplate(category("men"), { "x-preview-token": session.token })).toMatchObject({ id: landing, isPreview: true });
    expect((await categoryTemplate(category("men"))).id).not.toBe(landing);

    const productDefault = (await productMatch(product("trailRunner"))).page.id;
    const slug = (await t.storefront(`query($id: ID!) { product(id: $id) { slug } }`, { id: product("guide") })).data.product.slug;
    const chosen = (await t.admin(`mutation($p: ID!, $product: ID) { previewSessionCreate(pageId: $p, productId: $product) { ... on PreviewSessionPayload { session { path } } } }`, { p: productDefault, product: product("guide") }, auth)).data.previewSessionCreate.session;
    expect(chosen.path).toBe(`/products/${slug}`);
  });
});
