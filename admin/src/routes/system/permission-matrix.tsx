import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { graphql, type ResultOf } from "@/graphql/graphql";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Switch } from "@/components/ui/controls";
import { request } from "@/lib/api";
import { cn } from "@/lib/utils";

export const PermissionAreasQuery = graphql(`
  query PermissionAreas {
    permissionAreas {
      code
      name
      description
    }
  }
`);

export type PermissionArea = NonNullable<ResultOf<typeof PermissionAreasQuery>["permissionAreas"]>[number];
type Level = "none" | "read" | "write";

const PluginPermissionsQuery = graphql(`
  query PluginPermissions {
    pluginPermissions {
      code
      description
      plugin
      pluginTitle
    }
  }
`);

type PluginPermissionGroup = { plugin: string; title: string; permissions: { code: string; description: string }[] };

/**
 * Permissions plugins add (`reviews:moderate`), grouped by plugin in ecom.config.ts order.
 * `known` holds every code once loaded, else null.
 */
const usePluginPermissions = () => {
  const query = useQuery({ queryKey: ["permission-areas", "plugins"], queryFn: () => request(PluginPermissionsQuery), staleTime: Infinity });
  return useMemo(() => {
    const groups: PluginPermissionGroup[] = [];
    for (const p of query.data?.pluginPermissions ?? []) {
      if (!p.code) continue;
      const plugin = p.plugin ?? "";
      let group = groups.find((g) => g.plugin === plugin);
      if (!group) groups.push((group = { plugin, title: p.pluginTitle ?? p.plugin ?? "Plugins", permissions: [] }));
      group.permissions.push({ code: p.code, description: p.description ?? "" });
    }
    return { groups, known: query.data ? new Set(groups.flatMap((g) => g.permissions.map((p) => p.code))) : null };
  }, [query.data]);
};

const isAreaPermission = (permission: string, areas: readonly PermissionArea[]) => areas.some((a) => permission === `${a.code}:read` || permission === `${a.code}:write`);

const levelOf = (permissions: readonly string[], area: string): Level => (permissions.includes(`${area}:write`) ? "write" : permissions.includes(`${area}:read`) ? "read" : "none");

const LEVELS: { value: Level; label: string }[] = [
  { value: "none", label: "None" },
  { value: "read", label: "View" },
  { value: "write", label: "Manage" },
];

/**
 * Per area: none, view (`area:read`) or manage (`area:write`, which includes view); or everything
 * (`*`). Then a checkbox per plugin permission, plus any held permission no installed plugin
 * offers any more: the API refuses those, so they can be removed here.
 */
