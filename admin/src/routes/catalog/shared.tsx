import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";

/** Global id for a raw UUID in a URL (or the global id unchanged). */
export const gid = (type: string, id: string) => (id.startsWith("gid://") ? id : `gid://ecom/${type}/${id}`);

export const PRODUCT_STATUSES = [
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]["value"];

export const ATTRIBUTE_TYPES = [
  { value: "TEXT", label: "Text" },
  { value: "RICH_TEXT", label: "Rich text" },
  { value: "NUMBER", label: "Number" },
  { value: "BOOLEAN", label: "Yes / no" },
  { value: "SELECT", label: "Select" },
  { value: "MULTISELECT", label: "Multiselect" },
  { value: "DATE", label: "Date" },
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number]["value"];

// ---------------------------------------------------------------- categories

/** `categories` is depth first in position order, so parents come before their children. */
const CategoryOptionsQuery = graphql(`
  query CategoryOptions {
    categories {
      id
      name
      isActive
      parent {
        id
      }
    }
  }
`);

type CategoryRow = { id: string; name: string | null; isActive: boolean | null; parent: { id: string } | null };
export type FlatCategory<T extends CategoryRow = CategoryRow> = T & { parentId: string | null; trail: string[]; label: string; descendantIds: string[] };

/** Breadcrumbs ("Men › Shirts") and subtree ids for a depth-first category list. */
export const flattenCategories = <T extends CategoryRow>(list: readonly T[]): FlatCategory<T>[] => {
  const byId = new Map<string, FlatCategory<T>>();
  return list.map((category) => {
    const parent = category.parent ? byId.get(category.parent.id) : undefined;
    const trail = parent ? [...parent.trail, parent.name || "(untitled)"] : [];
    const node: FlatCategory<T> = { ...category, parentId: category.parent?.id ?? null, trail, label: [...trail, category.name || "(untitled)"].join(" › "), descendantIds: [] };
    for (let up = parent; up; up = up.parentId ? byId.get(up.parentId) : undefined) up.descendantIds.push(category.id);
    byId.set(category.id, node);
    return node;
  });
};

/** Every category as a picker option labelled with its breadcrumb. */
export const useCategoryOptions = (enabled = true) => {
  const query = useQuery({ queryKey: [...CATALOG_KEYS.categories, "options"], queryFn: () => request(CategoryOptionsQuery), staleTime: 60_000, enabled });
  const options = useMemo(() => flattenCategories(query.data?.categories ?? []).map((c) => ({ value: c.id, label: c.label, hint: c.isActive ? undefined : "inactive" })), [query.data]);
  return { options, isLoading: query.isLoading, error: query.error };
};

// ---------------------------------------------------------------- attribute definitions

export const AttributeDefinitionsQuery = graphql(`
  query AttributeDefinitions {
    attributeDefinitions {
      id
      code
      label
      type
      isLocalized
      isRequired
      isFilterable
      isSearchable
      unit
      position
      labels {
        locale
        value
      }
      options {
        code
        label
        swatch
        labels {
          locale
          value
        }
      }
    }
  }
`);

export type AttributeDefinition = NonNullable<ResultOf<typeof AttributeDefinitionsQuery>["attributeDefinitions"]>[number];

export const useAttributeDefinitions = () => {
  const query = useQuery({ queryKey: ["attribute-definitions"], queryFn: () => request(AttributeDefinitionsQuery), staleTime: 60_000 });
  return { ...query, definitions: query.data?.attributeDefinitions ?? [] };
};

/** Query keys catalog writes invalidate (the shared reference lists include product types). */
export const CATALOG_KEYS = {
  products: ["products"],
  product: (id: string) => ["product", id],
  productDetails: ["product"],
  categories: ["categories"],
  attributes: ["attribute-definitions"],
  productTypes: ["product-types"],
  reference: ["reference"],
  inventory: ["inventory"],
} as const;

/** "#3366ff" when the swatch is a colour, otherwise null. */
export const swatchColor = (swatch: string | null | undefined) => (swatch && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(swatch) ? swatch : null);

export const Swatch = ({ swatch, className = "size-3" }: { swatch: string | null | undefined; className?: string }) => {
  const color = swatchColor(swatch);
  return color ? <span className={`inline-block shrink-0 rounded-full border ${className}`} style={{ backgroundColor: color }} /> : null;
};
