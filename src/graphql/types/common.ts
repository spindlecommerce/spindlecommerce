import { GraphQLError, Kind } from "graphql";
import {
  AuthenticationError,
  CartNotReadyError,
  ConflictError,
  CouponNotApplicableError,
  DomainError,
  InsufficientStockError,
  InvalidStateError,
  NotFoundError,
  PaymentDeclinedError,
  PermissionDeniedError,
  ValidationError,
  type FieldError,
} from "../../lib/errors.ts";
import { toGlobalId } from "../../lib/ids.ts";
import { CURRENCY_CODE, formatMoney, toDecimalString } from "../../lib/money.ts";
import { ADMIN, builder } from "../builder.ts";
import { AddressRef, MoneyRef, SessionRef, type MoneyShape } from "../refs.ts";

// ---------------------------------------------------------------- scalars

const stringScalar = (name: string, description: string, test: (value: string) => boolean, normalize: (value: string) => string = (v) => v) =>
  builder.scalarType(name as "Decimal", {
    description,
    serialize: (value) => String(value),
    parseValue: (value) => {
      if (typeof value !== "string" || !test(value)) throw new GraphQLError(`Invalid ${name}: ${JSON.stringify(value)}`);
      return normalize(value);
    },
    parseLiteral: (ast) => {
      if (ast.kind !== Kind.STRING || !test(ast.value)) throw new GraphQLError(`Invalid ${name} literal`);
      return normalize(ast.value);
    },
  });

stringScalar("Decimal", "Exact decimal amount as a string, e.g. \"19.99\". Money never uses floats.", (v) => /^-?\d+(\.\d+)?$/.test(v));
stringScalar("CurrencyCode", "ISO 4217 currency code, e.g. USD.", (v) => CURRENCY_CODE.test(v.toUpperCase()), (v) => v.toUpperCase());
stringScalar("CountryCode", "ISO 3166-1 alpha-2 country code, e.g. DE.", (v) => /^[A-Za-z]{2}$/.test(v), (v) => v.toUpperCase());
stringScalar("LocaleCode", "BCP 47 locale, e.g. de-DE.", (v) => /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v));
stringScalar("EmailAddress", "An email address.", (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254, (v) => v.trim().toLowerCase());

builder.scalarType("DateTime", {
  description: "ISO 8601 date-time in UTC.",
  serialize: (value) => (value instanceof Date ? value.toISOString() : new Date(value as string).toISOString()),
  parseValue: (value) => {
    const date = new Date(value as string);
    if (typeof value !== "string" || Number.isNaN(date.getTime())) throw new GraphQLError("Invalid DateTime");
    return date;
  },
  parseLiteral: (ast) => {
    const date = ast.kind === Kind.STRING ? new Date(ast.value) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) throw new GraphQLError("Invalid DateTime literal");
    return date;
  },
});

builder.scalarType("JSON", {
  description: "Arbitrary JSON value.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => {
    const read = (node: typeof ast): unknown => {
      switch (node.kind) {
        case Kind.STRING:
        case Kind.ENUM:
          return node.value;
        case Kind.INT:
        case Kind.FLOAT:
          return Number(node.value);
        case Kind.BOOLEAN:
          return node.value;
        case Kind.NULL:
          return null;
        case Kind.LIST:
          return node.values.map(read);
        case Kind.OBJECT:
          return Object.fromEntries(node.fields.map((f) => [f.name.value, read(f.value)]));
        default:
          throw new GraphQLError("Variables inside JSON literals are not supported");
      }
    };
    return read(ast);
  },
});

// ---------------------------------------------------------------- errors

export const ErrorCode = builder.enumType("ErrorCode", {
  description: "Stable machine-readable error codes.",
  values: [
    "VALIDATION_FAILED",
    "NOT_FOUND",
    "CONFLICT",
    "UNAUTHENTICATED",
    "PERMISSION_DENIED",
    "INSUFFICIENT_STOCK",
    "COUPON_NOT_APPLICABLE",
    "CART_NOT_READY",
    "PAYMENT_DECLINED",
    "INVALID_STATE",
  ] as const,
});

