import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGlobalId } from "../../src/lib/ids.ts";
import { builderPages } from "../../src/modules/builder/tables.ts";
import { outboxEvents } from "../../src/modules/integrations/tables.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await createTestApp();
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, { e: TEST_CREDENTIALS.adminEmail, p: TEST_CREDENTIALS.adminPassword });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

const ERR = `... on Error { __typename message } ... on ValidationError { fieldErrors { path message } }`;
const PAGE = `fragment P on Page { id type title status version document sectionsFor product { name } category { name } }`;
type Content = { content: { fields: { sections: { component: string }[] } } };

const product = (key: keyof typeof t.seed.products) => toGlobalId("Product", t.seed.products[key].id);
const category = (key: keyof typeof t.seed.categories) => toGlobalId("Category", t.seed.categories[key].id);
const rawId = (id: string) => id.split("/").pop()!;
const drain = async () => {
  while ((await processOutbox(t.platform)) > 0);
};

const addSections = async (owner: { productId?: string; categoryId?: string }) =>
  (await t.admin(`mutation($p: ID, $c: ID) { pageSectionsCreate(productId: $p, categoryId: $c) { __typename ... on PagePayload { page { ...P } } ${ERR} } } ${PAGE}`, { p: owner.productId, c: owner.categoryId }, auth)).data
    .pageSectionsCreate;
const save = async (page: { id: string; version: number; document: { root: Record<string, unknown> } }, sections: unknown[]) =>
  (
    await t.admin(
      `mutation($id: ID!, $v: Int!, $d: JSON!) { pageSaveDraft(id: $id, baseVersion: $v, document: $d) { __typename ... on PagePayload { page { ...P } } ${ERR} } } ${PAGE}`,
      { id: page.id, v: page.version, d: { ...page.document, root: { ...page.document.root, fields: { sections } } } },
      auth,
    )
  ).data.pageSaveDraft;
const publish = async (id: string) => (await t.admin(`mutation($id: ID!) { pagePublish(id: $id) { __typename ${ERR} } }`, { id }, auth)).data.pagePublish;
const productSections = async (id: string, headers: Record<string, string> = {}) =>
  (await t.storefront(`query($id: ID!) { product(id: $id) { sections { id type sectionsFor isPreview content } } }`, { id }, headers)).data.product.sections;
const categorySections = async (id: string) => (await t.storefront(`query($id: ID!) { category(id: $id) { sections { id sectionsFor content } } }`, { id })).data.category.sections;
const components = (page: Content) => page.content.fields.sections.map((s) => s.component);

