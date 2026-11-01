import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toGlobalId } from "../../src/lib/ids.ts";
import { outboxEvents } from "../../src/modules/integrations/tables.ts";
import { processOutbox } from "../../src/modules/integrations/worker.ts";
import { reindexProducts } from "../../src/modules/search/projector.ts";
import { bearer, createTestApp } from "../helpers/app.ts";
import { TEST_CREDENTIALS } from "../helpers/platform.ts";

let t: Awaited<ReturnType<typeof createTestApp>>;
let auth: Record<string, string>;
const gid = (type: string, id: string) => toGlobalId(type, id);

beforeAll(async () => {
  t = await createTestApp();
  const login = await t.admin(`mutation($e: EmailAddress!, $p: String!) { staffLogin(email: $e, password: $p) { ... on StaffAuthPayload { session { accessToken } } } }`, {
    e: TEST_CREDENTIALS.adminEmail,
    p: TEST_CREDENTIALS.adminPassword,
  });
  auth = bearer(login.data.staffLogin.session.accessToken);
});
afterAll(() => t.close());

const board = async (categoryId: string) => {
  const res = await t.admin(`query($id: ID!) { category(id: $id) { merchandising { totalCount items { product { id name status } pinned hidden } } } }`, { id: gid("Category", categoryId) }, auth);
  return res.data.category.merchandising as { totalCount: number; items: { product: { id: string; name: string; status: string }; pinned: boolean; hidden: boolean }[] };
};

/** Product names in the category's storefront listing. */
const listing = async (categoryId: string, sort?: { field: string; direction?: string }) => {
  const res = await t.storefront(`query($id: ID!, $sort: ProductSortInput) { category(id: $id) { products(first: 20, sort: $sort) { totalCount edges { node { name } } } } }`, { id: gid("Category", categoryId), sort });
  return (res.data.category.products.edges as { node: { name: string } }[]).map((e) => e.node.name);
};

const merchandise = async (categoryId: string, input: { pinned: string[]; hidden: string[] }) => {
  const res = await t.admin(
    `mutation($id: ID!, $input: CategoryMerchandisingInput!) { categoryMerchandisingUpdate(id: $id, input: $input) { __typename ... on ValidationError { fieldErrors { path message } } } }`,
    { id: gid("Category", categoryId), input: { pinned: input.pinned.map((id) => gid("Product", id)), hidden: input.hidden.map((id) => gid("Product", id)) } },
    auth,
  );
  // The worker evicts cached listings, as it does after any change.
  await processOutbox(t.platform);
  return res.data.categoryMerchandisingUpdate as { __typename: string; fieldErrors?: { path: string[]; message: string }[] };
};

describe("category merchandising", () => {
  it("pins products first and hides them from that category's listing only", async () => {
    const { categories, products } = t.seed;
    const women = categories.women.id;
    const [tee, runner, sneaker] = [products.tee, products.trailRunner, products.sneaker];

    // Unmerchandised, the default sort is the newest-first order it always was.
    expect(await listing(women)).toEqual(["Canvas Sneaker", "Trail Runner GTX", "Everyday Tee"]);
    const before = await board(women);
    expect(before.totalCount).toBe(4);
    expect(before.items.map((i) => i.product.name)).toEqual(["Linen Blouse (coming soon)", "Canvas Sneaker", "Trail Runner GTX", "Everyday Tee"]);
    expect(before.items.some((i) => i.pinned || i.hidden)).toBe(false);

    expect(await merchandise(women, { pinned: [tee.id, runner.id], hidden: [sneaker.id] })).toEqual({ __typename: "CategoryPayload" });
    expect(await listing(women)).toEqual(["Everyday Tee", "Trail Runner GTX"]);
    expect(await listing(women, { field: "FEATURED" })).toEqual(["Everyday Tee", "Trail Runner GTX"]);
    // Hidden in every sort, but only in this category: its subcategory lists the sneaker still.
    expect(await listing(women, { field: "PRICE", direction: "DESC" })).not.toContain("Canvas Sneaker");
    expect(await listing(categories.womenShoes.id)).toEqual(["Canvas Sneaker", "Trail Runner GTX"]);

    // The board: pinned in order, then hidden, then the rest newest first.
    const after = await board(women);
    expect(after.items.map((i) => [i.product.name, i.pinned, i.hidden])).toEqual([
      ["Everyday Tee", true, false],
      ["Trail Runner GTX", true, false],
      ["Canvas Sneaker", false, true],
      ["Linen Blouse (coming soon)", false, false],
    ]);

    // Pins live in the search projection, and survive any rebuild of a product's rows.
    await reindexProducts(t.platform.db, [tee.id, runner.id, sneaker.id]);
    expect(await listing(women)).toEqual(["Everyday Tee", "Trail Runner GTX"]);

    const events = await t.platform.db.select().from(outboxEvents).where(and(eq(outboxEvents.type, "category.updated"), eq(outboxEvents.aggregateId, women)));
    expect(events.length).toBeGreaterThan(0);

    // Replacing with nothing restores the automatic order.
    await merchandise(women, { pinned: [], hidden: [] });
    expect(await listing(women)).toEqual(["Canvas Sneaker", "Trail Runner GTX", "Everyday Tee"]);
  });

  it("refuses products outside the category, and products named twice", async () => {
    const { categories, products } = t.seed;
    const result = await merchandise(categories.women.id, { pinned: [products.oxford.id, products.tee.id], hidden: [products.tee.id] });
    expect(result.__typename).toBe("ValidationError");
    expect(result.fieldErrors).toEqual([
      { path: ["input", "pinned", "0"], message: "Not in this category or a category below it" },
      { path: ["input", "hidden", "0"], message: "Named twice: a product is pinned or hidden, once" },
    ]);
    expect((await board(categories.women.id)).items.some((i) => i.pinned || i.hidden)).toBe(false);
  });
});
