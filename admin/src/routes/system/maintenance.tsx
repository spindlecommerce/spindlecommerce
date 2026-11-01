import { Link } from "@tanstack/react-router";
import { DatabaseZap, Layers, RefreshCw, Workflow } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorFields, graphql } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";

const SearchReindex = graphql(
  `
    mutation SearchReindex {
      searchReindex {
        __typename
        ... on SearchReindexPayload {
          productCount
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const MaintenancePage = () => {
  const { can } = useAuth();
  const reindex = useAction(() => request(SearchReindex).then((r) => unwrap(r.searchReindex)), {
    success: (result) => `Search index rebuilt for ${result.productCount ?? 0} products`,
  });

  return (
    <Page>
      <PageHeader title="Maintenance" description="Tools for recovery. Day to day, caches and indexes keep themselves up to date." />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="size-4 text-primary" /> Search index
              </CardTitle>
              <CardDescription>The product search projection (names, attributes, prices and stock per channel) behind storefront search and facets.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px] text-muted-foreground">
            <p>
              Every catalog, price and stock write updates the projection in the same transaction, so it is never stale.
            </p>
            <p>Rebuild only after changing data outside the API, such as a direct database import.</p>
            {can("catalog:write") ? (
              <Button variant="outline" loading={reindex.isPending} onClick={() => reindex.mutate(undefined)}>
                {reindex.isPending ? null : <RefreshCw />}
                Rebuild search index
              </Button>
            ) : (
              <p className="text-xs">Needs the catalog:write permission.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <DatabaseZap className="size-4 text-primary" /> Caches
              </CardTitle>
              <CardDescription>Storefront GraphQL responses are cached per channel, locale, currency and credentials.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px] text-muted-foreground">
            <p>
              When a change commits, its event evicts exactly the cached responses that contain the changed product, category or page. There is nothing to flush by hand; responses also expire after the configured TTL
              (GRAPHQL_RESPONSE_CACHE_TTL_MS).
            </p>
            <p>Carts, customers and orders are never cached.</p>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Workflow className="size-4 text-primary" /> Background work
              </CardTitle>
              <CardDescription>Events are written to an outbox in the same transaction as each change, then processed by the worker.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px] text-muted-foreground">
            <p>
              The worker fans events out to webhooks, live order updates and cache invalidation. It runs inside the server in development; run <code className="rounded bg-muted px-1 font-mono text-xs">pnpm worker</code>{" "}
              separately with WORKER=external in production.
            </p>
            {can("integrations:read") ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/system/webhooks" search={{ tab: "deliveries" }}>
                  Check webhook deliveries
                </Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </Page>
  );
};
