import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../../src/lib/errors.ts";
import { newId, toGlobalId } from "../../src/lib/ids.ts";
import { productChannelListings, products } from "../../src/modules/catalog/tables.ts";
import { resolveScope } from "../../src/modules/channels/service.ts";
import { createPluginServices } from "../../src/modules/plugins/services.ts";
import type { CatalogScope, PluginProduct, PluginServices } from "../../src/plugins/sdk.ts";
import { createTestApp } from "../helpers/app.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let catalog: PluginServices["catalog"];
let us: string;
let eu: string;

beforeAll(async () => {
  t = await createTestApp();
  catalog = createPluginServices(t.platform.db, "tests").catalog;
  us = (await resolveScope(t.platform.db, { channel: "us" })).channel.id;
  eu = (await resolveScope(t.platform.db, { channel: "eu" })).channel.id;
});
afterAll(() => t.close());

/** Every page, two products at a time. */
const listAll = async (scope: CatalogScope) => {
  const listed: PluginProduct[] = [];
  let after: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof catalog.listProducts>> = await catalog.listProducts({ ...scope, first: 2, after });
    listed.push(...page.products);
    after = page.next;
  } while (after);
  return listed;
};

const byName = async (name: string) => (await listAll({ channelId: us })).find((p) => p.name === name)!;

describe("the plugins' catalog service", () => {
  it("lists every product a channel sells, a page at a time, oldest first", async () => {
    const listed = await listAll({ channelId: us });
    const names = listed.map((p) => p.name);
    expect(names).toHaveLength(8);
    expect(names).toEqual(expect.arrayContaining(["Oxford Shirt", "Everyday Tee", "Trail Runner GTX", "Canvas Sneaker", "Digital Gift Card"]));
    // The seeded draft is not sold.
    expect(names).not.toContain("Linen Blouse (coming soon)");
    // Ids are time-ordered.
    expect(listed.map((p) => p.id)).toEqual(listed.map((p) => p.id).toSorted());
    expect((await catalog.listProducts({ channelId: us, first: 8 })).next).toBeNull();
    expect((await catalog.listProducts({ channelId: us, first: 7 })).next).not.toBeNull();
    await expect(catalog.listProducts({ channelId: us, after: "not-a-cursor" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("shows a product as the storefront API does, in the scope's locale and currency", async () => {
    const { id } = await byName("Oxford Shirt");
    const product = (await catalog.getProduct(id, { channelId: eu, locale: "de-DE", currency: "EUR" }))!;
    expect(product).toMatchObject({
      channelId: eu,
      locale: "de-DE",
      currency: "EUR",
      name: "Oxford-Hemd",
      path: `/products/${product.slug}`,
      url: `http://localhost:3000/products/${product.slug}`,
      visibleInListings: true,
      productType: { isShippable: true },
      priceRange: { min: 5900, max: 5900, compareAtMin: null },
      available: true,
    });
    expect(product.attributes).toContainEqual(expect.objectContaining({ code: "material", value: "Bio-Baumwolle" }));
    expect(product.media).toHaveLength(2);
    expect(product.variants).toHaveLength(6);
    expect(product.variants[0]).toMatchObject({ sku: expect.stringMatching(/^OXF-/), price: 5900, compareAtPrice: null, available: true, quantityAvailable: 15 });

    const shown = (
      await t.storefront(
        `query ($id: ID!) { product(id: $id) { name slug description isAvailable attributes { attribute { code } value } categories { name path } variants { sku name isAvailable quantityAvailable } } }`,
        { id: toGlobalId("Product", id) },
        { "x-channel": "eu", "x-locale": "de-DE", "x-currency": "EUR" },
      )
    ).data!.product;
    expect(product).toMatchObject({ name: shown.name, slug: shown.slug, description: shown.description, available: shown.isAvailable });
    expect(product.attributes.map((a) => ({ code: a.code, value: a.value }))).toEqual(shown.attributes.map((a: any) => ({ code: a.attribute.code, value: a.value })));
    expect(product.categories.map((c) => ({ name: c.name, path: c.slugPath }))).toEqual(shown.categories);
    expect(product.variants.map((v) => ({ sku: v.sku, name: v.name, isAvailable: v.available, quantityAvailable: v.quantityAvailable }))).toEqual(shown.variants);
  });

  it("prices in the requested currency and falls back as the storefront does", async () => {
    const trail = await byName("Trail Runner GTX");
    // A pound price set in the eu channel.
    expect((await catalog.getProduct(trail.id, { channelId: eu, locale: "en-GB", currency: "GBP" }))!.variants[0]!.price).toBe(12500);
    // No such locale or currency: the channel's defaults.
    expect(await catalog.getProduct(trail.id, { channelId: eu, locale: "es-ES", currency: "JPY" })).toMatchObject({ locale: "de-DE", currency: "EUR" });
  });

  it("leaves out what shoppers can't see, and marks products kept out of listings", async () => {
    const [draft] = await t.platform.db.select().from(products).where(eq(products.status, "draft"));
    expect(await catalog.getProduct(draft!.id, { channelId: us })).toBeNull();
    expect(await catalog.getProduct("not-an-id", { channelId: us })).toBeNull();

    const sneaker = await byName("Canvas Sneaker");
    const listing = and(eq(productChannelListings.productId, sneaker.id), eq(productChannelListings.channelId, us));
    await t.platform.db.update(productChannelListings).set({ visibleInListings: false }).where(listing);
    expect(await catalog.getProduct(sneaker.id, { channelId: us })).toMatchObject({ visibleInListings: false });
    await t.platform.db.update(productChannelListings).set({ isPublished: false }).where(listing);
    expect(await catalog.getProduct(sneaker.id, { channelId: us })).toBeNull();
    expect((await listAll({ channelId: us })).map((p) => p.name)).not.toContain("Canvas Sneaker");
    // Still sold in the other channel.
    expect(await catalog.getProduct(sneaker.id, { channelId: eu })).not.toBeNull();
  });

  it("refuses unknown channels", async () => {
    await expect(catalog.listProducts({ channelId: newId() })).rejects.toBeInstanceOf(NotFoundError);
    await expect(catalog.getProduct(newId(), { channelId: "eu" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
