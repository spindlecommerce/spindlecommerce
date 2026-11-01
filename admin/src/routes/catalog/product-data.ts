import { ErrorFields, graphql, type ResultOf, type VariablesOf } from "@/graphql/graphql";

const AttributeFields = graphql(`
  fragment EditorAttributeFields on AttributeDefinition {
    id
    code
    label
    type
    isLocalized
    isRequired
    unit
    options {
      code
      label
      swatch
    }
  }
`);

export const ProductEditorQuery = graphql(
  `
    query ProductEditor($id: ID!) {
      product(id: $id) {
        id
        name
        status
        createdAt
        updatedAt
        attributeValues
        taxClass {
          id
          name
        }
        productType {
          id
          code
          name
          isShippable
          taxClass {
            id
            name
          }
          attributes {
            ...EditorAttributeFields
          }
          variantAttributes {
            ...EditorAttributeFields
          }
        }
        translations {
          locale
          name
          slug
          description
          metaTitle
          metaDescription
        }
        categories {
          id
          name
        }
        channelListings {
          isPublished
          visibleInListings
          publishedAt
          channel {
            id
            code
            name
          }
        }
        media {
          id
          url
          alts {
            locale
            value
          }
          kind
          position
          variant {
            id
            sku
          }
        }
        variants {
          id
          sku
          name
          barcode
          weightGrams
          position
          isActive
          trackInventory
          allowBackorder
          quantityAvailable
          selectedOptions {
            attribute
            value
            label
            name
            swatch
          }
          prices {
            id
            currencyCode
            customerGroupId
            minQuantity
            startsAt
            endsAt
            channel {
              id
              code
              name
            }
            amount {
              amount
              currencyCode
            }
            compareAtAmount {
              amount
            }
            costAmount {
              amount
            }
          }
          stockLevels {
            quantity
            updatedAt
            location {
              id
              code
              name
            }
          }
        }
      }
    }
  `,
  [AttributeFields],
);

export type EditorProduct = NonNullable<ResultOf<typeof ProductEditorQuery>["product"]>;
export type EditorVariant = NonNullable<EditorProduct["variants"]>[number];
export type EditorAttribute = NonNullable<NonNullable<EditorProduct["productType"]>["attributes"]>[number];

/** Its own query, so changing the admin's currency (useAdminCurrency) never reloads the forms. */
export const VariantPricesQuery = graphql(`
  query VariantPrices($id: ID!, $channel: String, $currency: String) @inContext(channel: $channel, currency: $currency) {
    product(id: $id) {
      variants {
        id
        price {
          amount
          currencyCode
        }
      }
    }
  }
`);

export const ProductTypesFullQuery = graphql(
  `
    query ProductTypesFull {
      productTypes {
        id
        code
        name
        isShippable
        taxClass {
          id
          name
        }
        attributes {
          ...EditorAttributeFields
        }
        variantAttributes {
          ...EditorAttributeFields
        }
      }
    }
  `,
  [AttributeFields],
);

export type FullProductType = NonNullable<ResultOf<typeof ProductTypesFullQuery>["productTypes"]>[number];

export const ProductCreate = graphql(
  `
    mutation ProductCreate($input: ProductCreateInput!) {
      productCreate(input: $input) {
        __typename
        ... on ProductPayload {
          product {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
export type ProductCreateInput = VariablesOf<typeof ProductCreate>["input"];

export const ProductUpdate = graphql(
  `
    mutation ProductUpdate($id: ID!, $input: ProductUpdateInput!) {
      productUpdate(id: $id, input: $input) {
        __typename
        ... on ProductPayload {
          product {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
export type ProductUpdateInput = VariablesOf<typeof ProductUpdate>["input"];

export const ProductDelete = graphql(
  `
    mutation ProductDelete($id: ID!) {
      productDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const ProductDuplicate = graphql(
  `
    mutation ProductDuplicate($id: ID!) {
      productDuplicate(id: $id) {
        __typename
        ... on ProductPayload {
          product {
            id
            name
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const VariantCreate = graphql(
  `
    mutation ProductVariantCreate($productId: ID!, $input: ProductVariantInput!) {
      productVariantCreate(productId: $productId, input: $input) {
        __typename
        ... on ProductVariantPayload {
          variant {
            id
            sku
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
export type VariantCreateInput = VariablesOf<typeof VariantCreate>["input"];

export const VariantUpdate = graphql(
  `
    mutation ProductVariantUpdate($id: ID!, $input: ProductVariantUpdateInput!) {
      productVariantUpdate(id: $id, input: $input) {
        __typename
        ... on ProductVariantPayload {
          variant {
            id
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const VariantDelete = graphql(
  `
    mutation ProductVariantDelete($id: ID!) {
      productVariantDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const VariantPricesSet = graphql(
  `
    mutation ProductVariantPricesSet($variantId: ID!, $prices: [VariantPriceInput!]!) {
      productVariantPricesSet(variantId: $variantId, prices: $prices) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
export type VariantPriceInput = VariablesOf<typeof VariantPricesSet>["prices"][number];

export const StockLevelSet = graphql(
  `
    mutation StockLevelSet($variantId: ID!, $locationId: ID!, $quantity: Int!) {
      stockLevelSet(variantId: $variantId, locationId: $locationId, quantity: $quantity) {
        __typename
        ... on StockLevelPayload {
          stockLevel {
            quantity
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const StockLevelAdjust = graphql(
  `
    mutation StockLevelAdjust($variantId: ID!, $locationId: ID!, $delta: Int!) {
      stockLevelAdjust(variantId: $variantId, locationId: $locationId, delta: $delta) {
        __typename
        ... on StockLevelPayload {
          stockLevel {
            quantity
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** SKUs may use letters, digits and . _ - / (up to 64). */
export const SKU_PATTERN = /^[A-Za-z0-9._\-/]{1,64}$/;

/** "OXF" + ["white", "m"] → "OXF-WHITE-M". */
export const skuFor = (base: string, values: readonly string[]) =>
  [base, ...values]
    .map((part) => part.trim().toUpperCase().replace(/[^A-Z0-9._/]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-");

/** Every combination of the chosen values per axis, in axis order. */
export const combinations = (axes: readonly { code: string; values: readonly string[] }[]): Record<string, string>[] =>
  axes.reduce<Record<string, string>[]>((acc, axis) => acc.flatMap((combo) => axis.values.map((value) => ({ ...combo, [axis.code]: value }))), [{}]);

export const comboKey = (axes: readonly string[], options: Record<string, string>) => axes.map((a) => options[a] ?? "").join("|");

/** ISO date-time → value for <input type="datetime-local"> in the viewer's time zone. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);
