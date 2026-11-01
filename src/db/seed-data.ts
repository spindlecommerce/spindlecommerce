import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import type { Platform } from "../platform.ts";
import { createAttributeDefinition, createCategory, createProduct, createProductType } from "../modules/catalog/service.ts";
import { createChannel, setExchangeRate } from "../modules/channels/service.ts";
import { seedBuilder } from "./seed-builder.ts";
import { createAddress, createCustomerGroup, registerCustomer } from "../modules/customers/service.ts";
import { createStock, createStockLocation } from "../modules/inventory/service.ts";
import { createPaymentMethod } from "../modules/payments/service.ts";
import { createPromotion } from "../modules/promotions/service.ts";
import { createShippingMethod, createShippingZone } from "../modules/shipping/service.ts";
import { createRole, createStaffUser } from "../modules/staff/service.ts";
import { roles } from "../modules/staff/tables.ts";
import { createTaxClass, createTaxRate, createTaxRule } from "../modules/tax/service.ts";

/** Without `adminEmail` and `adminPassword` no staff user is created (the first admin exists already). */
export type SeedCredentials = { adminEmail?: string; adminPassword?: string; customerEmail: string; customerPassword: string };

export type SeedResult = Awaited<ReturnType<typeof seedDemoData>>;

const t = (en: string, de: string, fr: string) => ({ "en-US": en, "en-GB": en, "de-DE": de, "fr-FR": fr });

/**
 * Two channels (US with tax-exclusive USD prices, EU with tax-inclusive EUR and GBP), configurable
 * apparel, a virtual gift card, tax, shipping, payments, promotions and the page builder demo.
 */
