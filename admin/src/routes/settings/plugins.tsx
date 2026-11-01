import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Puzzle } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { request } from "@/lib/api";
import { Chips, SettingsCard } from "./shared";

const PluginsQuery = graphql(`
  query SettingsPlugins {
    plugins {
      name
      title
      version
      description
      enabled
      configured
      active
      missingSettings
      settings {
        key
        label
      }
      capabilities {
        events
        hooks
        paymentProviders
        shippingProviders
        emits
        graphql
        routes
        tasks
        migrations
        admin
      }
    }
  }
`);

type Plugin = NonNullable<ResultOf<typeof PluginsQuery>["plugins"]>[number];
type Capabilities = Plugin["capabilities"];

/** What a plugin adds to the platform, a few words each. */
export const provides = (c: Capabilities | null | undefined) =>
  c
    ? [
        c.paymentProviders?.length ? `Payments: ${c.paymentProviders.join(", ")}` : null,
        c.shippingProviders?.length ? `Shipping: ${c.shippingProviders.join(", ")}` : null,
        c.events?.length ? "Event handlers" : null,
        c.hooks?.length ? "Checkout checks" : null,
        c.emits?.length ? "Own events" : null,
        c.graphql ? "GraphQL fields" : null,
        c.routes ? "HTTP routes" : null,
        c.tasks?.length ? "Scheduled tasks" : null,
        c.migrations ? "Database tables" : null,
        c.admin ? "Admin pages" : null,
      ].filter((item): item is string => item !== null)
    : [];

export const missingLabels = (plugin: { missingSettings?: readonly string[] | null; settings?: readonly { key?: string | null; label?: string | null }[] | null }) =>
  (plugin.missingSettings ?? []).map((key) => plugin.settings?.find((s) => s.key === key)?.label ?? key);

export const PluginStatus = ({ plugin }: { plugin: { enabled?: boolean | null; configured?: boolean | null; active?: boolean | null } }) => (
  <>
    {plugin.active ? (
      <Badge variant="success" dot>
        Active
      </Badge>
    ) : !plugin.enabled ? (
      <Badge variant="secondary" dot>
        Disabled
      </Badge>
    ) : null}
    {plugin.configured === false ? (
      <Badge variant="warning" dot>
        Needs setup
      </Badge>
    ) : plugin.enabled && !plugin.active ? (
      <Badge variant="secondary" dot>
        Inactive
      </Badge>
    ) : null}
  </>
);

export const PluginsPage = () => {
  const query = useQuery({ queryKey: ["plugins", "list"], queryFn: () => request(PluginsQuery) });
  const plugins = (query.data?.plugins ?? []).flatMap((plugin) => (plugin.name ? [{ ...plugin, name: plugin.name }] : []));

  return (
    <Page>
      <PageHeader
        title="Plugins"
        description="Plugins are installed in code (ecom.config.ts) and deployed with the platform. Here they are turned on and off and configured; a plugin runs once it is enabled and its required settings are filled in."
      />
      <SettingsCard title="Installed plugins">
        {query.isLoading ? (
          <div className="space-y-2 px-5 pb-5">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : plugins.length === 0 ? (
          <EmptyState
            icon={Puzzle}
            title="No plugins installed"
            description="Add plugins for payments, shipping, emails and more to ecom.config.ts, then deploy. See docs/plugins.md."
          />
        ) : (
          <ul className="divide-y border-t">
            {plugins.map((plugin) => {
              const missing = missingLabels(plugin);
              const adds = provides(plugin.capabilities);
              return (
                <li key={plugin.name}>
                  <Link
                    to="/settings/plugins/$name"
                    params={{ name: plugin.name }}
                    className="flex items-start gap-4 px-5 py-4 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Puzzle className="size-4 text-muted-foreground" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{plugin.title}</span>
                        <span className="font-mono text-xs text-muted-foreground">{plugin.version}</span>
                        <PluginStatus plugin={plugin} />
                      </span>
                      {plugin.description ? <span className="text-[13px] text-muted-foreground">{plugin.description}</span> : null}
                      {missing.length ? <span className="text-[13px] text-warning">Missing: {missing.join(", ")}</span> : null}
                      {adds.length ? <Chips items={adds} max={10} /> : null}
                    </span>
                    <ChevronRight className="mt-2.5 size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>
    </Page>
  );
};
