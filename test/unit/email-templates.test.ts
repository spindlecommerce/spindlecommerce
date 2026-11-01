import { describe, expect, it } from "vitest";
import { customerResetUrl } from "../../plugins/email/service.ts";
import { parseAddresses } from "../../plugins/email/settings.ts";
import {
  addressLines,
  customerPasswordReset,
  formatMoney,
  lowStock,
  orderCanceled,
  orderConfirmation,
  orderRefunded,
  orderShipped,
  safeColor,
  sampleOrder,
  staffNewOrder,
  trackingUrl,
  type Brand,
} from "../../plugins/email/templates.ts";

const brand: Brand = { storeName: "Ecom US", logoUrl: null, accentColor: "#111827", storefrontUrl: "https://shop.example.test/", replyTo: true };

describe("email rendering", () => {
  it("escapes every dynamic value in the HTML", () => {
    const order = sampleOrder("en-US");
    order.number = "<b>1</b>";
    order.lines[0]!.name = `<script>alert("x")</script>`;
    order.lines[0]!.variantAttributes = { color: `"><img src=x onerror=alert(1)>` };
    order.billingAddress = { ...order.billingAddress!, firstName: "Sam & <i>Co</i>" };
    order.shippingAddress = { ...order.shippingAddress!, line1: "1 <Main> St" };
    const evil: Brand = { ...brand, storeName: `Shop "&" <Co>`, logoUrl: "javascript:alert(1)", accentColor: "red;background:url(https://evil.test/x)" };

    const { html, text, subject } = orderConfirmation({ order, brand: evil });
    expect(html).not.toMatch(/<script|<img src=x|<i>Co|<b>1|javascript:|evil\.test/);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Hi Sam &amp; &lt;i&gt;Co&lt;/i&gt;,");
    expect(html).toContain("1 &lt;Main&gt; St");
    expect(html).toContain("Shop &quot;&amp;&quot; &lt;Co&gt;");
    expect(html).toContain("#111827"); // the invalid accent color fell back to the default
    // Subjects and plain text are not HTML: they keep the characters as typed.
    expect(subject).toBe("Order <b>1</b> confirmed");
    expect(text).toContain(`<script>alert("x")</script>`);
  });

  it("only links http(s) tracking URLs", () => {
    const order = sampleOrder("en-US");
    const shipment = { number: "FUL-1", tracking: [{ carrier: "Acme", number: "X1", url: "javascript:alert(1)" }], lines: [] };
    const { html } = orderShipped({ order, shipment, complete: true, brand });
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<strong>X1</strong>");
  });

  it("speaks the order's language and falls back to English", () => {
    expect(orderConfirmation({ order: sampleOrder("de-DE"), brand }).subject).toBe("Bestellung 100123 bestätigt");
    expect(orderConfirmation({ order: sampleOrder("fr-FR"), brand }).subject).toBe("Commande 100123 confirmée");
    expect(orderConfirmation({ order: sampleOrder("en-GB"), brand }).subject).toBe("Order 100123 confirmed");
    expect(orderConfirmation({ order: sampleOrder("es-ES"), brand }).subject).toBe("Order 100123 confirmed");

    const german = orderConfirmation({ order: sampleOrder("de-DE"), brand });
    expect(german.html).toContain('<html lang="de">');
    expect(german.html).toContain("Hallo Mia,");
    expect(german.html).toContain("Enthaltene MwSt."); // tax-inclusive prices
    expect(german.text).toContain("Fragen? Antworten Sie einfach auf diese E-Mail.");
    expect(orderCanceled({ order: sampleOrder("fr-FR"), declined: true, brand }).text).toContain("Le paiement n'a pas abouti");
    expect(orderShipped({ order: sampleOrder("de-DE"), shipment: sampleOrder("de-DE").fulfillments[0]!, complete: false, brand }).text).toContain("Ein Teil Ihrer Bestellung ist unterwegs");
  });

  it("formats money per locale and currency", () => {
    expect(formatMoney(7163, "USD", "en-US")).toBe("$71.63");
    expect(formatMoney(6719, "EUR", "de-DE")).toMatch(/^67,19\s€$/);
    expect(formatMoney(6719, "EUR", "fr-FR")).toMatch(/^67,19\s€$/);
    expect(formatMoney(123456, "GBP", "en-GB")).toBe("£1,234.56");
    expect(formatMoney(1234, "JPY", "en-US")).toBe("¥1,234");
    expect(formatMoney(1234, "BHD", "en-US")).toMatch(/^BHD\s1\.234$/);
    expect(formatMoney(-680, "USD", "en-US")).toBe("-$6.80");
    expect(formatMoney(100, "USD", "not a locale!")).toBe("$1.00");

    const us = orderConfirmation({ order: sampleOrder("en-US"), brand });
    expect(us.text).toContain("Total: $71.63");
    expect(us.text).toContain("Discount: -$6.80");
    expect(us.text).toContain("Shipping (Standard (5–7 days)): $5.99");
    expect(us.text).toContain("Tax: $4.44");
    expect(us.text).toContain("2 × Organic cotton tee (Black / M)  $50.00");
    expect(orderRefunded({ order: sampleOrder("de-DE"), amount: 2500, refundNumber: "REF-000001", brand }).text).toMatch(/Wir haben 25,00\s€ auf Ihre ursprüngliche Zahlungsart erstattet/);
  });

  it("links tracking numbers to the carrier", () => {
    expect(trackingUrl({ carrier: "UPS", number: "1Z 999" })).toBe("https://www.ups.com/track?tracknum=1Z%20999");
    expect(trackingUrl({ carrier: "Royal Mail", number: "AB123456789GB" })).toBe("https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB");
    expect(trackingUrl({ carrier: "DHL Express", number: "123" })).toContain("dhl.com");
    expect(trackingUrl({ carrier: "DHL Paket", number: "123" })).toContain("dhl.de");
    expect(trackingUrl({ carrier: "UPS", number: "1", url: "https://track.example.test/1" })).toBe("https://track.example.test/1");
    expect(trackingUrl({ carrier: "Local courier", number: "42" })).toBeNull();

    const order = sampleOrder("en-US");
    const one = orderShipped({ order, shipment: { number: "FUL-1", tracking: [{ carrier: "UPS", number: "1Z999AA10123456784" }], lines: [{ orderLineId: order.lines[0]!.id, quantity: 1 }] }, complete: true, brand });
    expect(one.subject).toBe("Your order 100123 has shipped");
    expect(one.html).toContain('href="https://www.ups.com/track?tracknum=1Z999AA10123456784"');
    expect(one.html).toContain("Track your parcel");
    expect(one.text).toContain("Tracking (UPS): 1Z999AA10123456784\nhttps://www.ups.com/track?tracknum=1Z999AA10123456784");
    expect(one.text).toContain("1 × Organic cotton tee (Black / M)");
    expect(one.text).not.toContain("Canvas tote"); // only what this shipment holds

    const two = orderShipped({ order, shipment: { number: "FUL-2", tracking: [{ carrier: "UPS", number: "A" }, { carrier: "FedEx", number: "B" }], lines: [] }, complete: false, brand });
    expect(two.html).not.toContain("Track your parcel"); // one button only makes sense for one parcel
    expect(two.html).toContain("https://www.fedex.com/fedextrack/?trknbr=B");
    expect(two.text).toContain("Part of your order is on its way.");
  });

  it("writes addresses the way each country does", () => {
    const base = { firstName: "A", lastName: "B", line1: "1 Road" };
    expect(addressLines({ ...base, city: "San Francisco", regionCode: "CA", postalCode: "94105", countryCode: "US" }, "en-US")).toEqual(["A B", "1 Road", "San Francisco, CA 94105", "United States"]);
    expect(addressLines({ ...base, city: "Berlin", postalCode: "10117", countryCode: "DE" }, "de-DE")).toEqual(["A B", "1 Road", "10117 Berlin", "Deutschland"]);
    expect(addressLines({ ...base, company: "Acme", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" }, "en-GB")).toEqual(["A B", "Acme", "1 Road", "London", "SW1A 1AA", "United Kingdom"]);
  });

  it("builds password reset links and staff emails", () => {
    expect(customerResetUrl("https://shop.test/reset?t={token}&e={email}", null, { token: "pr_a b", email: "x+y@example.test" })).toBe("https://shop.test/reset?t=pr_a%20b&e=x%2By%40example.test");
    expect(customerResetUrl(null, "https://shop.test/", { token: "pr_1", email: "x@example.test" })).toBe("https://shop.test/account/reset-password?token=pr_1");
    expect(customerResetUrl(null, null, { token: "pr_1", email: "x@example.test" })).toBeNull();
    expect(customerResetUrl("javascript:alert('{token}')", null, { token: "pr_1", email: "x@example.test" })).toBeNull();

    const reset = customerPasswordReset({ name: "Mia", url: "https://shop.test/account/reset-password?token=pr_1&x=1", brand, locale: "de-DE" });
    expect(reset.subject).toBe("Passwort zurücksetzen");
    expect(reset.html).toContain('href="https://shop.test/account/reset-password?token=pr_1&amp;x=1"');
    expect(reset.text).toContain("Neues Passwort wählen:\nhttps://shop.test/account/reset-password?token=pr_1&x=1");

    const notice = staffNewOrder({ order: sampleOrder("de-DE"), channelName: "Ecom Europe", adminUrl: "https://api.test/admin/orders/100123", brand, locale: "en" });
    expect(notice.subject).toMatch(/^New order 100123 \(€67\.19\)$/);
    expect(notice.text).toContain("Mia Schmidt (customer@example.com) placed order 100123 for €67.19 in Ecom Europe.");

    const alert = lowStock({ item: { sku: "TEE-1", name: "Tee", quantity: 2, location: "Berlin" }, threshold: 5, adminUrl: "https://api.test/admin/inventory?q=TEE-1", brand, locale: "fr-FR" });
    expect(alert.subject).toBe("Stock bas : TEE-1 (reste 2)");
  });

  it("parses address lists and colors", () => {
    expect(parseAddresses(" A@example.test, b@example.test;a@example.test  nope ")).toEqual(["a@example.test", "b@example.test"]);
    expect(parseAddresses(undefined)).toEqual([]);
    expect(safeColor("#ABC")).toBe("#abc");
    expect(safeColor("blue")).toBe("#111827");
  });

  it("keeps the layout responsive", () => {
    const { html } = orderConfirmation({ order: sampleOrder("en-US"), brand: { ...brand, logoUrl: "https://cdn.example.test/logo.png" } });
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain("max-width:600px");
    expect(html).toContain('<img src="https://cdn.example.test/logo.png" alt="Ecom US"');
    expect(html).toContain('<a href="https://shop.example.test/"');
  });
});