export const ErrorInterface = builder.interfaceRef<DomainError>("Error").implement({
  description: "Implemented by every expected failure. Query `... on Error { code message }` to handle any of them.",
  fields: (t) => ({
    code: t.field({ type: ErrorCode, resolve: (e) => e.code as typeof ErrorCode.$inferType }),
    message: t.exposeString("message"),
  }),
});

export const FieldErrorRef = builder.objectRef<FieldError>("FieldError").implement({
  description: "One invalid input field, addressed by its path from the argument root.",
  fields: (t) => ({ path: t.exposeStringList("path"), message: t.exposeString("message") }),
});

builder.objectType(ValidationError, {
  name: "ValidationError",
  interfaces: [ErrorInterface],
  fields: (t) => ({ fieldErrors: t.field({ type: [FieldErrorRef], resolve: (e) => e.fieldErrors }) }),
});
builder.objectType(NotFoundError, {
  name: "NotFoundError",
  interfaces: [ErrorInterface],
  fields: (t) => ({ resource: t.exposeString("resource") }),
});
builder.objectType(AuthenticationError, { name: "AuthenticationError", interfaces: [ErrorInterface], fields: () => ({}) });
builder.objectType(PermissionDeniedError, {
  name: "PermissionDeniedError",
  interfaces: [ErrorInterface],
  fields: (t) => ({ permission: t.exposeString("permission") }),
});
builder.objectType(ConflictError, { name: "ConflictError", interfaces: [ErrorInterface], fields: () => ({}) });
builder.objectType(InvalidStateError, { name: "InvalidStateError", interfaces: [ErrorInterface], fields: () => ({}) });
builder.objectType(InsufficientStockError, {
  name: "InsufficientStockError",
  interfaces: [ErrorInterface],
  fields: (t) => ({
    variantId: t.id({ resolve: (e) => toGlobalId("ProductVariant", e.variantId) }),
    sku: t.exposeString("sku"),
    requested: t.exposeInt("requested"),
    available: t.int({ resolve: (e) => Math.max(0, e.available) }),
  }),
});
builder.objectType(CouponNotApplicableError, {
  name: "CouponNotApplicableError",
  interfaces: [ErrorInterface],
  fields: (t) => ({ couponCode: t.exposeString("couponCode"), reason: t.exposeString("reason") }),
});

export const CartRequirement = builder.enumType("CartRequirement", {
  description: "Something a cart still needs before it can be checked out.",
  values: {
    LINES: { value: "lines" },
    LINE_ISSUES: { value: "line_issues", description: "A line is unavailable, unpriced or short on stock." },
    EMAIL: { value: "email" },
    SHIPPING_ADDRESS: { value: "shipping_address" },
    SHIPPING_METHOD: { value: "shipping_method" },
    BILLING_ADDRESS: { value: "billing_address" },
    PAYMENT_METHOD: { value: "payment_method" },
  } as const,
});

builder.objectType(CartNotReadyError, {
  name: "CartNotReadyError",
  interfaces: [ErrorInterface],
  fields: (t) => ({
    missing: t.field({ type: [CartRequirement], resolve: (e) => e.missing as (typeof CartRequirement.$inferType)[] }),
    fieldErrors: t.field({
      type: [FieldErrorRef],
      description: 'The same, field by field. Paths follow the storefront\'s cartUpdate input: ["shippingAddress", "address", "postalCode"] is a postal code still to give.',
      resolve: (e) => e.fieldErrors,
    }),
  }),
});
builder.objectType(PaymentDeclinedError, {
  name: "PaymentDeclinedError",
  interfaces: [ErrorInterface],
  fields: (t) => ({ declineCode: t.exposeString("declineCode") }),
});

builder.globalConnectionField("totalCount", (t) =>
  t.int({ description: "Total matching items across all pages.", resolve: (parent) => parent.totalCount }),
);

// ---------------------------------------------------------------- money, addresses, sessions

export const money = (amount: number, currency: string): MoneyShape => ({ amount, currency });

