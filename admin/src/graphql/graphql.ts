import { initGraphQLTada } from "gql.tada";
import type { introspection } from "./graphql-env.d.ts";

/**
 * Typed admin API documents; `pnpm schema:print` regenerates the types. Masking is off so components
 * read fragment fields directly.
 */
export const graphql = initGraphQLTada<{
  introspection: introspection;
  disableMasking: true;
  scalars: {
    DateTime: string;
    Decimal: string;
    JSON: unknown;
    CurrencyCode: string;
    CountryCode: string;
    LocaleCode: string;
    EmailAddress: string;
  };
}>();

export type { ResultOf, VariablesOf } from "gql.tada";

/** Expected mutation failures, which come back as result-union members. */
export const ErrorFields = graphql(`
  fragment ErrorFields on Error {
    __typename
    code
    message
    ... on ValidationError {
      fieldErrors {
        path
        message
      }
    }
    ... on PermissionDeniedError {
      permission
    }
    ... on CartNotReadyError {
      missing
    }
    ... on InsufficientStockError {
      sku
      available
    }
  }
`);

export const MoneyFields = graphql(`
  fragment MoneyFields on Money {
    amount
    currencyCode
    formatted
  }
`);
