import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { toGlobalId } from "../lib/ids.ts";
import { loadDefinitions, syncComponents } from "../modules/builder/components.ts";
import { createFrontend, listFrontends } from "../modules/builder/frontends.ts";
import { ensureSections, type SectionsOwner } from "../modules/builder/sections.ts";
import { builderComponents, builderPages } from "../modules/builder/tables.ts";
import { setTemplateTargets } from "../modules/builder/templates.ts";
import { categoryTranslations, productVariants } from "../modules/catalog/tables.ts";
import type { ComponentDefinition, FieldDefinition, PageDocument, PageNode, TemplateFor } from "../modules/builder/model.ts";
import { createPage, publishPage, savePageDraft } from "../modules/builder/pages.ts";
import type { Database } from "./client.ts";

/**
 * The demo component library and pages, rendered by the sample storefront. A real project keeps
 * its definitions in the frontend's code and deploys them with `pnpm components push`.
 */

const t = (en: string, de?: string, fr?: string) => ({ "en-US": en, "en-GB": en, ...(de ? { "de-DE": de } : {}), ...(fr ? { "fr-FR": fr } : {}) });
const photo = (seed: string, width = 1600, height = 1000) => `https://picsum.photos/seed/ecom-${seed}/${width}/${height}`;

const text = (key: string, label: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({ key, type: "text", label, localized: true, ...extra });
const select = (key: string, label: string, options: [string, string][], defaultValue?: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  key,
  type: "select",
  label,
  options: options.map(([value, label]) => ({ value, label })),
  ...(defaultValue ? { defaultValue } : {}),
  group: "Style",
  ...extra,
});

const SECTIONS = ["hero", "rich_text", "product_grid", "category_tiles", "promo_banner", "image_with_text", "feature_list", "testimonials", "faq", "newsletter", "columns", "video", "logo_cloud", "spacer"];
/** Templates take the product's or category's own components plus every general one. */
const PRODUCT_SECTIONS = ["product_details", "product_description", "product_specs", "related_products", "product_sections", ...SECTIONS];
const CATEGORY_SECTIONS = ["category_header", "subcategories", "category_products", "category_sections", ...SECTIONS];
/** For a product's or category's own sections: the same, minus the main block the template shows. */
const OWN_PRODUCT_SECTIONS = ["product_description", "product_specs", "related_products", ...SECTIONS];
const OWN_CATEGORY_SECTIONS = ["subcategories", ...SECTIONS];