export const seedDemoData = async (platform: Pick<Platform, "db" | "payments">, credentials: SeedCredentials) => {
  const db: Database = platform.db;

  // Tax
  const standard = await createTaxClass(db, { code: "standard", name: "Standard rate", kind: "product" });
  const reduced = await createTaxClass(db, { code: "reduced", name: "Reduced rate", kind: "product" });
  const retail = await createTaxClass(db, { code: "retail", name: "Retail customer", kind: "customer" });
  const wholesaleClass = await createTaxClass(db, { code: "wholesale", name: "Wholesale customer", kind: "customer" });
  const rates = {
    ca: await createTaxRate(db, { code: "US-CA", name: "California sales tax", countryCode: "US", regionCode: "CA", rate: 7.25 }),
    ny: await createTaxRate(db, { code: "US-NY", name: "New York sales tax", countryCode: "US", regionCode: "NY", rate: 8.875 }),
    de: await createTaxRate(db, { code: "DE-19", name: "MwSt. 19%", countryCode: "DE", rate: 19 }),
    deReduced: await createTaxRate(db, { code: "DE-7", name: "MwSt. 7%", countryCode: "DE", rate: 7 }),
    fr: await createTaxRate(db, { code: "FR-20", name: "TVA 20%", countryCode: "FR", rate: 20 }),
    frReduced: await createTaxRate(db, { code: "FR-5.5", name: "TVA 5,5%", countryCode: "FR", rate: 5.5 }),
    gb: await createTaxRate(db, { code: "GB-20", name: "VAT 20%", countryCode: "GB", rate: 20 }),
  };
  await createTaxRule(db, { name: "Standard goods", productTaxClassIds: [standard.id], customerTaxClassIds: [retail.id, wholesaleClass.id], taxRateIds: [rates.ca.id, rates.ny.id, rates.de.id, rates.fr.id, rates.gb.id] });
  await createTaxRule(db, { name: "Reduced goods", productTaxClassIds: [reduced.id], customerTaxClassIds: [retail.id, wholesaleClass.id], taxRateIds: [rates.deReduced.id, rates.frReduced.id, rates.ca.id, rates.ny.id] });

  // Customer groups
  const guest = await createCustomerGroup(db, { code: "guest", name: "Not signed in", taxClassId: retail.id });
  const general = await createCustomerGroup(db, { code: "general", name: "General", taxClassId: retail.id });
  const wholesale = await createCustomerGroup(db, { code: "wholesale", name: "Wholesale", taxClassId: wholesaleClass.id });

  // Inventory
  const usEast = await createStockLocation(db, { code: "us-east", name: "Newark warehouse", address: { city: "Newark", regionCode: "NJ", countryCode: "US", postalCode: "07102" } });
  const euCentral = await createStockLocation(db, { code: "eu-central", name: "Berlin warehouse", address: { city: "Berlin", countryCode: "DE", postalCode: "10115" } });
  const usStock = await createStock(db, { code: "us", name: "US stock", locations: [{ locationId: usEast.id }] });
  const euStock = await createStock(db, { code: "eu", name: "EU stock", locations: [{ locationId: euCentral.id }] });

  // Channels
  const us = await createChannel(db, {
    code: "us", name: "Ecom US", defaultLocale: "en-US", locales: ["en-US"], defaultCurrency: "USD", currencies: ["USD"],
    countries: ["US", "CA"], stockId: usStock.id, pricesIncludeTax: false, shippingTaxClassId: null, orderNumberPrefix: "US-",
  });
  const eu = await createChannel(db, {
    code: "eu", name: "Ecom Europe", defaultLocale: "de-DE", locales: ["de-DE", "en-GB", "fr-FR"], defaultCurrency: "EUR", currencies: ["EUR", "GBP"],
    countries: ["DE", "FR", "AT", "NL", "GB"], stockId: euStock.id, pricesIncludeTax: true, shippingTaxClassId: standard.id, orderNumberPrefix: "EU-",
  });
  await setExchangeRate(db, "EUR", "GBP", 0.86);

  // Attributes and product types
  const option = (code: string, en: string, de: string, fr: string, swatch?: string) => ({ code, label: t(en, de, fr), swatch: swatch ?? null });
  await createAttributeDefinition(db, {
    code: "brand", label: t("Brand", "Marke", "Marque"), type: "select", isFilterable: true, isSearchable: true, position: 1,
    options: [option("acme", "Acme", "Acme", "Acme"), option("northwind", "Northwind", "Northwind", "Northwind"), option("contoso", "Contoso", "Contoso", "Contoso")],
  });
  await createAttributeDefinition(db, {
    code: "color", label: t("Color", "Farbe", "Couleur"), type: "select", isFilterable: true, isSearchable: true, position: 2,
    options: [option("black", "Black", "Schwarz", "Noir", "#111111"), option("white", "White", "Weiß", "Blanc", "#ffffff"), option("red", "Red", "Rot", "Rouge", "#c62828"), option("blue", "Blue", "Blau", "Bleu", "#1565c0"), option("green", "Green", "Grün", "Vert", "#2e7d32")],
  });
  await createAttributeDefinition(db, {
    code: "size", label: t("Size", "Größe", "Taille"), type: "select", isFilterable: true, position: 3,
    options: ["xs", "s", "m", "l", "xl", "40", "41", "42", "43", "44"].map((s) => option(s, s.toUpperCase(), s.toUpperCase(), s.toUpperCase())),
  });
  await createAttributeDefinition(db, {
    code: "gender", label: t("Gender", "Geschlecht", "Genre"), type: "select", isFilterable: true, position: 4,
    options: [option("men", "Men", "Herren", "Homme"), option("women", "Women", "Damen", "Femme"), option("unisex", "Unisex", "Unisex", "Unisexe")],
  });
  await createAttributeDefinition(db, { code: "material", label: t("Material", "Material", "Matière"), type: "text", isLocalized: true, isSearchable: true, position: 5 });
  await createAttributeDefinition(db, { code: "waterproof", label: t("Waterproof", "Wasserdicht", "Imperméable"), type: "boolean", isFilterable: true, position: 6 });
  await createAttributeDefinition(db, { code: "pages", label: t("Pages", "Seiten", "Pages"), type: "number", position: 7 });

  const apparel = await createProductType(db, { code: "apparel", name: "Apparel", attributeCodes: ["brand", "gender", "material"], variantAttributeCodes: ["color", "size"], taxClassId: standard.id });
  const footwear = await createProductType(db, { code: "footwear", name: "Footwear", attributeCodes: ["brand", "gender", "waterproof"], variantAttributeCodes: ["color", "size"], taxClassId: standard.id });
  const accessory = await createProductType(db, { code: "accessory", name: "Accessory", attributeCodes: ["brand", "material"], variantAttributeCodes: ["color"], taxClassId: standard.id });
  const book = await createProductType(db, { code: "book", name: "Book", attributeCodes: ["brand", "pages"], taxClassId: reduced.id });
  const giftCard = await createProductType(db, { code: "gift_card", name: "Gift card", isShippable: false });

  // Categories
  const cat = (name: [string, string, string], parentId?: string) =>
    createCategory(db, {
      parentId: parentId ?? null,
      translations: [
        { locale: "en-US", name: name[0] },
        { locale: "en-GB", name: name[0] },
        { locale: "de-DE", name: name[1] },
        { locale: "fr-FR", name: name[2] },
      ],
    });
  const men = await cat(["Men", "Herren", "Homme"]);
  const women = await cat(["Women", "Damen", "Femme"]);
  const menShirts = await cat(["Men's Shirts", "Herrenhemden", "Chemises homme"], men.id);
  const menShoes = await cat(["Men's Shoes", "Herrenschuhe", "Chaussures homme"], men.id);
  const womenTops = await cat(["Women's Tops", "Damenoberteile", "Hauts femme"], women.id);
  const womenShoes = await cat(["Women's Shoes", "Damenschuhe", "Chaussures femme"], women.id);
  const accessories = await cat(["Accessories", "Accessoires", "Accessoires"]);
  const books = await cat(["Books", "Bücher", "Livres"]);

  const listings = [{ channelId: us.id }, { channelId: eu.id }];
  const price = (usd: string, eur: string, extra: Record<string, unknown>[] = []) => [
    { channelId: us.id, currency: "USD", amount: usd },
    { channelId: eu.id, currency: "EUR", amount: eur },
    ...extra,
  ];
  const stock = (us: number, euQty: number) => [{ locationId: usEast.id, quantity: us }, { locationId: euCentral.id, quantity: euQty }];
  const grid = (skuBase: string, colors: string[], sizes: string[], prices: Record<string, unknown>[], qty: [number, number]) =>
    colors.flatMap((color) => sizes.map((size) => ({ sku: `${skuBase}-${color.toUpperCase()}-${size.toUpperCase()}`, attributes: { color, size }, weightGrams: 250, prices, stock: stock(...qty) })));

  // Placeholder photos, seeded so they stay the same between runs.
  const photo = (seed: string, alt: string, variantSku?: string) => ({ url: `https://picsum.photos/seed/ecom-${seed}/800/1000`, alt: { "en-US": alt }, ...(variantSku ? { variantSku } : {}) });

  const oxford = await createProduct(db, {
    productTypeId: apparel.id, status: "active", categoryIds: [menShirts.id], channelListings: listings,
    attributes: { brand: "northwind", gender: "men", material: { "en-US": "Organic cotton", "en-GB": "Organic cotton", "de-DE": "Bio-Baumwolle", "fr-FR": "Coton bio" } },
    translations: [
      { locale: "en-US", name: "Oxford Shirt", description: "<p>A crisp button-down oxford in organic cotton.</p>" },
      { locale: "en-GB", name: "Oxford Shirt", description: "<p>A crisp button-down oxford in organic cotton.</p>" },
      { locale: "de-DE", name: "Oxford-Hemd", description: "<p>Ein klassisches Button-down-Hemd aus Bio-Baumwolle.</p>" },
      { locale: "fr-FR", name: "Chemise Oxford", description: "<p>Une chemise oxford en coton bio.</p>" },
    ],
    variants: grid("OXF", ["white", "blue"], ["s", "m", "l"], price("59.00", "59.00", [{ channelId: us.id, currency: "USD", amount: "49.00", customerGroupId: wholesale.id }]), [25, 15]),
    media: [photo("oxford-white", "White oxford shirt", "OXF-WHITE-M"), photo("oxford-blue", "Blue oxford shirt")],
  });
  const tee = await createProduct(db, {
    productTypeId: apparel.id, status: "active", categoryIds: [menShirts.id, womenTops.id], channelListings: listings,
    attributes: { brand: "acme", gender: "unisex", material: { "en-US": "Cotton jersey", "de-DE": "Baumwolljersey", "fr-FR": "Jersey de coton" } },
    translations: [
      { locale: "en-US", name: "Everyday Tee", description: "<p>Soft cotton jersey tee for every day.</p>" },
      { locale: "de-DE", name: "Alltags-T-Shirt", description: "<p>Weiches T-Shirt aus Baumwolljersey.</p>" },
      { locale: "fr-FR", name: "T-shirt quotidien", description: "<p>T-shirt doux en jersey de coton.</p>" },
    ],
    variants: grid("TEE", ["black", "white", "red"], ["s", "m", "l", "xl"], price("25.00", "24.00", [
      { channelId: us.id, currency: "USD", amount: "22.00", minQuantity: 5 },
      { channelId: us.id, currency: "USD", amount: "25.00", compareAtAmount: "30.00" },
    ]), [40, 30]),
    media: [photo("tee", "Everyday tee")],
  });
  const trailRunner = await createProduct(db, {
    productTypeId: footwear.id, status: "active", categoryIds: [menShoes.id, womenShoes.id], channelListings: listings,
    attributes: { brand: "contoso", gender: "unisex", waterproof: true },
    translations: [
      { locale: "en-US", name: "Trail Runner GTX", description: "<p>Waterproof trail running shoe with a grippy outsole.</p>" },
      { locale: "de-DE", name: "Trail Runner GTX", description: "<p>Wasserdichter Trailrunning-Schuh mit griffiger Sohle.</p>" },
      { locale: "fr-FR", name: "Trail Runner GTX", description: "<p>Chaussure de trail imperméable.</p>" },
    ],
    variants: grid("TRL", ["black", "green"], ["41", "42", "43", "44"], price("139.00", "149.00", [{ channelId: eu.id, currency: "GBP", amount: "125.00" }]), [6, 4]),
    media: [photo("trail-runner", "Trail running shoe")],
  });
  const sneaker = await createProduct(db, {
    productTypeId: footwear.id, status: "active", categoryIds: [womenShoes.id], channelListings: listings,
    attributes: { brand: "acme", gender: "women", waterproof: false },
    translations: [
      { locale: "en-US", name: "Canvas Sneaker", description: "<p>Lightweight canvas sneaker.</p>" },
      { locale: "de-DE", name: "Canvas-Sneaker", description: "<p>Leichter Sneaker aus Canvas.</p>" },
      { locale: "fr-FR", name: "Basket en toile", description: "<p>Basket légère en toile.</p>" },
    ],
    variants: grid("SNK", ["white", "red"], ["40", "41", "42"], price("69.00", "69.00"), [12, 0]),
    media: [photo("sneaker", "Canvas sneaker")],
  });
  const tote = await createProduct(db, {
    productTypeId: accessory.id, status: "active", categoryIds: [accessories.id], channelListings: listings,
    attributes: { brand: "northwind", material: { "en-US": "Recycled canvas", "de-DE": "Recyceltes Canvas", "fr-FR": "Toile recyclée" } },
    translations: [
      { locale: "en-US", name: "Market Tote", description: "<p>Roomy tote bag in recycled canvas.</p>" },
      { locale: "de-DE", name: "Markttasche", description: "<p>Geräumige Tasche aus recyceltem Canvas.</p>" },
      { locale: "fr-FR", name: "Cabas du marché", description: "<p>Grand cabas en toile recyclée.</p>" },
    ],
    variants: ["black", "green"].map((color) => ({ sku: `TOTE-${color.toUpperCase()}`, attributes: { color }, weightGrams: 400, prices: price("35.00", "32.00"), stock: stock(50, 50) })),
    media: [photo("tote", "Market tote bag")],
  });
  const socks = await createProduct(db, {
    productTypeId: accessory.id, status: "active", categoryIds: [accessories.id], channelListings: listings,
    attributes: { brand: "acme", material: { "en-US": "Merino wool", "de-DE": "Merinowolle", "fr-FR": "Laine mérinos" } },
    translations: [
      { locale: "en-US", name: "Merino Hiking Socks", description: "<p>Cushioned merino socks for long days on the trail.</p>" },
      { locale: "de-DE", name: "Merino-Wandersocken", description: "<p>Gepolsterte Merinosocken.</p>" },
      { locale: "fr-FR", name: "Chaussettes de randonnée mérinos", description: "<p>Chaussettes en mérinos rembourrées.</p>" },
    ],
    variants: ["black", "blue"].map((color) => ({ sku: `SOCK-${color.toUpperCase()}`, attributes: { color }, weightGrams: 80, prices: price("18.00", "17.00"), stock: stock(200, 200) })),
    media: [photo("socks", "Merino hiking socks")],
  });
  const guide = await createProduct(db, {
    productTypeId: book.id, status: "active", categoryIds: [books.id], channelListings: listings,
    attributes: { brand: "contoso", pages: 320 },
    translations: [
      { locale: "en-US", name: "The Trail Guide", description: "<p>Routes, gear lists and maps for 50 classic hikes.</p>" },
      { locale: "de-DE", name: "Der Wanderführer", description: "<p>Routen, Packlisten und Karten für 50 Touren.</p>" },
      { locale: "fr-FR", name: "Le guide des sentiers", description: "<p>Itinéraires et cartes pour 50 randonnées.</p>" },
    ],
    variants: [{ sku: "BOOK-TRAIL-GUIDE", weightGrams: 600, prices: price("24.00", "22.00"), stock: stock(30, 30) }],
    media: [photo("trail-guide", "The Trail Guide book")],
  });
  const card = await createProduct(db, {
    productTypeId: giftCard.id, status: "active", channelListings: listings,
    translations: [
      { locale: "en-US", name: "Digital Gift Card", description: "<p>Delivered by email.</p>" },
      { locale: "de-DE", name: "Digitaler Geschenkgutschein", description: "<p>Per E-Mail zugestellt.</p>" },
      { locale: "fr-FR", name: "Carte cadeau numérique", description: "<p>Envoyée par e-mail.</p>" },
    ],
    variants: [{ sku: "GIFT-50", trackInventory: false, prices: price("50.00", "50.00") }],
    media: [photo("gift-card", "Digital gift card")],
  });
  await createProduct(db, {
    productTypeId: apparel.id, status: "draft", categoryIds: [womenTops.id], channelListings: listings,
    attributes: { brand: "acme", gender: "women" },
    translations: [{ locale: "en-US", name: "Linen Blouse (coming soon)" }],
    variants: [{ sku: "BLS-WHITE-M", attributes: { color: "white", size: "m" }, prices: price("79.00", "79.00"), stock: stock(10, 10) }],
  });

  // Shipping
  const usZone = await createShippingZone(db, { name: "United States", countries: ["US"] });
  const caZone = await createShippingZone(db, { name: "Canada", countries: ["CA"] });
  const euZone = await createShippingZone(db, { name: "European Union", countries: ["DE", "FR", "AT", "NL"] });
  const ukZone = await createShippingZone(db, { name: "United Kingdom", countries: ["GB"] });
  await createShippingMethod(db, { code: "us_standard", name: { "en-US": "Standard (5–7 days)" }, zoneId: usZone.id, channelIds: [us.id], config: { kind: "flat_rate", amounts: { USD: 599 }, per: "order" }, minDeliveryDays: 5, maxDeliveryDays: 7, position: 1 });
  await createShippingMethod(db, {
    code: "us_express", name: { "en-US": "Express (1–2 days)" }, zoneId: usZone.id, channelIds: [us.id], minDeliveryDays: 1, maxDeliveryDays: 2, position: 2,
    config: { kind: "table_rate", basis: "weight", tiers: [{ from: 0, amounts: { USD: 1499 } }, { from: 2000, amounts: { USD: 2499 } }, { from: 5000, amounts: { USD: 3999 } }] },
  });
  await createShippingMethod(db, { code: "us_free", name: { "en-US": "Free shipping over $75" }, zoneId: usZone.id, channelIds: [us.id], config: { kind: "free", minimumSubtotals: { USD: 7500 } }, minDeliveryDays: 5, maxDeliveryDays: 8, position: 0 });
  await createShippingMethod(db, { code: "ca_standard", name: { "en-US": "Canada Post" }, zoneId: caZone.id, channelIds: [us.id], config: { kind: "flat_rate", amounts: { USD: 1500 }, per: "order" }, position: 1 });
  await createShippingMethod(db, {
    code: "eu_standard", name: { "de-DE": "Standardversand", "en-GB": "Standard delivery", "fr-FR": "Livraison standard" }, zoneId: euZone.id, channelIds: [eu.id],
    config: { kind: "flat_rate", amounts: { EUR: 490, GBP: 425 }, per: "order" }, minDeliveryDays: 2, maxDeliveryDays: 4, position: 1,
  });
  await createShippingMethod(db, { code: "eu_free", name: { "de-DE": "Kostenloser Versand", "en-GB": "Free delivery", "fr-FR": "Livraison offerte" }, zoneId: euZone.id, channelIds: [eu.id], config: { kind: "free", minimumSubtotals: { EUR: 6000, GBP: 5200 } }, position: 0 });
  await createShippingMethod(db, { code: "uk_standard", name: { "en-GB": "Royal Mail" }, zoneId: ukZone.id, channelIds: [eu.id], config: { kind: "flat_rate", amounts: { GBP: 395, EUR: 450 }, per: "order" }, position: 1 });

  // Payments
  await createPaymentMethod(db, platform.payments, { code: "card", name: { "en-US": "Credit card", "de-DE": "Kreditkarte", "en-GB": "Card", "fr-FR": "Carte bancaire" }, provider: "test_gateway", config: { captureMode: "authorize" }, position: 0 });
  await createPaymentMethod(db, platform.payments, { code: "card_instant", name: { "en-US": "Card (instant capture)" }, provider: "test_gateway", config: { captureMode: "authorize_capture" }, position: 1 });
  await createPaymentMethod(db, platform.payments, { code: "checkmo", name: { "en-US": "Check / money order" }, provider: "offline", channelIds: [us.id], countries: ["US"], config: { instructions: { "en-US": "Make checks payable to Ecom Inc." } }, position: 2 });
  await createPaymentMethod(db, platform.payments, { code: "banktransfer", name: { "de-DE": "Vorkasse (Überweisung)", "en-GB": "Bank transfer", "fr-FR": "Virement bancaire" }, provider: "offline", channelIds: [eu.id], config: { instructions: { "de-DE": "IBAN DE00 0000 0000 0000 0000 00", "en-GB": "IBAN DE00 0000 0000 0000 0000 00" } }, position: 2 });
  await createPaymentMethod(db, platform.payments, { code: "cod", name: { "en-US": "Cash on delivery" }, provider: "offline", channelIds: [us.id], countries: ["US"], config: { maximumTotals: { USD: 50000 } }, position: 3 });

  // Promotions
  await createPromotion(db, { name: "10% off orders over $150 / €150", priority: 10, conditions: { type: "subtotal", operator: "gte", amounts: { USD: 15000, EUR: 15000, GBP: 13000 } }, action: { type: "percentage_off", percent: 10 } });
  await createPromotion(db, { name: "Summer sale: 20% off shirts", priority: 5, requiresCoupon: true, couponCodes: ["SUMMER20"], conditions: { type: "line_matches", predicate: { type: "category_in", categoryIds: [menShirts.id, womenTops.id] } }, action: { type: "percentage_off", percent: 20, target: { type: "category_in", categoryIds: [menShirts.id, womenTops.id] } } });
  await createPromotion(db, { name: "Socks: buy 2, get 1 free", priority: 20, conditions: { type: "line_matches", predicate: { type: "product_in", productIds: [socks.id] }, minQuantity: 3 }, action: { type: "buy_x_get_y", buyQuantity: 2, getQuantity: 1, percent: 100, target: { type: "product_in", productIds: [socks.id] } } });
  await createPromotion(db, { name: "Free shipping code", priority: 30, requiresCoupon: true, couponCodes: ["FREESHIP"], action: { type: "shipping_off", percent: 100 } });
  await createPromotion(db, { name: "Wholesale 5%", priority: 40, customerGroupIds: [wholesale.id], action: { type: "percentage_off", percent: 5 } });

  // Page builder
  await seedBuilder(db, {
    products: { oxford, tee, trailRunner, sneaker, tote, socks, guide, card },
    categories: { men, women, menShirts, womenTops, accessories, books, menShoes, womenShoes },
  });

  // Staff and a demo customer. A deployment's first admin comes with the admin role already.
  const role = async (code: string, name: string, permissions: string[]) => (await db.query.roles.findFirst({ where: eq(roles.code, code) })) ?? (await createRole(db, { code, name, permissions }));
  const adminRole = await role("admin", "Administrator", ["*"]);
  await role("fulfillment", "Fulfillment", ["orders:write", "inventory:write", "catalog:read", "customers:read"]);
  const admin = credentials.adminEmail && credentials.adminPassword ? await createStaffUser(db, { email: credentials.adminEmail, password: credentials.adminPassword, name: "Admin", roleIds: [adminRole.id] }) : null;
  const customer = await registerCustomer(db, { email: credentials.customerEmail, password: credentials.customerPassword, firstName: "Alex", lastName: "Rivera", acceptsMarketing: true });
  await createAddress(db, customer.id, { firstName: "Alex", lastName: "Rivera", line1: "1 Market St", city: "San Francisco", region: "California", regionCode: "CA", postalCode: "94105", countryCode: "US", phone: "+1 415 555 0100" });

  return {
    channels: { us, eu },
    groups: { guest, general, wholesale },
    stocks: { usStock, euStock },
    locations: { usEast, euCentral },
    taxClasses: { standard, reduced },
    categories: { men, women, menShirts, menShoes, womenTops, womenShoes, accessories, books },
    products: { oxford, tee, trailRunner, sneaker, tote, socks, guide, card },
    admin,
    customer,
  };
};
