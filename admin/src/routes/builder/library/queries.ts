import type { QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { downloadText } from "@/lib/utils";

export const ComponentsQuery = graphql(`
  query LibraryComponents {
    components {
      id
      code
      kind
      name
      description
      groupName
      icon
      previewImageUrl
      fields
      variations
      routable
      singleton
      templateFor
      sectionsFor
      source
      revision
      usageCount
      createdAt
      updatedAt
    }
  }
`);

export type LibraryComponent = NonNullable<ResultOf<typeof ComponentsQuery>["components"]>[number];

/** Every definition in the shape componentsSync and `pnpm components push` take. */
export const DefinitionsQuery = graphql(`
  query LibraryDefinitions {
    components {
      code
      definition
    }
  }
`);

export const ComponentsSync = graphql(
  `
    mutation LibraryComponentsSync($definitions: JSON!, $prune: Boolean) {
      componentsSync(definitions: $definitions, prune: $prune) {
        __typename
        ... on ComponentsSyncPayload {
          created
          updated
          unchanged
          removed
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const LIBRARY_KEY = ["builder-library"] as const;

/** Invalidate every query with a key part matching `pattern`, whichever screen it belongs to. */
export const invalidateMatching = (queryClient: QueryClient, pattern: RegExp) =>
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey.some((part) => typeof part === "string" && pattern.test(part)) });

/** Route params carry global ids; accept a bare UUID too. */
export const globalId = (type: string, param: string) => (param.startsWith("gid://") ? param : `gid://ecom/${type}/${param}`);

/** The UUID inside a global id, as service-level error paths report it. */
export const rawIdOf = (gid: string) => gid.slice(gid.lastIndexOf("/") + 1);

/** Download every definition as components.json, the file `pnpm components push` deploys. */
export const useExportDefinitions = () => {
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      const data = await request(DefinitionsQuery);
      const definitions = (data.components ?? []).map((c) => c.definition);
      downloadText("components.json", `${JSON.stringify(definitions, null, 2)}\n`, "application/json");
      toast.success(`Exported ${definitions.length} definition${definitions.length === 1 ? "" : "s"}`, { description: "Saved as components.json" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
};