export const DEMO_COMPONENTS: ComponentDefinition[] = [
  // ---------------------------------------------------------------- content types
  {
    code: "landing_page",
    kind: "content_type",
    name: "Landing page",
    description: "A page assembled from sections: home, campaigns, brand stories.",
    icon: "layout-template",
    routable: true,
    fields: [{ key: "sections", type: "blocks", label: "Sections", allowedComponents: SECTIONS }],
    variations: [],
  },
  {
    code: "site_header",
    kind: "content_type",
    name: "Site header",
    description: "The announcement bar and main navigation on every page.",
    icon: "panel-top",
    routable: false,
    singleton: true,
    fields: [
      text("announcement", "Announcement", { description: "A short line above the navigation; empty hides the bar." }),
      { key: "announcementLink", type: "link", label: "Announcement link" },
      {
        key: "navigation",
        type: "list",
        label: "Navigation",
        max: 8,
        fields: [text("label", "Label", { required: true }), { key: "link", type: "link", label: "Link", required: true }, { key: "highlight", type: "boolean", label: "Highlight" }],
      },
    ],
    variations: [],
  },
  {
    code: "site_footer",
    kind: "content_type",
    name: "Site footer",
    icon: "panel-bottom",
    routable: false,
    singleton: true,
    fields: [
      { key: "columns", type: "blocks", label: "Link columns", allowedComponents: ["footer_column"], max: 4 },
      text("tagline", "Tagline", { multiline: true }),
      text("legal", "Legal line"),
    ],
    variations: [],
  },
  {
    code: "product_page",
    kind: "content_type",
    name: "Product page",
    description: "A template for product pages: the product's details and any sections around them.",
    icon: "package",
    templateFor: "product",
    routable: false,
    fields: [{ key: "sections", type: "blocks", label: "Sections", allowedComponents: PRODUCT_SECTIONS }],
    variations: [],
  },
  {
    code: "category_page",
    kind: "content_type",
    name: "Category page",
    description: "A template for category pages: the category's products and any sections around them.",
    icon: "folder-open",
    templateFor: "category",
    routable: false,
    fields: [{ key: "sections", type: "blocks", label: "Sections", allowedComponents: CATEGORY_SECTIONS }],
    variations: [],
  },
  {
    code: "product_sections_page",
    kind: "content_type",
    name: "Product sections",
    description: "One product's own sections, shown where its template places them.",
    icon: "layers",
    sectionsFor: "product",
    routable: false,
    fields: [{ key: "sections", type: "blocks", label: "Sections", allowedComponents: OWN_PRODUCT_SECTIONS }],
    variations: [],
  },
  {
    code: "category_sections_page",
    kind: "content_type",
    name: "Category sections",
    description: "One category's own sections, shown where its template places them.",
    icon: "layers",
    sectionsFor: "category",
    routable: false,
    fields: [{ key: "sections", type: "blocks", label: "Sections", allowedComponents: OWN_CATEGORY_SECTIONS }],
    variations: [],
  },

  // ---------------------------------------------------------------- product and category data
  {
    code: "product_details",
    kind: "component",
    name: "Product details",
    description: "The product's gallery, name, price, options and add to cart button.",
    groupName: "Product",
    icon: "package",
    templateFor: "product",
    variations: [
      { code: "gallery_left", name: "Gallery left" },
      { code: "gallery_right", name: "Gallery right" },
    ],
    fields: [
      text("note", "Purchase note", { description: "A line under the add to cart button.", placeholder: "Free delivery over $75 · 30-day returns" }),
      { key: "showBreadcrumbs", type: "boolean", label: "Show breadcrumbs", defaultValue: true, group: "Style" },
    ],
  },
  {
    code: "product_description",
    kind: "component",
    name: "Product description",
    description: "The product's description from the catalog.",
    groupName: "Product",
    icon: "align-left",
    templateFor: "product",
    variations: [],
    fields: [text("title", "Title", { placeholder: "About this product" })],
  },
  {
    code: "product_specs",
    kind: "component",
    name: "Product specifications",
    description: "The product's attributes as a table: material, fit, care.",
    groupName: "Product",
    icon: "table",
    templateFor: "product",
    variations: [],
    fields: [text("title", "Title", { placeholder: "Details" })],
  },
  {
    code: "related_products",
    kind: "component",
    name: "Related products",
    description: "More products from the product's category, or the newest arrivals.",
    groupName: "Product",
    icon: "shopping-bag",
    templateFor: "product",
    variations: [],
    fields: [
      text("title", "Title"),
      select("source", "Products from", [["category", "The same category"], ["newest", "Newest arrivals"]], "category", { group: "Content" }),
      { key: "limit", type: "number", label: "How many", min: 2, max: 12, defaultValue: 4 },
      { key: "showPrices", type: "boolean", label: "Show prices", defaultValue: true, group: "Style" },
    ],
  },
  {
    code: "category_header",
    kind: "component",
    name: "Category header",
    description: "The category's name and description, with breadcrumbs.",
    groupName: "Category",
    icon: "heading",
    templateFor: "category",
    variations: [
      { code: "simple", name: "Simple" },
      { code: "banner", name: "Banner", description: "Over a full-width image." },
    ],
    fields: [
      { key: "image", type: "image", label: "Banner image", variations: ["banner"] },
      { key: "showDescription", type: "boolean", label: "Show description", defaultValue: true, group: "Style" },
      { key: "showBreadcrumbs", type: "boolean", label: "Show breadcrumbs", defaultValue: true, group: "Style" },
    ],
  },
  {
    code: "subcategories",
    kind: "component",
    name: "Subcategories",
    description: "Links to the category's subcategories; nothing shows where there are none.",
    groupName: "Category",
    icon: "folder-tree",
    templateFor: "category",
    variations: [
      { code: "pills", name: "Pills" },
      { code: "cards", name: "Cards" },
    ],
    fields: [text("title", "Title")],
  },
  {
    code: "category_products",
    kind: "component",
    name: "Category products",
    description: "The category's products, with sorting and pages.",
    groupName: "Category",
    icon: "layout-grid",
    templateFor: "category",
    variations: [],
    fields: [
      { key: "pageSize", type: "number", label: "Products per page", min: 4, max: 48, defaultValue: 12 },
      select("columns", "Columns", [["2", "2"], ["3", "3"], ["4", "4"]], "3"),
      { key: "showSort", type: "boolean", label: "Show sorting", defaultValue: true, group: "Style" },
      { key: "showPrices", type: "boolean", label: "Show prices", defaultValue: true, group: "Style" },
    ],
  },
  {
    code: "product_sections",
    kind: "component",
    name: "This product's sections",
    description: "Where each product's own sections go. Products without any show nothing here.",
    groupName: "Product",
    icon: "rows-3",
    templateFor: "product",
    variations: [],
    fields: [],
  },
  {
    code: "category_sections",
    kind: "component",
    name: "This category's sections",
    description: "Where each category's own sections go. Categories without any show nothing here.",
    groupName: "Category",
    icon: "rows-3",
    templateFor: "category",
    variations: [],
    fields: [],
  },

  // ---------------------------------------------------------------- sections
  {
    code: "hero",
    kind: "component",
    name: "Hero",
    description: "A large headline with an image and buttons.",
    groupName: "Sections",
    icon: "image",
    variations: [
      { code: "split", name: "Split", description: "Text beside the image." },
      { code: "centered", name: "Centered", description: "Centered text over a soft background." },
      { code: "full_bleed", name: "Full bleed", description: "Text over a full-width image." },
    ],
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "New season" }),
      text("title", "Title", { required: true, max: 120 }),
      text("subtitle", "Subtitle", { multiline: true }),
      { key: "image", type: "image", label: "Image", variations: ["split", "full_bleed"] },
      { key: "actions", type: "blocks", label: "Buttons", allowedComponents: ["button"], max: 2 },
      select("theme", "Theme", [["light", "Light"], ["dark", "Dark"], ["brand", "Brand"]], "light"),
    ],
  },
  {
    code: "rich_text",
    kind: "component",
    name: "Rich text",
    description: "Formatted text: headings, paragraphs, lists and links (Markdown).",
    groupName: "Sections",
    icon: "pilcrow",
    variations: [],
    fields: [
      { key: "content", type: "richText", label: "Content", localized: true, required: true },
      select("width", "Width", [["narrow", "Narrow"], ["normal", "Normal"], ["wide", "Wide"]], "normal"),
      select("align", "Alignment", [["left", "Left"], ["center", "Center"]], "left"),
    ],
  },
  {
    code: "product_grid",
    kind: "component",
    name: "Product grid",
    description: "Products picked by hand, from a category, or the newest arrivals.",
    groupName: "Commerce",
    icon: "shopping-bag",
    variations: [
      { code: "grid", name: "Grid" },
      { code: "carousel", name: "Carousel", description: "One scrolling row." },
    ],
    fields: [
      text("title", "Title"),
      select("source", "Products from", [["manual", "Picked products"], ["category", "A category"], ["newest", "Newest arrivals"]], "manual", { group: "Content" }),
      { key: "products", type: "products", label: "Products", max: 24, description: "Used when products are picked by hand." },
      { key: "category", type: "category", label: "Category", description: "Used when products come from a category, in its Featured order." },
      { key: "limit", type: "number", label: "How many", min: 1, max: 24, defaultValue: 8 },
      select("columns", "Columns", [["2", "2"], ["3", "3"], ["4", "4"]], "4", { variations: ["grid"] }),
      { key: "showPrices", type: "boolean", label: "Show prices", defaultValue: true, group: "Style" },
      { key: "link", type: "link", label: "“View all” link" },
    ],
  },
  {
    code: "category_tiles",
    kind: "component",
    name: "Category tiles",
    description: "Image tiles linking to categories.",
    groupName: "Commerce",
    icon: "layout-grid",
    variations: [],
    fields: [
      text("title", "Title"),
      {
        key: "tiles",
        type: "list",
        label: "Tiles",
        min: 1,
        max: 8,
        fields: [{ key: "category", type: "category", label: "Category", required: true }, { key: "image", type: "image", label: "Image" }, text("label", "Label", { description: "Defaults to the category name." })],
      },
    ],
  },
  {
    code: "promo_banner",
    kind: "component",
    name: "Promo banner",
    description: "A slim announcement, e.g. a discount code. Schedule it with visibility dates.",
    groupName: "Marketing",
    icon: "megaphone",
    variations: [],
    fields: [
      text("text", "Text", { required: true }),
      { key: "code", type: "text", label: "Discount code", placeholder: "SUMMER20" },
      { key: "link", type: "link", label: "Link" },
      select("tone", "Tone", [["sale", "Sale"], ["info", "Info"], ["dark", "Dark"]], "sale"),
    ],
  },
  {
    code: "image_with_text",
    kind: "component",
    name: "Image with text",
    groupName: "Sections",
    icon: "square-split-horizontal",
    variations: [],
    fields: [
      { key: "image", type: "image", label: "Image", required: true },
      text("title", "Title"),
      { key: "body", type: "richText", label: "Text", localized: true },
      { key: "actions", type: "blocks", label: "Buttons", allowedComponents: ["button"], max: 2 },
      select("imagePosition", "Image position", [["left", "Left"], ["right", "Right"]], "left"),
    ],
  },
  {
    code: "feature_list",
    kind: "component",
    name: "Feature list",
    description: "Icons with short benefits: shipping, returns, materials.",
    groupName: "Sections",
    icon: "list-checks",
    variations: [],
    fields: [
      text("title", "Title"),
      text("intro", "Introduction", { multiline: true }),
      {
        key: "features",
        type: "list",
        label: "Features",
        min: 1,
        max: 8,
        fields: [
          { key: "icon", type: "select", label: "Icon", options: ["truck", "refresh", "shield", "leaf", "star", "gift", "heart", "clock"].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })), defaultValue: "star" },
          text("title", "Title", { required: true }),
          text("text", "Text", { multiline: true }),
        ],
      },
      select("columns", "Columns", [["2", "2"], ["3", "3"], ["4", "4"]], "3"),
    ],
  },
  {
    code: "testimonials",
    kind: "component",
    name: "Testimonials",
    groupName: "Marketing",
    icon: "quote",
    variations: [],
    fields: [
      text("title", "Title"),
      {
        key: "quotes",
        type: "list",
        label: "Quotes",
        min: 1,
        max: 6,
        fields: [text("quote", "Quote", { required: true, multiline: true }), { key: "author", type: "text", label: "Author", required: true }, text("role", "Role"), { key: "avatar", type: "image", label: "Photo" }],
      },
    ],
  },
  {
    code: "faq",
    kind: "component",
    name: "FAQ",
    description: "Questions with expandable answers.",
    groupName: "Sections",
    icon: "circle-help",
    variations: [],
    fields: [
      text("title", "Title"),
      { key: "items", type: "list", label: "Questions", min: 1, max: 20, fields: [text("question", "Question", { required: true }), { key: "answer", type: "richText", label: "Answer", localized: true, required: true }] },
    ],
  },
  {
    code: "newsletter",
    kind: "component",
    name: "Newsletter sign-up",
    groupName: "Marketing",
    icon: "mail",
    variations: [],
    fields: [text("title", "Title", { required: true }), text("text", "Text", { multiline: true }), text("buttonLabel", "Button label"), text("consent", "Consent note", { multiline: true })],
  },
  {
    code: "columns",
    kind: "component",
    name: "Columns",
    description: "Two to four columns of text, images and buttons.",
    groupName: "Layout",
    icon: "columns-3",
    variations: [],
    fields: [{ key: "columns", type: "blocks", label: "Columns", allowedComponents: ["column"], min: 2, max: 4 }, select("gap", "Spacing", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], "medium")],
  },
  {
    code: "column",
    kind: "component",
    name: "Column",
    groupName: "Layout",
    icon: "rectangle-vertical",
    variations: [],
    fields: [{ key: "content", type: "blocks", label: "Content", allowedComponents: ["text_block", "image_block", "button"] }],
  },
  {
    code: "video",
    kind: "component",
    name: "Video",
    groupName: "Media",
    icon: "play",
    variations: [],
    fields: [
      { key: "url", type: "text", label: "Video URL", required: true, description: "An MP4 file or a YouTube/Vimeo link." },
      { key: "poster", type: "image", label: "Poster image" },
      text("caption", "Caption"),
      { key: "autoplay", type: "boolean", label: "Autoplay muted", group: "Style" },
    ],
  },
  {
    code: "logo_cloud",
    kind: "component",
    name: "Logo cloud",
    groupName: "Marketing",
    icon: "badge-check",
    variations: [],
    fields: [text("title", "Title"), { key: "logos", type: "list", label: "Logos", max: 12, fields: [{ key: "image", type: "image", label: "Logo", required: true }, { key: "name", type: "text", label: "Name", required: true }, { key: "link", type: "link", label: "Link" }] }],
  },
  {
    code: "spacer",
    kind: "component",
    name: "Spacer",
    groupName: "Layout",
    icon: "separator-horizontal",
    variations: [],
    fields: [select("size", "Size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], "medium"), { key: "divider", type: "boolean", label: "Show a line", group: "Style" }],
  },

  // ---------------------------------------------------------------- elements
  {
    code: "button",
    kind: "component",
    name: "Button",
    groupName: "Elements",
    icon: "mouse-pointer-click",
    variations: [],
    fields: [text("label", "Label", { required: true }), { key: "link", type: "link", label: "Link", required: true }, select("style", "Style", [["primary", "Primary"], ["secondary", "Secondary"], ["link", "Text link"]], "primary")],
  },
  {
    code: "text_block",
    kind: "component",
    name: "Text",
    groupName: "Elements",
    icon: "type",
    variations: [],
    fields: [{ key: "content", type: "richText", label: "Content", localized: true, required: true }],
  },
  {
    code: "image_block",
    kind: "component",
    name: "Image",
    groupName: "Elements",
    icon: "image",
    variations: [],
    fields: [{ key: "image", type: "image", label: "Image", required: true }, text("caption", "Caption"), { key: "link", type: "link", label: "Link" }],
  },
  {
    code: "footer_column",
    kind: "component",
    name: "Footer column",
    groupName: "Site",
    icon: "list",
    variations: [],
    fields: [text("title", "Title", { required: true }), { key: "links", type: "list", label: "Links", max: 10, fields: [text("label", "Label", { required: true }), { key: "link", type: "link", label: "Link", required: true }] }],
  },
];

type SeedRefs = {
  products: Record<"oxford" | "tee" | "trailRunner" | "sneaker" | "tote" | "socks" | "guide" | "card", { id: string }>;
  categories: Record<"men" | "women" | "menShirts" | "womenTops" | "accessories" | "books" | "menShoes" | "womenShoes", { id: string }>;
};

const node = (id: string, component: string, fields: Record<string, unknown>, extra: Partial<PageNode> = {}): PageNode => ({ id, component, fields, ...extra });
const button = (id: string, label: Record<string, string>, link: unknown, style = "primary") => node(id, "button", { label, link, style });
const pageLink = (id: string) => ({ kind: "page", id: toGlobalId("Page", id) });
const categoryLink = (id: string) => ({ kind: "category", id: toGlobalId("Category", id) });

const publishedPage = async (db: Database, type: string, title: Record<string, string>, path: string | null, root: Omit<PageNode, "id" | "component">, seo: PageDocument["seo"] = {}) => {
  const actor = { staffId: null };
  const page = await createPage(db, { type, title, path }, actor);
  const document: PageDocument = { title, path, seo, root: { id: "root", component: type, ...root } };
  const saved = await savePageDraft(db, page.id, { baseVersion: page.version, document }, actor);
  return publishPage(db, saved.id, actor);
};

// Free delivery: US over $75; Europe (whose English is en-GB) to EU addresses over €60 or £52, never
// to the UK.
const SHOP_PROMISES = [
  { id: "feat-shipping", fields: { icon: "truck", title: { ...t("Free shipping over $75", "Kostenloser Versand ab 60 €", "Livraison offerte dès 60 €"), "en-GB": "Free EU delivery over €60 / £52" }, text: t("Fast, tracked delivery.") } },
  { id: "feat-returns", fields: { icon: "refresh", title: t("30-day returns", "30 Tage Rückgabe"), text: t("Changed your mind? Send it back.") } },
  { id: "feat-repairs", fields: { icon: "shield", title: t("Free repairs for life", "Kostenlose Reparaturen"), text: t("We fix it, you keep wearing it.") } },
];

/** The default product and category templates, and a landing design for the women's category. */
export const seedTemplates = async (db: Database, categories: Pick<SeedRefs["categories"], "women">) => {
  const productPage = await publishedPage(db, "product_page", t("Product page", "Produktseite", "Page produit"), null, {
    fields: {
      sections: [
        node("pdp-details", "product_details", { note: { ...t("Free delivery over $75 · 30-day returns", "Kostenloser Versand ab 60 € · 30 Tage Rückgabe", "Livraison offerte dès 60 € · Retours sous 30 jours"), "en-GB": "Free EU delivery over €60 / £52 · 30-day returns" }, showBreadcrumbs: true }, { variation: "gallery_left" }),
        node("pdp-description", "product_description", { title: t("About this product", "Über dieses Produkt", "À propos de ce produit") }),
        node("pdp-specs", "product_specs", { title: t("Details", "Details", "Détails") }),
        node("pdp-own", "product_sections", {}),
        node("pdp-promises", "feature_list", { features: SHOP_PROMISES, columns: "3" }),
        node("pdp-related", "related_products", { title: t("You may also like", "Das könnte dir auch gefallen", "Vous aimerez aussi"), source: "category", limit: 4, showPrices: true }),
      ],
    },
  });
  await setTemplateTargets(db, productPage.id, { isDefault: true });

  const categoryPage = await publishedPage(db, "category_page", t("Category page", "Kategorieseite", "Page catégorie"), null, {
    fields: {
      sections: [
        node("plp-header", "category_header", { showDescription: true, showBreadcrumbs: true }, { variation: "simple" }),
        node("plp-subcategories", "subcategories", {}, { variation: "pills" }),
        node("plp-own", "category_sections", {}),
        node("plp-products", "category_products", { pageSize: 12, columns: "3", showSort: true, showPrices: true }),
      ],
    },
  });
  await setTemplateTargets(db, categoryPage.id, { isDefault: true });

  const women = await publishedPage(db, "category_page", t("Women's landing", "Damen-Landingpage", "Page Femme"), null, {
    fields: {
      sections: [
        node("women-header", "category_header", { image: { url: photo("women-landing"), alt: t("A hiker in a light jacket on a coastal path") }, showDescription: true, showBreadcrumbs: true }, { variation: "banner" }),
        node("women-promo", "promo_banner", { text: t("Summer sale: 20% off tops", "Sommer-Sale: 20 % auf Oberteile", "Soldes : -20 % sur les hauts"), code: "SUMMER20", tone: "sale" }),
        node("women-subcategories", "subcategories", { title: t("Shop by category", "Nach Kategorie", "Par catégorie") }, { variation: "cards" }),
        node("women-own", "category_sections", {}),
        node("women-products", "category_products", { pageSize: 8, columns: "4", showSort: true, showPrices: true }),
      ],
    },
  });
  await setTemplateTargets(db, women.id, { categoryIds: [categories.women.id] });
};

const publishedSections = async (db: Database, owner: SectionsOwner, title: Record<string, string>, sections: PageNode[]) => {
  const actor = { staffId: null };
  const page = await ensureSections(db, owner, { name: title["en-US"]!, locale: "en-US" }, actor);
  const document: PageDocument = { ...page.draft, title, root: { ...page.draft.root, fields: { sections } } };
  const saved = await savePageDraft(db, page.id, { baseVersion: page.version, document }, actor);
  return publishPage(db, saved.id, actor);
};

/** Own sections for two products and a category, so their pages differ within the shared templates. */
export const seedSections = async (db: Database, refs: { products: Pick<SeedRefs["products"], "trailRunner" | "guide">; categories: Pick<SeedRefs["categories"], "men" | "menShoes"> }) => {
  await publishedSections(db, { productId: refs.products.trailRunner.id }, t("Trail Runner GTX"), [
    node("trail-story", "image_with_text", {
      image: { url: photo("trail-runner-stream", 1200, 900), alt: t("A runner crossing a stream on a rocky trail") },
      title: t("Made for wet, rocky trails", "Gemacht für nasse, felsige Trails", "Conçue pour les sentiers humides et rocheux"),
      body: t("A waterproof membrane keeps your feet dry through streams and bogs, and **5 mm lugs** bite into mud and loose rock."),
      imagePosition: "right",
    }),
    node("trail-features", "feature_list", {
      title: t("Why runners pick it", "Warum Läufer ihn wählen", "Pourquoi les coureurs la choisissent"),
      features: [
        { id: "trail-dry", fields: { icon: "shield", title: t("Waterproof", "Wasserdicht", "Imperméable"), text: t("Dry feet from the first puddle to the last.") } },
        { id: "trail-grip", fields: { icon: "star", title: t("5 mm lugs", "5-mm-Stollen", "Crampons de 5 mm"), text: t("Grip on mud, roots and wet rock.") } },
        { id: "trail-upper", fields: { icon: "leaf", title: t("Recycled upper", "Recyceltes Obermaterial", "Tige recyclée"), text: t("Woven from recycled bottles.") } },
      ],
      columns: "3",
    }),
  ]);
  await publishedSections(db, { productId: refs.products.guide.id }, t("The Trail Guide"), [
    node("guide-quotes", "testimonials", {
      title: t("What readers say", "Was Leser sagen", "Ce qu'en disent les lecteurs"),
      quotes: [
        { id: "guide-quote-1", fields: { quote: t("Every route I've tried from it has been a gem, and the maps are spot on."), author: "Jo M.", role: t("Hill walker") } },
        { id: "guide-quote-2", fields: { quote: t("The gear lists alone saved me from packing half my house."), author: "Dev R.", role: t("First-time backpacker") } },
      ],
    }),
    node("guide-faq", "faq", {
      title: t("About the book", "Über das Buch", "À propos du livre"),
      items: [
        { id: "guide-faq-routes", fields: { question: t("Which hikes does it cover?"), answer: t("Fifty classic day and overnight routes, each with a map, distances and the best season to go.") } },
        { id: "guide-faq-ebook", fields: { question: t("Is there an ebook?"), answer: t("Not yet. The print edition fits a jacket pocket and has a waterproof cover.") } },
      ],
    }),
  ]);
  await publishedSections(db, { categoryId: refs.categories.men.id }, t("Men", "Herren", "Homme"), [
    node("men-story", "image_with_text", {
      image: { url: photo("men-trail", 1200, 900), alt: t("A hiker in a shirt and trail shoes on a ridge") },
      title: t("Dressed for the trail", "Bereit für den Trail", "Paré pour le sentier"),
      body: t("Shirts that breathe on the climb and shoes that grip on the way down."),
      actions: [button("men-story-shoes", t("Shop shoes", "Schuhe ansehen", "Voir les chaussures"), categoryLink(refs.categories.menShoes.id))],
      imagePosition: "left",
    }),
  ]);
};

/** Components, the home, sale and about pages, the site header and footer, templates, and the sample storefront. */
export const seedBuilder = async (db: Database, refs: SeedRefs) => {
  await syncComponents(db, DEMO_COMPONENTS);
  if (!(await listFrontends(db)).length) {
    // The Next.js sample in storefront/ (pnpm dev there). Revalidation is set up in the admin.
    await createFrontend(db, { name: "Sample storefront", url: process.env.SAMPLE_STOREFRONT_URL ?? "http://localhost:3000", previewPath: "/api/draft", isDefault: true });
  }
  const product = (key: keyof SeedRefs["products"]) => toGlobalId("Product", refs.products[key].id);
  const category = (key: keyof SeedRefs["categories"]) => toGlobalId("Category", refs.categories[key].id);
  const build = (type: string, title: Record<string, string>, path: string | null, root: Omit<PageNode, "id" | "component">, seo: PageDocument["seo"] = {}) => publishedPage(db, type, title, path, root, seo);

  const sale = await build("landing_page", t("Summer sale", "Sommerschlussverkauf", "Soldes d'été"), "/summer-sale", {
    fields: {
      sections: [
        node("sale-hero", "hero", {
          eyebrow: t("Up to 20% off", "Bis zu 20 % Rabatt", "Jusqu'à -20 %"),
          title: t("The summer sale is on", "Der Sommerschlussverkauf läuft", "Les soldes d'été sont là"),
          subtitle: t("Shirts, tees and trail gear for long days outside. Use code SUMMER20 at checkout."),
          image: { url: photo("summer-sale"), alt: t("Hikers on a ridge at sunset") },
          actions: [button("sale-hero-shop", t("Shop the sale", "Zum Sale", "Voir les soldes"), categoryLink(refs.categories.menShirts.id))],
          theme: "dark",
        }, { variation: "full_bleed" }),
        node("sale-grid", "product_grid", { title: t("On sale now", "Jetzt reduziert", "En promotion"), source: "manual", products: [product("oxford"), product("tee"), product("socks"), product("tote")], limit: 4, columns: "4", showPrices: true }, { variation: "grid" }),
        node("sale-faq", "faq", {
          title: t("Sale questions"),
          items: [
            { id: "faq-code", fields: { question: t("How do I use the code?"), answer: t("Enter **SUMMER20** at checkout. It takes 20% off shirts and tops.") } },
            { id: "faq-returns", fields: { question: t("Can I return sale items?"), answer: t("Yes, within 30 days, like any order.") } },
          ],
        }),
      ],
    },
  }, { description: t("20% off shirts and tops for summer.") });

  const about = await build("landing_page", t("About us", "Über uns", "À propos"), "/about", {
    fields: {
      sections: [
        node("about-hero", "hero", { title: t("Durable outdoor basics", "Langlebige Outdoor-Basics", "Des basiques outdoor durables"), subtitle: t("We make fewer things, better: clothes and gear built to be worn for years."), theme: "light" }, { variation: "centered" }),
        node("about-story", "image_with_text", {
          image: { url: photo("workshop", 1200, 900), alt: t("Our workshop") },
          title: t("Made to last"),
          body: t("We started in 2019 with one shirt and a promise: **repair before replace**. Every product comes with free repairs for life."),
          imagePosition: "right",
        }),
        node("about-text", "rich_text", { content: t("## Our materials\n\n- Organic cotton from certified farms\n- Recycled canvas and merino wool\n- No virgin plastics in our packaging"), width: "narrow", align: "left" }),
      ],
    },
  });

  await build("landing_page", t("Home", "Startseite", "Accueil"), "/", {
    fields: {
      sections: [
        node("home-promo", "promo_banner", { text: t("Summer sale: 20% off shirts and tops", "Sommer-Sale: 20 % auf Hemden und Oberteile", "Soldes : -20 % sur les chemises"), code: "SUMMER20", link: pageLink(sale.id), tone: "sale" }),
        node("home-hero", "hero", {
          eyebrow: t("New season", "Neue Saison", "Nouvelle saison"),
          title: t("Built for the trail", "Gemacht für den Trail", "Conçu pour le sentier"),
          subtitle: t("Organic shirts, merino socks and waterproof shoes, designed to last for years.", "Bio-Hemden, Merinosocken und wasserdichte Schuhe – gemacht für Jahre.", "Chemises bio, chaussettes en mérinos et chaussures imperméables, faites pour durer."),
          image: { url: photo("hero-trail"), alt: t("A trail through the mountains") },
          actions: [button("home-hero-men", t("Shop men", "Herren", "Homme"), categoryLink(refs.categories.men.id)), button("home-hero-women", t("Shop women", "Damen", "Femme"), categoryLink(refs.categories.women.id), "secondary")],
          theme: "light",
        }, { variation: "split" }),
        node("home-categories", "category_tiles", {
          title: t("Shop by category", "Nach Kategorie", "Par catégorie"),
          tiles: [
            { id: "tile-shirts", fields: { category: category("menShirts"), image: { url: photo("tile-shirts", 800, 1000) } } },
            { id: "tile-tops", fields: { category: category("womenTops"), image: { url: photo("tile-tops", 800, 1000) } } },
            { id: "tile-shoes", fields: { category: category("menShoes"), image: { url: photo("tile-shoes", 800, 1000) } } },
            { id: "tile-accessories", fields: { category: category("accessories"), image: { url: photo("tile-accessories", 800, 1000) } } },
          ],
        }),
        node("home-new", "product_grid", { title: t("New arrivals", "Neu eingetroffen", "Nouveautés"), source: "newest", limit: 8, columns: "4", showPrices: true, link: categoryLink(refs.categories.men.id) }, { variation: "grid" }),
        node("home-story", "image_with_text", {
          image: { url: photo("story", 1200, 900), alt: t("Folded shirts on a workbench") },
          title: t("Repair before replace", "Reparieren statt ersetzen", "Réparer plutôt que remplacer"),
          body: t("Every piece comes with free repairs for life. Send it back, we fix it, you keep wearing it."),
          actions: [button("home-story-about", t("Our story", "Unsere Geschichte", "Notre histoire"), pageLink(about.id), "secondary")],
          imagePosition: "left",
        }),
        node("home-features", "feature_list", {
          title: t("Why shop with us"),
          features: [
            SHOP_PROMISES[0],
            SHOP_PROMISES[1],
            { id: "feat-materials", fields: { icon: "leaf", title: t("Organic materials", "Bio-Materialien"), text: t("Certified cotton and recycled fabrics.") } },
          ],
          columns: "3",
        }),
        node("home-quotes", "testimonials", {
          title: t("Loved on the trail"),
          quotes: [
            { id: "quote-1", fields: { quote: t("Three seasons in, my Trail Runners still grip like new."), author: "Sam K.", role: t("Thru-hiker") } },
            { id: "quote-2", fields: { quote: t("The softest merino socks I own. No blisters after 30 km."), author: "Priya N.", role: t("Weekend hiker") } },
          ],
        }),
        node("home-newsletter", "newsletter", { title: t("Get trail notes", "Trail-Notizen abonnieren", "Recevez nos notes"), text: t("New gear, repair tips and early access to sales. Once a month."), buttonLabel: t("Subscribe", "Abonnieren", "S'abonner"), consent: t("You can unsubscribe any time.") }),
      ],
    },
  }, { title: t("SpindleCommerce: durable outdoor basics"), description: t("Organic shirts, merino socks and waterproof shoes, designed to last for years.") });

  await build("site_header", t("Site header"), null, {
    fields: {
      announcement: { ...t("Free shipping on orders over $75", "Kostenloser Versand ab 60 €", "Livraison gratuite dès 60 €"), "en-GB": "Free EU delivery on orders over €60 / £52" },
      announcementLink: pageLink(sale.id),
      navigation: [
        { id: "nav-men", fields: { label: t("Men", "Herren", "Homme"), link: categoryLink(refs.categories.men.id) } },
        { id: "nav-women", fields: { label: t("Women", "Damen", "Femme"), link: categoryLink(refs.categories.women.id) } },
        { id: "nav-accessories", fields: { label: t("Accessories", "Accessoires", "Accessoires"), link: categoryLink(refs.categories.accessories.id) } },
        { id: "nav-sale", fields: { label: t("Sale", "Sale", "Soldes"), link: pageLink(sale.id), highlight: true } },
        { id: "nav-about", fields: { label: t("About", "Über uns", "À propos"), link: pageLink(about.id) } },
      ],
    },
  });

  await build("site_footer", t("Site footer"), null, {
    fields: {
      columns: [
        node("footer-shop", "footer_column", {
          title: t("Shop", "Shop", "Boutique"),
          links: [
            { id: "fl-men", fields: { label: t("Men", "Herren", "Homme"), link: categoryLink(refs.categories.men.id) } },
            { id: "fl-women", fields: { label: t("Women", "Damen", "Femme"), link: categoryLink(refs.categories.women.id) } },
            { id: "fl-books", fields: { label: t("Books", "Bücher", "Livres"), link: categoryLink(refs.categories.books.id) } },
          ],
        }),
        node("footer-company", "footer_column", {
          title: t("Company", "Unternehmen", "Entreprise"),
          links: [
            { id: "fl-about", fields: { label: t("About us", "Über uns", "À propos"), link: pageLink(about.id) } },
            { id: "fl-sale", fields: { label: t("Summer sale", "Sommer-Sale", "Soldes"), link: pageLink(sale.id) } },
          ],
        }),
      ],
      tagline: t("Durable outdoor basics since 2019."),
      legal: t("© 2026 SpindleCommerce demo store"),
    },
  });

  await seedTemplates(db, refs.categories);
  await seedSections(db, refs);
};

const SKUS = { oxford: "OXF-WHITE-S", tee: "TEE-BLACK-S", trailRunner: "TRL-BLACK-41", sneaker: "SNK-WHITE-40", tote: "TOTE-BLACK", socks: "SOCK-BLACK", guide: "BOOK-TRAIL-GUIDE", card: "GIFT-50" } as const;
const SLUGS = { men: "men", women: "women", menShirts: "men-s-shirts", womenTops: "women-s-tops", accessories: "accessories", books: "books", menShoes: "men-s-shoes", womenShoes: "women-s-shoes" } as const;

/** The demo products and categories in a database seeded earlier, by SKU and slug; null when any is gone. */
const findDemoRefs = async (db: Database): Promise<SeedRefs | null> => {
  const variants = await db.select({ sku: productVariants.sku, productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.sku, Object.values(SKUS)));
  const slugs = await db.select({ slug: categoryTranslations.slug, categoryId: categoryTranslations.categoryId }).from(categoryTranslations).where(and(eq(categoryTranslations.locale, "en-US"), inArray(categoryTranslations.slug, Object.values(SLUGS))));
  const products = Object.fromEntries(Object.entries(SKUS).map(([key, sku]) => [key, variants.find((v) => v.sku === sku) && { id: variants.find((v) => v.sku === sku)!.productId }]));
  const categories = Object.fromEntries(Object.entries(SLUGS).map(([key, slug]) => [key, slugs.find((c) => c.slug === slug) && { id: slugs.find((c) => c.slug === slug)!.categoryId }]));
  if (Object.values(products).some((p) => !p) || Object.values(categories).some((c) => !c)) return null;
  return { products, categories } as SeedRefs;
};

/**
 * Add the page builder demo to a database seeded before the builder existed. Returns false when
 * the library already has components or the demo catalog is not there.
 */
export const seedBuilderIntoExisting = async (db: Database) => {
  if (await db.$count(builderComponents)) return false;
  const refs = await findDemoRefs(db);
  if (!refs) return false;
  await seedBuilder(db, refs);
  return true;
};

const SLOTS: Record<TemplateFor, string> = { product: "product_sections", category: "category_sections" };
/** Where the demo templates place the slots: after these nodes. */
const DEMO_SLOTS = [
  { after: "pdp-specs", id: "pdp-own", component: "product_sections" },
  { after: "plp-subcategories", id: "plp-own", component: "category_sections" },
  { after: "women-subcategories", id: "women-own", component: "category_sections" },
];

/**
 * Add product and category sections to a page builder demo that predates them: the components, the
 * slots in the template types and demo templates, and the demo's own sections. A template whose
 * demo layout was changed is left alone. Returns false when the library is empty or already has
 * sections.
 */
export const seedSectionsIntoExisting = async (db: Database) => {
  const library = await loadDefinitions(db);
  if (!library.size || [...library.values()].some((d) => d.sectionsFor)) return false;
  const templates = [...library.values()]
    .filter((d) => d.kind === "content_type" && d.templateFor)
    .map((d) => {
      const slot = SLOTS[d.templateFor!];
      return { ...d, fields: d.fields.map((f) => (f.type === "blocks" && f.allowedComponents && !f.allowedComponents.includes(slot) ? { ...f, allowedComponents: [...f.allowedComponents, slot] } : f)) };
    });
  await syncComponents(db, [...DEMO_COMPONENTS.filter((d) => !library.has(d.code)), ...templates]);
  const actor = { staffId: null };
  const pages = templates.length ? await db.select().from(builderPages).where(inArray(builderPages.type, templates.map((d) => d.code))) : [];
  for (const page of pages) {
    const sections = (page.draft.root.fields.sections ?? []) as PageNode[];
    const at = sections.findIndex((n) => DEMO_SLOTS.some((s) => s.after === n.id));
    if (at < 0) continue;
    const slot = DEMO_SLOTS.find((s) => s.after === sections[at]!.id)!;
    // Publish the slot when the draft was the published version (an unchanged re-save counts).
    const live = !!page.published && isDeepStrictEqual(page.draft, page.published);
    const root = { ...page.draft.root, fields: { ...page.draft.root.fields, sections: [...sections.slice(0, at + 1), node(slot.id, slot.component, {}), ...sections.slice(at + 1)] } };
    const saved = await savePageDraft(db, page.id, { baseVersion: page.version, document: { ...page.draft, root } }, actor);
    if (live) await publishPage(db, saved.id, actor);
  }
  const refs = await findDemoRefs(db);
  if (refs) await seedSections(db, refs);
  return true;
};

/**
 * Add the product and category templates, and their missing components, to a page builder demo
 * that predates them. Returns false when template pages exist or the women's category is gone.
 */
export const seedTemplatesIntoExisting = async (db: Database) => {
  const existing = new Set((await db.select({ code: builderComponents.code }).from(builderComponents)).map((c) => c.code));
  if (!existing.size) return false;
  const templateTypes = DEMO_COMPONENTS.filter((d) => d.templateFor && d.kind === "content_type").map((d) => d.code);
  if (await db.$count(builderPages, inArray(builderPages.type, templateTypes))) return false;
  const [women] = await db.select({ categoryId: categoryTranslations.categoryId }).from(categoryTranslations).where(and(eq(categoryTranslations.locale, "en-US"), eq(categoryTranslations.slug, SLUGS.women)));
  if (!women) return false;
  const missing = DEMO_COMPONENTS.filter((d) => !existing.has(d.code));
  if (missing.length) await syncComponents(db, missing);
  await seedTemplates(db, { women: { id: women.categoryId } });
  return true;
};
