import type { AddressDraft } from "../lib/address.ts";
import type { ApiKey } from "../modules/auth/service.ts";
import type { Session } from "../modules/auth/service.ts";
import type { CartLine, Cart, QuoteLine } from "../modules/carts/quote.ts";
import type { AttributeDefinition, Category, Product, ProductMedia, ProductType, ProductVariant } from "../modules/catalog/read.ts";
import type { Channel } from "../modules/channels/service.ts";
import type { BuilderComponent } from "../modules/builder/components.ts";
import type { Frontend } from "../modules/builder/frontends.ts";
import type { BuilderPage, PageVersion } from "../modules/builder/pages.ts";
import type { Release } from "../modules/builder/releases.ts";
import type { Customer, CustomerAddress, CustomerGroup } from "../modules/customers/service.ts";
import type { WebhookDelivery, WebhookSubscription } from "../modules/integrations/webhooks.ts";
import type { Stock, StockLocation } from "../modules/inventory/service.ts";
import type { stockLevels } from "../modules/inventory/tables.ts";
import type { MediaAsset } from "../modules/media/service.ts";
import type { Fulfillment, Invoice, Order, OrderEvent, OrderLine, Refund } from "../modules/orders/read.ts";
import type { PaymentMethod, PaymentTransaction } from "../modules/payments/service.ts";
import type { Coupon, Promotion } from "../modules/promotions/service.ts";
import type { ShippingMethod, ShippingZone } from "../modules/shipping/service.ts";
import type { Role, StaffUser } from "../modules/staff/service.ts";
import type { TaxClass, TaxRate, TaxRule } from "../modules/tax/service.ts";
import { builder } from "./builder.ts";

/** Declared up front so domain files can reference each other's types without import cycles. */
export type MoneyShape = { amount: number; currency: string };

export const MoneyRef = builder.objectRef<MoneyShape>("Money");
/** Orders' and saved addresses are complete; a cart's may still be a draft. */
export const AddressRef = builder.objectRef<AddressDraft>("Address");
export const SessionRef = builder.objectRef<Session>("Session");

export const ChannelRef = builder.objectRef<Channel>("Channel");
export const AttributeDefinitionRef = builder.objectRef<AttributeDefinition>("AttributeDefinition");
export const ProductTypeRef = builder.objectRef<ProductType>("ProductType");
export const ProductRef = builder.objectRef<Product>("Product");
export const ProductVariantRef = builder.objectRef<ProductVariant>("ProductVariant");
export const MediaRef = builder.objectRef<ProductMedia>("Media");
export const CategoryRef = builder.objectRef<Category>("Category");
export const MediaAssetRef = builder.objectRef<MediaAsset>("MediaAsset");

export const CartRef = builder.objectRef<Cart>("Cart");
export const CartLineRef = builder.objectRef<QuoteLine & { currency: string }>("CartLine");
export type { CartLine };

export const CustomerRef = builder.objectRef<Customer>("Customer");
export const CustomerAddressRef = builder.objectRef<CustomerAddress>("CustomerAddress");
export const CustomerGroupRef = builder.objectRef<CustomerGroup>("CustomerGroup");

export const OrderRef = builder.objectRef<Order>("Order");
export const OrderLineRef = builder.objectRef<OrderLine>("OrderLine");
export const InvoiceRef = builder.objectRef<Invoice>("Invoice");
export const FulfillmentRef = builder.objectRef<Fulfillment>("Fulfillment");
export const RefundRef = builder.objectRef<Refund>("Refund");
export const OrderEventRef = builder.objectRef<OrderEvent>("OrderEvent");
export const PaymentTransactionRef = builder.objectRef<PaymentTransaction>("PaymentTransaction");

export const PromotionRef = builder.objectRef<Promotion>("Promotion");
export const CouponRef = builder.objectRef<Coupon>("Coupon");

export const StockLocationRef = builder.objectRef<StockLocation>("StockLocation");
export const StockRef = builder.objectRef<Stock>("Stock");
export const StockLevelRef = builder.objectRef<typeof stockLevels.$inferSelect>("StockLevel");

export const TaxClassRef = builder.objectRef<TaxClass>("TaxClass");
export const TaxRateRef = builder.objectRef<TaxRate>("TaxRate");
export const TaxRuleRef = builder.objectRef<TaxRule>("TaxRule");
export const ShippingZoneRef = builder.objectRef<ShippingZone>("ShippingZone");
export const ShippingMethodRef = builder.objectRef<ShippingMethod>("ShippingMethod");
export const PaymentMethodRef = builder.objectRef<PaymentMethod>("PaymentMethod");


/** A builder page as one audience sees it: the published version, or the draft (admin and preview). */
export type PageView = BuilderPage & { view: "published" | "draft" };
export const PageRef = builder.objectRef<PageView>("Page");
export const PageVersionRef = builder.objectRef<PageVersion>("PageVersion");
export const ComponentRef = builder.objectRef<BuilderComponent>("Component");
export const ReleaseRef = builder.objectRef<Release>("Release");
export const FrontendRef = builder.objectRef<Frontend>("Frontend");

export const StaffUserRef = builder.objectRef<StaffUser>("StaffUser");
export const RoleRef = builder.objectRef<Role>("Role");
export const ApiKeyRef = builder.objectRef<ApiKey>("ApiKey");
export const WebhookSubscriptionRef = builder.objectRef<WebhookSubscription>("WebhookSubscription");
export const WebhookDeliveryRef = builder.objectRef<WebhookDelivery>("WebhookDelivery");