MoneyRef.implement({
  description: "An exact amount in a currency.",
  fields: (t) => ({
    amount: t.field({ type: "Decimal", resolve: (m) => toDecimalString(m.amount, m.currency) }),
    currencyCode: t.field({ type: "CurrencyCode", resolve: (m) => m.currency }),
    formatted: t.string({
      description: "Formatted for the request locale, e.g. \"19,99 €\".",
      resolve: (m, _args, ctx) => formatMoney(m.amount, m.currency, ctx.scope.locale),
    }),
  }),
});

AddressRef.implement({
  fields: (t) => ({
    firstName: t.exposeString("firstName"),
    lastName: t.exposeString("lastName"),
    company: t.exposeString("company", { nullable: true }),
    line1: t.exposeString("line1"),
    line2: t.exposeString("line2", { nullable: true }),
    city: t.exposeString("city"),
    region: t.exposeString("region", { nullable: true }),
    regionCode: t.exposeString("regionCode", { nullable: true }),
    postalCode: t.exposeString("postalCode"),
    countryCode: t.field({ type: "CountryCode", resolve: (a) => a.countryCode }),
    phone: t.exposeString("phone", { nullable: true }),
  }),
});

export const AddressInput = builder.inputType("AddressInput", {
  fields: (t) => ({
    firstName: t.string({ required: true }),
    lastName: t.string({ required: true }),
    company: t.string(),
    line1: t.string({ required: true }),
    line2: t.string(),
    city: t.string({ required: true }),
    region: t.string(),
    regionCode: t.string(),
    postalCode: t.string({ required: true }),
    countryCode: t.field({ type: "CountryCode", required: true }),
    phone: t.string(),
  }),
});

SessionRef.implement({
  description: "A signed-in session: a short-lived access token and a single-use refresh token.",
  fields: (t) => ({
    accessToken: t.exposeString("accessToken"),
    accessTokenExpiresAt: t.field({ type: "DateTime", resolve: (s) => s.accessTokenExpiresAt }),
    refreshToken: t.exposeString("refreshToken"),
    refreshTokenExpiresAt: t.field({ type: "DateTime", resolve: (s) => s.refreshTokenExpiresAt }),
  }),
});

export const LocalizedStringRef = builder.objectRef<{ locale: string; value: string }>("LocalizedString").implement({
  subGraphs: ADMIN,
  fields: (t) => ({ locale: t.field({ type: "LocaleCode", resolve: (l) => l.locale }), value: t.exposeString("value") }),
});

export const LocalizedStringInput = builder.inputType("LocalizedStringInput", {
  subGraphs: ADMIN,
  fields: (t) => ({ locale: t.field({ type: "LocaleCode", required: true }), value: t.string({ required: true }) }),
});

export const toLocalizedList = (text: Record<string, string>) => Object.entries(text).map(([locale, value]) => ({ locale, value }));
export const fromLocalizedList = (list: { locale: string; value: string }[] | null | undefined) => Object.fromEntries((list ?? []).map((l) => [l.locale, l.value]));

export const AcceptedPayload = builder.simpleObject("AcceptedPayload", { fields: (t) => ({ accepted: t.boolean() }) });

/** Drop null and undefined so services treat them as "unchanged". */
export const compact = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));

export const DeletePayload = builder.objectRef<{ deletedId: string }>("DeletePayload").implement({
  fields: (t) => ({ deletedId: t.exposeID("deletedId") }),
});

export const SelectedOptionRef = builder.objectRef<{ attribute: string; name: string; value: string; label: string; swatch: string | null }>("SelectedOption").implement({
  description: "One variant axis value, e.g. Color: Blue.",
  fields: (t) => ({
    attribute: t.exposeString("attribute", { description: "Attribute code, e.g. color." }),
    name: t.exposeString("name", { description: "Attribute label in the request locale." }),
    value: t.exposeString("value", { description: "Option code, e.g. blue." }),
    label: t.exposeString("label", { description: "Option label in the request locale." }),
    swatch: t.exposeString("swatch", { nullable: true }),
  }),
});

export const SelectedOptionInput = builder.inputType("SelectedOptionInput", {
  fields: (t) => ({ attribute: t.string({ required: true }), value: t.string({ required: true }) }),
});
