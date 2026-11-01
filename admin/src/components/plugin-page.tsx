import { Link, useLocation, useParams } from "@tanstack/react-router";
import { Bug, SearchX, ShieldAlert, Unplug, type LucideIcon } from "lucide-react";
import { Suspense, useEffect, type ReactNode } from "react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { useAuth } from "@/lib/auth";
import { bundledPlugin, matchPluginPage, PluginBoundary, PluginScope, useAdminPlugins } from "./plugin-runtime";

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Decoded segments below /plugins/<name>/. Read from the location because the splat has already
 * decoded a "%2F" inside a segment (a global ID) into "/".
 */
const restOf = (pathname: string, name: string, splat: string) => {
  const parts = pathname.split("/");
  const at = parts.findIndex((part, i) => part === "plugins" && decode(parts[i + 1] ?? "") === name);
  return at >= 0 ? parts.slice(at + 2).filter(Boolean).map(decode) : splat.split("/").filter(Boolean);
};

const Notice = ({ icon, title, description, action }: { icon: LucideIcon; title: string; description: ReactNode; action?: ReactNode }) => {
  useEffect(() => {
    document.title = `${title} · SpindleCommerce`;
  }, [title]);
  return (
    <Page>
      <EmptyState icon={icon} title={title} description={description} action={action} />
    </Page>
  );
};

const Loading = () => (
  <Page>
    <Skeleton className="mb-6 h-8 w-64" />
    <Skeleton className="h-96 w-full" />
  </Page>
);

/** /plugins/<name>/<path>: the matching plugin page, or a notice saying why there is none. */
export const PluginPage = () => {
  const { plugin: name = "", _splat: splat = "" } = useParams({ strict: false }) as { plugin?: string; _splat?: string };
  const pathname = useLocation({ select: (location) => location.pathname });
  const { can } = useAuth();
  const { plugins, isActive, loading } = useAdminPlugins();
  const entry = bundledPlugin(name);
  const plugin = plugins.find((p) => p.name === name);

  if (!entry) return <Notice icon={SearchX} title="Page not found" description={`No plugin called “${name}” has pages in this admin.`} />;
  if (!plugin) {
    if (loading) return <Loading />;
    const settings = can("settings:read") ? (
      <Button asChild variant="outline">
        <Link to="/settings/plugins/$name" params={{ name }}>
          Plugin settings
        </Link>
      </Button>
    ) : null;
    return isActive(name) === false ? (
      <Notice icon={Unplug} title={`${entry.title} is off`} description="Its pages open while the plugin is enabled and every required setting is filled in." action={settings} />
    ) : (
      <Notice icon={Unplug} title={`${entry.title} is not available`} description="Its pages could not be loaded. Ask an administrator to check it under Settings › Plugins." action={settings} />
    );
  }

  const match = matchPluginPage(plugin.definition.pages ?? [], restOf(pathname, name, splat));
  if (!match) return <Notice icon={SearchX} title="Page not found" description={`${plugin.title} has no page at this address.`} />;
  const permission = match.page.permission ?? match.page.nav?.permission;
  if (permission && !can(permission)) return <Notice icon={ShieldAlert} title="No access" description={`Your roles don't include the permission to open ${match.page.title}.`} />;

  const Screen = match.page.component;
  return (
    <PluginScope plugin={plugin}>
      {/* Keyed by the path, so a page that failed starts afresh on the next. */}
      <PluginBoundary key={pathname} plugin={plugin.name} fallback={(error) => <Notice icon={Bug} title={`${match.page.title} failed to load`} description={error.message} />}>
        <Suspense fallback={<Loading />}>
          <Screen params={match.params} />
        </Suspense>
      </PluginBoundary>
    </PluginScope>
  );
};
