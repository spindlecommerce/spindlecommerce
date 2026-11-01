import { describe, expect, it } from "vitest";
import { DEMO_COMPONENTS } from "../../src/db/seed-builder.ts";
import { deliverDocument } from "../../src/modules/builder/delivery.ts";
import { componentCodesIn, normalizePath, pathProblem, validateDocument, type ComponentDefinition, type PageDocument } from "../../src/modules/builder/model.ts";

const components = new Map<string, ComponentDefinition>(DEMO_COMPONENTS.map((c) => [c.code, c]));
const product = "gid://ecom/Product/01920000-0000-7000-8000-000000000001";
const channelUs = "gid://ecom/Channel/01920000-0000-7000-8000-0000000000aa";
const channelEu = "gid://ecom/Channel/01920000-0000-7000-8000-0000000000bb";

const doc = (sections: unknown[]): PageDocument =>
  ({ title: { "en-US": "Test", "de-DE": "Test DE" }, path: "/test", seo: { description: { "en-US": "Desc" } }, root: { id: "root", component: "landing_page", fields: { sections } } }) as PageDocument;

const check = (document: unknown, mode: "draft" | "publish" = "draft") => validateDocument(document, { components, pageType: "landing_page", mode }).issues;

describe("page document validation", () => {
  it("checks structure on every save and completeness on publish", () => {
    const valid = doc([{ id: "h1", component: "hero", variation: "split", fields: { title: { "en-US": "Hi" }, actions: [{ id: "b1", component: "button", fields: { label: { "en-US": "Go" }, link: { kind: "url", url: "/sale" } } }] } }]);
    expect(check(valid, "publish")).toEqual([]);

    expect(check(doc([{ id: "h1", component: "hero", fields: { title: "not localized" } }]))).toEqual([{ path: ["node", "h1", "title"], message: "Expected text per locale" }]);
    expect(check(doc([{ id: "h1", component: "hero", variation: "nope", fields: {} }]))[0]!.message).toBe("Unknown variation nope");
    expect(check(doc([{ id: "dup", component: "spacer", fields: {} }, { id: "dup", component: "spacer", fields: {} }]))[0]!.message).toBe("Duplicate node id dup");
    // Buttons are allowed inside heroes, not as sections.
    expect(check(doc([{ id: "b1", component: "button", fields: {} }]))[0]!.message).toBe("Button is not allowed here");
    expect(check(doc([{ id: "h1", component: "hero", fields: { actions: [{ id: "x", component: "landing_page", fields: {} }] } }])).map((i) => i.message)).toContain("Landing page is a content type and cannot be nested");

    // Required fields, counts and link targets only matter when publishing.
    const incomplete = doc([{ id: "h1", component: "hero", fields: {} }, { id: "c1", component: "columns", fields: { columns: [{ id: "col", component: "column", fields: {} }] } }]);
    expect(check(incomplete)).toEqual([]);
    expect(check(incomplete, "publish")).toEqual([
      { path: ["node", "h1", "title"], message: "Title is required" },
      { path: ["node", "c1", "columns"], message: "Columns needs at least 2" },
    ]);
    expect(check(doc([{ id: "p1", component: "promo_banner", fields: { text: { "en-US": "x" }, link: { kind: "product", id: "gid://ecom/Category/01920000-0000-7000-8000-000000000001" } } }]))[0]!.message).toMatch(/Expected a link/);
    expect(check(doc([{ id: "f1", component: "faq", fields: { items: [{ id: "i1", fields: {} }, { id: "i1", fields: {} }] } }]))[0]!.message).toBe("Duplicate item id i1");
  });

  it("normalizes paths and keeps storefront routes free", () => {
    expect(normalizePath("Summer-Sale/")).toBe("/summer-sale");
    expect(normalizePath("//a//b/")).toBe("/a/b");
    expect(pathProblem("/")).toBeNull();
    expect(pathProblem("/products/shoes")).toMatch(/reserved/);
    expect(pathProblem("/admin")).toMatch(/reserved/);
    expect(pathProblem("/admin/orders")).toMatch(/reserved/);
    expect(pathProblem("/administration")).toBeNull();
    expect(pathProblem("/has space")).toMatch(/lowercase/);
  });

  it("finds component codes anywhere in a document", () => {
    expect([...componentCodesIn(doc([{ id: "c1", component: "columns", fields: { columns: [{ id: "col", component: "column", fields: { content: [{ id: "t", component: "text_block", fields: {} }] } }] } }]))].sort()).toEqual(["column", "columns", "landing_page", "text_block"]);
  });
});

describe("page delivery", () => {
  const document = doc([
    { id: "g1", component: "product_grid", variation: "carousel", fields: { title: { "en-US": "Shirts", "de-DE": "Hemden" }, products: [product], columns: "3" } },
    { id: "hidden", component: "spacer", hidden: true, fields: {} },
    { id: "eu", component: "spacer", visibility: { channelIds: [channelEu] }, fields: {} },
    { id: "later", component: "spacer", visibility: { from: "2030-01-01T00:00:00Z" }, fields: {} },
    { id: "de", component: "spacer", visibility: { locales: ["de"] }, fields: {} },
  ]);
  const deliver = (locale: string, channelId = channelUs, now = new Date("2026-06-01T00:00:00Z")) => deliverDocument(document, { components, locale, fallbackLocale: "en-US", channelId, now });

  it("flattens locales, applies defaults and drops fields of other variations", () => {
    const de = deliver("de-DE");
    expect(de.title).toBe("Test DE");
    const grid = (de.root.fields.sections as { fields: Record<string, unknown> }[])[0]!;
    expect(grid.fields).toMatchObject({ title: "Hemden", products: [product], limit: 8, showPrices: true, source: "manual" });
    // `columns` only applies to the grid variation.
    expect(grid.fields).not.toHaveProperty("columns");
    expect(deliver("fr-FR").title).toBe("Test");
    expect(de.references.products).toEqual([product]);
  });

  it("leaves out hidden components and those targeted elsewhere or later", () => {
    const ids = (locale: string, channelId?: string, now?: Date) => (deliver(locale, channelId, now).root.fields.sections as { id: string }[]).map((s) => s.id);
    expect(ids("en-US")).toEqual(["g1"]);
    expect(ids("de-DE")).toEqual(["g1", "de"]);
    expect(ids("en-US", channelEu)).toEqual(["g1", "eu"]);
    expect(ids("en-US", channelUs, new Date("2031-01-01T00:00:00Z"))).toEqual(["g1", "later"]);
  });
});
