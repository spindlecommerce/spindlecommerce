import { Suspense, type ComponentType } from "react";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { WidgetZone } from "@/plugin-sdk";
import { PluginBoundary, PluginScope, useAdminPlugins } from "./plugin-runtime";

type Props = { className?: string } & ({ zone: "dashboard" } | { zone: Exclude<WidgetZone, "dashboard">; id: string });

/**
 * Plugin widgets for one zone, in plugin order. In a side column each widget is a direct child so
 * the column's spacing applies; on the dashboard they share a grid, styled by `className`.
 */
export const PluginWidgets = (props: Props) => {
  const { can } = useAuth();
  const { plugins } = useAdminPlugins();
  const id = props.zone === "dashboard" ? undefined : props.id;
  const widgets = plugins.flatMap((plugin) =>
    (plugin.definition.widgets ?? []).flatMap((widget, index) => (widget.zone === props.zone && (!widget.permission || can(widget.permission)) ? [{ plugin, widget, key: `${plugin.name}:${index}` }] : [])),
  );
  if (!widgets.length) return null;

  const items = widgets.map(({ plugin, widget, key }) => {
    // The zone was checked above; its props are `{ id }` or none.
    const Widget = widget.component as ComponentType<{ id?: string }>;
    return (
      // Keyed by the record too, so a widget that failed on one order starts afresh on the next.
      <PluginScope key={`${key}:${id ?? ""}`} plugin={plugin}>
        <PluginBoundary plugin={plugin.name} fallback={(error) => <Alert variant="destructive" title={`${plugin.title} could not show its widget`}>{error.message}</Alert>}>
          <Suspense fallback={<Skeleton className="h-32 rounded-xl" />}>{id === undefined ? <Widget /> : <Widget id={id} />}</Suspense>
        </PluginBoundary>
      </PluginScope>
    );
  });
  return props.zone === "dashboard" ? <div className={cn("grid gap-6 md:grid-cols-2 xl:grid-cols-3", props.className)}>{items}</div> : <>{items}</>;
};