export const PermissionMatrix = ({ value, onChange, areas, disabled }: { value: string[]; onChange: (value: string[]) => void; areas: readonly PermissionArea[]; disabled?: boolean }) => {
  const full = value.includes("*");
  const plugins = usePluginPermissions();
  const setLevel = (area: string, level: Level) => {
    const rest = value.filter((p) => p !== `${area}:read` && p !== `${area}:write`);
    onChange(level === "none" ? rest : [...rest, `${area}:${level}`]);
  };
  const setGranted = (permission: string, on: boolean) => onChange(on ? [...value.filter((p) => p !== permission), permission] : value.filter((p) => p !== permission));
  const known = plugins.known;
  const stale = known && areas.length ? value.filter((p) => p !== "*" && !isAreaPermission(p, areas) && !known.has(p)) : [];
  const groups: PluginPermissionGroup[] = [
    ...plugins.groups,
    ...(stale.length ? [{ plugin: "", title: "No longer installed", permissions: stale.map((code) => ({ code, description: "No installed plugin offers it; uncheck it to remove it." })) }] : []),
  ];
  return (
    <div className="overflow-hidden rounded-lg border">
      <label className={cn("flex items-center gap-3 border-b px-4 py-3", full && "bg-primary/5")}>
        <Switch checked={full} disabled={disabled} onCheckedChange={(on) => onChange(on ? ["*"] : [])} />
        <span className="flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium">
            <ShieldCheck className="size-4 text-primary" /> Full access
          </span>
          <span className="block text-xs text-muted-foreground">Everything, including staff, roles and API keys (*).</span>
        </span>
      </label>
      <table className={cn("w-full text-sm", full && "pointer-events-none opacity-50")}>
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            <th className="px-4 py-2 text-left font-medium">Area</th>
            {LEVELS.map((l) => (
              <th key={l.value} className="w-20 px-2 py-2 text-center font-medium">
                {l.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => {
            const level = full ? "write" : levelOf(value, area.code ?? "");
            return (
              <tr key={area.code} className="border-b last:border-0">
                <td className="px-4 py-2.5">
                  <span className="text-[13px] font-medium">{area.name}</span>
                  <span className="block text-xs text-muted-foreground">{area.description}</span>
                </td>
                {LEVELS.map((l) => (
                  <td key={l.value} className="px-2 py-2.5 text-center">
                    <input
                      type="radio"
                      name={`permission-${area.code}`}
                      aria-label={`${area.name}: ${l.label}`}
                      className="size-4 accent-[var(--primary)]"
                      checked={level === l.value}
                      disabled={disabled || full}
                      onChange={() => setLevel(area.code ?? "", l.value)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {groups.length ? (
        <table className={cn("w-full border-t text-sm", full && "pointer-events-none opacity-50")}>
          <thead>
            <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Plugin permission</th>
              <th className="w-20 px-2 py-2 text-center font-medium">Granted</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.plugin || "stale"} className="border-b last:border-0">
              <tr>
                <th colSpan={2} scope="colgroup" className="px-4 pt-3 pb-1 text-left text-xs font-semibold">
                  {group.title}
                </th>
              </tr>
              {group.permissions.map((p) => {
                // As for areas, `x:write` includes `x:read`.
                const implied = p.code.endsWith(":read") && value.includes(p.code.replace(/:read$/, ":write"));
                return (
                  <tr key={p.code}>
                    <td className="px-4 py-2">
                      <span className="font-mono text-[13px]">{p.code}</span>
                      <span className="block text-xs text-muted-foreground">{implied ? `${p.description} (included in ${p.code.replace(/:read$/, ":write")})` : p.description}</span>
                    </td>
                    <td className="px-2 py-2 text-center">
                      <Checkbox
                        aria-label={`${group.title}: ${p.description || p.code}`}
                        checked={full || implied || value.includes(p.code)}
                        disabled={disabled || full || implied}
                        onCheckedChange={(on) => setGranted(p.code, on === true)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      ) : null}
    </div>
  );
};

/** Read-only summary: areas, then plugin permissions by code. */
export const PermissionSummary = ({ permissions, areas, max = 5 }: { permissions: readonly string[]; areas: readonly PermissionArea[]; max?: number }) => {
  const plugins = usePluginPermissions();
  if (permissions.includes("*")) return <Badge variant="default">Full access</Badge>;
  const granted = [
    ...areas.flatMap((a) => {
      const level = levelOf(permissions, a.code ?? "");
      return level === "none" ? [] : [{ name: a.name ?? a.code ?? "", level, title: undefined }];
    }),
    ...plugins.groups.flatMap((g) => g.permissions.filter((p) => permissions.includes(p.code)).map((p) => ({ name: p.code, level: "plugin" as const, title: `${g.title}: ${p.description}` }))),
  ];
  if (granted.length === 0) return <span className="text-[13px] text-muted-foreground">No permissions</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {granted.slice(0, max).map((g) => (
        <Badge key={g.name} variant={g.level === "write" ? "info" : g.level === "plugin" ? "outline" : "secondary"} className={g.level === "plugin" ? "font-mono" : undefined} title={g.title}>
          {g.name}
          {g.level === "read" ? " (view)" : ""}
        </Badge>
      ))}
      {granted.length > max ? <span className="text-[11px] text-muted-foreground">+{granted.length - max}</span> : null}
    </span>
  );
};