describe("product and category sections", () => {
  it("gives products and categories components of their own where the shared templates place them", async () => {
    const template = (await t.storefront(`query($id: ID!) { product(id: $id) { template { content } } }`, { id: product("oxford") })).data.product.template;
    expect(components(template)).toContain("product_sections");
    const categoryTemplate = (await t.storefront(`query($id: ID!) { category(id: $id) { template { content } } }`, { id: category("men") })).data.category.template;
    expect(components(categoryTemplate)).toContain("category_sections");

    // The demo gives two products different sections, and one category its own.
    expect(await productSections(product("trailRunner"))).toMatchObject({ type: "product_sections_page", sectionsFor: "PRODUCT", isPreview: false });
    expect(components(await productSections(product("trailRunner")))).toEqual(["image_with_text", "feature_list"]);
    expect(components(await productSections(product("guide")))).toEqual(["testimonials", "faq"]);
    expect(await productSections(product("oxford"))).toBeNull();
    expect(await categorySections(category("men"))).toMatchObject({ sectionsFor: "CATEGORY" });
    expect(components(await categorySections(category("men")))).toEqual(["image_with_text"]);
    expect(await categorySections(category("women"))).toBeNull();
  });

  it("adds sections to a product as a draft that previews on its page until published", async () => {
    const created = await addSections({ productId: product("oxford") });
    expect(created).toMatchObject({
      __typename: "PagePayload",
      page: { type: "product_sections_page", title: "Oxford Shirt", status: "DRAFT", sectionsFor: "PRODUCT", product: { name: "Oxford Shirt" }, category: null },
    });
    expect((await addSections({ productId: product("oxford") })).page.id).toBe(created.page.id);

    // General components and the product's own data, but not a category's.
    expect((await save(created.page, [{ id: "x1", component: "category_products", fields: {} }])).__typename).toBe("ValidationError");
    const saved = await save(created.page, [
      { id: "s1", component: "rich_text", fields: { content: { "en-US": "Woven in Portugal from **organic cotton**." }, width: "narrow", align: "left" } },
      { id: "s2", component: "product_specs", fields: { title: { "en-US": "Fabric" } } },
    ]);
    expect(saved).toMatchObject({ __typename: "PagePayload", page: { status: "DRAFT" } });

    // The preview opens the product's page with the draft; visitors see nothing until it is published.
    const session = (await t.admin(`mutation($p: ID!) { previewSessionCreate(pageId: $p) { ... on PreviewSessionPayload { session { token path } } } }`, { p: created.page.id }, auth)).data
      .previewSessionCreate.session;
    const slug = (await t.storefront(`query($id: ID!) { product(id: $id) { slug } }`, { id: product("oxford") })).data.product.slug;
    expect(session.path).toBe(`/products/${slug}`);
    expect(await productSections(product("oxford"), { "x-preview-token": session.token })).toMatchObject({ id: created.page.id, isPreview: true });
    expect(await productSections(product("oxford"))).toBeNull();

    expect((await publish(created.page.id)).__typename).toBe("PagePayload");
    await drain();
    expect(components(await productSections(product("oxford")))).toEqual(["rich_text", "product_specs"]);
    // The event says whose sections they are, so frontends refresh that product's page.
    const [event] = await t.platform.db.select().from(outboxEvents).where(and(eq(outboxEvents.type, "page.published"), eq(outboxEvents.aggregateId, rawId(created.page.id))));
    expect(event!.payload).toMatchObject({ type: "product_sections_page", sectionsFor: "product", productId: t.seed.products.oxford.id });
  });

  it("keeps sections with their owner: out of the page list, made only from it, and deleted with it", async () => {
    const listed = (await t.admin(`{ pages(first: 100) { edges { node { type } } } }`, {}, auth)).data.pages.edges.map((e: { node: { type: string } }) => e.node.type);
    expect(listed).toContain("product_page");
    expect(listed).not.toContain("product_sections_page");
    expect(listed).not.toContain("category_sections_page");

    const loose = await t.admin(`mutation($i: PageCreateInput!) { pageCreate(input: $i) { __typename ${ERR} } }`, { i: { type: "product_sections_page", titles: [{ locale: "en-US", value: "Loose" }] } }, auth);
    expect(loose.data.pageCreate).toMatchObject({ __typename: "InvalidStateError", message: expect.stringMatching(/from the product's screen/) });
    const trail = (await addSections({ productId: product("trailRunner") })).page;
    expect((await t.admin(`mutation($id: ID!) { pageDuplicate(id: $id) { __typename ${ERR} } }`, { id: trail.id }, auth)).data.pageDuplicate.__typename).toBe("InvalidStateError");

    expect((await addSections({ productId: product("trailRunner"), categoryId: category("men") })).__typename).toBe("ValidationError");
    expect((await addSections({})).__typename).toBe("ValidationError");
    expect((await addSections({ productId: toGlobalId("Product", "00000000-0000-4000-8000-000000000000") })).__typename).toBe("NotFoundError");

    const shoes = (await addSections({ categoryId: category("menShoes") })).page;
    expect(shoes).toMatchObject({ type: "category_sections_page", sectionsFor: "CATEGORY", category: { name: "Men's Shoes" }, product: null });
    const socks = (await addSections({ productId: product("socks") })).page;
    expect((await t.admin(`mutation($id: ID!) { productDelete(id: $id) { ... on DeletePayload { deletedId } ${ERR} } }`, { id: product("socks") }, auth)).data.productDelete.deletedId).toBe(product("socks"));
    expect((await t.admin(`mutation($id: ID!) { categoryDelete(id: $id) { ... on DeletePayload { deletedId } ${ERR} } }`, { id: category("menShoes") }, auth)).data.categoryDelete.deletedId).toBe(category("menShoes"));
    expect(await t.platform.db.$count(builderPages, eq(builderPages.id, rawId(socks.id)))).toBe(0);
    expect(await t.platform.db.$count(builderPages, eq(builderPages.id, rawId(shoes.id)))).toBe(0);
  });

  it("holds sections only in content types that are not templates, and keeps them bound while used", async () => {
    const CREATE = `mutation($i: ComponentInput!) { componentCreate(input: $i) { __typename ... on ComponentPayload { component { code sectionsFor routable } } ${ERR} } }`;
    const both = await t.admin(CREATE, { i: { code: "both", kind: "CONTENT_TYPE", name: "Both", templateFor: "PRODUCT", sectionsFor: "PRODUCT" } }, auth);
    expect(both.data.componentCreate).toMatchObject({ __typename: "ValidationError", fieldErrors: [expect.objectContaining({ message: expect.stringMatching(/either a template or holds sections/) })] });
    const component = await t.admin(CREATE, { i: { code: "inline", kind: "COMPONENT", name: "Inline", sectionsFor: "CATEGORY" } }, auth);
    expect(component.data.componentCreate.__typename).toBe("ValidationError");
    const story = await t.admin(CREATE, { i: { code: "category_story", kind: "CONTENT_TYPE", name: "Category story", sectionsFor: "CATEGORY", fields: [{ key: "body", type: "richText", label: "Body", localized: true }] } }, auth);
    expect(story.data.componentCreate).toMatchObject({ __typename: "ComponentPayload", component: { code: "category_story", sectionsFor: "CATEGORY", routable: false } });

    // The demo's product sections type is in use, so it cannot start holding category sections.
    const used = (await t.admin(`{ component(code: "product_sections_page") { id } }`, {}, auth)).data.component.id;
    const rebind = await t.admin(`mutation($id: ID!, $i: ComponentInput!) { componentUpdate(id: $id, input: $i) { __typename ${ERR} } }`, { id: used, i: { sectionsFor: "CATEGORY" } }, auth);
    expect(rebind.data.componentUpdate).toMatchObject({ __typename: "ValidationError", fieldErrors: [{ path: ["input", "sectionsFor"], message: expect.stringMatching(/is used on \d+ pages; remove it from them/) }] });
  });
});
