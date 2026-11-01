import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { CheckCircle2, Play, PlugZap, Puzzle, RotateCw, X } from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { focusFirstError, reportError } from "@/components/form";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { bundledPlugin, PluginBoundary, pluginPath, PluginScope, usePluginModule } from "@/components/plugin-runtime";
import { SaveBar, useSaveShortcut } from "@/components/save-bar";
import { changedSettings, initialSettingValues, SettingsForm, settingsErrors, validateSettings, type SettingDescriptor } from "@/components/settings-form";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Label } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import type { PluginInfo, WidgetZone } from "@/plugin-sdk";
import { missingLabels, PluginStatus } from "./plugins";
import { Chips, SettingsCard } from "./shared";

const SettingFields = graphql(`
  fragment PluginSettingFields on PluginSetting {
    key
    label
    description
    type
    required
    value
    default
    isSet
    source
    env
    options {
      value
      label
    }
    placeholder
    multiline
    min
    max
    integer
  }
`);

const DeliveryFields = graphql(`
  fragment PluginDeliveryFields on PluginDelivery {
    id
    eventType
    handler
    status
    attempts
    lastError
    nextAttemptAt
    createdAt
  }
`);

/** Mutations return this too, so the screen updates from their answer at once. */
const PluginFields = graphql(
  `
    fragment PluginDetailFields on Plugin {
      name
      title
      version
      description
      enabled
      configured
      active
      missingSettings
      hasAdmin
      canCheck
      settings {
        ...PluginSettingFields
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
      permissions {
        code
        description
      }
      tasks {
        name
        description
        intervalMinutes
        lastStartedAt
        lastFinishedAt
        lastStatus
        lastError
      }
      failed: deliveries(status: FAILED, first: 20) {
        ...PluginDeliveryFields
      }
      dead: deliveries(status: DEAD, first: 20) {
        ...PluginDeliveryFields
      }
    }
  `,
  [SettingFields, DeliveryFields],
);

const PluginQuery = graphql(
  `
    query SettingsPlugin($name: String!) {
      plugin(name: $name) {
        ...PluginDetailFields
      }
    }
  `,
  [PluginFields],
);

type Plugin = NonNullable<ResultOf<typeof PluginQuery>["plugin"]>;
type Setting = NonNullable<Plugin["settings"]>[number];
type Task = NonNullable<Plugin["tasks"]>[number];
type Delivery = NonNullable<Plugin["failed"]>[number];

const PluginUpdate = graphql(
  `
    mutation PluginUpdate($name: String!, $input: PluginUpdateInput!) {
      pluginUpdate(name: $name, input: $input) {
        __typename
        ... on PluginUpdatePayload {
          plugin {
            ...PluginDetailFields
          }
        }
        ...ErrorFields
      }
    }
  `,
  [PluginFields, ErrorFields],
);
const PluginCheck = graphql(
  `
    mutation PluginCheck($name: String!) {
      pluginCheck(name: $name) {
        __typename
        ... on PluginCheckPayload {
          ok
          message
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const PluginTaskRun = graphql(
  `
    mutation PluginTaskRun($name: String!, $task: String!) {
      pluginTaskRun(name: $name, task: $task) {
        __typename
        ... on PluginTaskRunPayload {
          task {
            name
            lastStatus
            lastError
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const PluginDeliveryRetry = graphql(`mutation PluginDeliveryRetry($id: ID!) { pluginDeliveryRetry(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);

/** The API's settings as SettingsForm takes them. */
const descriptors = (settings: readonly Setting[] | null | undefined): SettingDescriptor[] =>
  (settings ?? []).flatMap((s) =>
    s.key ? [{ ...s, key: s.key, label: s.label ?? s.key, type: s.type ?? "STRING", options: s.options?.map((o) => ({ value: o.value ?? "", label: o.label ?? o.value ?? "" })) ?? null }] : [],
  );

const ZONES: Record<WidgetZone, string> = { "order.detail": "Orders", "product.detail": "Products", "customer.detail": "Customers", dashboard: "Dashboard" };
const HOOKS: Record<string, string> = { checkoutValidate: "Checkout validation" };

/** "Every 15 minutes", "Every 6 hours", "Every day". */
const every = (minutes: number | null | undefined) => {
  if (!minutes) return "—";
  if (minutes % 1440 === 0) return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
};

export const PluginSettingsPage = () => {
  const { name } = useParams({ strict: false }) as { name: string };
  const query = useQuery({
    queryKey: ["plugins", "detail", name],
    queryFn: ({ signal }) => request(PluginQuery, { name }, { signal }),
    // Follow a task someone started until it finishes.
    refetchInterval: (q) => (q.state.data?.plugin?.tasks?.some((t) => t.lastStatus === "running") ? 5_000 : false),
  });
  if (query.isLoading) {
    return (
      <Page>
        <Skeleton className="mb-6 h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  }
  const plugin = query.data?.plugin;
  if (!plugin) {
    return (
      <Page>
        <EmptyState
          icon={Puzzle}
          title="Plugin not found"
          description={query.error instanceof Error ? query.error.message : `No plugin called “${name}” is installed.`}
          action={
            <Button asChild variant="outline">
              <Link to="/settings/plugins">Back to plugins</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return <PluginEditor key={name} name={name} plugin={plugin} />;
};

const PluginEditor = ({ name, plugin }: { name: string; plugin: Plugin }) => {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const write = can("settings:write");
  const title = plugin.title ?? name;
  const module = usePluginModule(name);
  const Panel = module.data?.definition.settings;

  // The generated form; `initial` holds the last saved values.
  const fields = descriptors(plugin.settings);
  const [initial, setInitial] = useState(() => initialSettingValues(fields));
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const patch = Panel ? {} : changedSettings(fields, initial, values);
  const dirty = write && Object.keys(patch).length > 0;
  const unsaved = useUnsavedChanges(dirty);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);

  /** Show the mutation's answer at once; the list and navigation catch up behind. */
  const applied = (plugin: Plugin | null | undefined) => {
    if (plugin) queryClient.setQueryData(["plugins", "detail", name], { plugin });
    void queryClient.invalidateQueries({ queryKey: ["plugins"] });
  };
  const save = useAction(async (settings: Record<string, unknown>) => unwrap((await request(PluginUpdate, { name, input: { settings } })).pluginUpdate), {
    success: "Settings saved",
    onSuccess: (payload) => {
      const next = initialSettingValues(descriptors(payload.plugin?.settings));
      setInitial(next);
      setValues(next);
      setErrors({});
      // A connection test result was about the settings before.
      setCheck(null);
      applied(payload.plugin);
    },
    onError: (error) => {
      const fieldErrors = settingsErrors(error);
      if (!Object.keys(fieldErrors).length) return reportError(error);
      setErrors(fieldErrors);
      toast.error(error instanceof Error ? error.message : "The settings were not saved");
      focusFirstError();
    },
  });
  const submit = () => {
    if (!dirty || save.isPending) return;
    const problems = validateSettings(fields, values);
    setErrors(problems);
    if (Object.keys(problems).length) focusFirstError();
    else save.mutate(patch);
  };
  useSaveShortcut(submit, dirty);

  const toggle = useAction(async (enabled: boolean) => unwrap((await request(PluginUpdate, { name, input: { enabled } })).pluginUpdate), {
    success: (payload) => (!payload.plugin?.enabled ? `${title} is off` : payload.plugin.configured ? `${title} is on` : `${title} is on; it starts once its required settings are filled in`),
    onSuccess: (payload) => applied(payload.plugin),
  });
  const test = useAction(async () => unwrap((await request(PluginCheck, { name })).pluginCheck), { onSuccess: (result) => setCheck({ ok: !!result.ok, message: result.message ?? "" }) });

  /** For a plugin's own settings panel, which shows its own failures. */
  const savePanel = async (settings: Record<string, unknown>) => {
    const payload = unwrap((await request(PluginUpdate, { name, input: { settings } })).pluginUpdate);
    toast.success("Settings saved");
    applied(payload.plugin);
  };
  const info: PluginInfo = {
    name,
    title,
    version: plugin.version ?? "",
    description: plugin.description ?? null,
    enabled: !!plugin.enabled,
    configured: !!plugin.configured,
    active: !!plugin.active,
    missingSettings: [...(plugin.missingSettings ?? [])],
    settings: fields,
  };

  const missing = missingLabels(plugin);
  const errorCount = Object.keys(errors).length;
  const form = fields.length ? (
    <SettingsForm
      fields={fields}
      values={values}
      onChange={(next) => {
        setValues(next);
        // A field's error goes once it is edited.
        setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => next[key] === values[key])));
      }}
      errors={errors}
      disabled={!write}
    />
  ) : (
    <p className="text-[13px] text-muted-foreground">This plugin has no settings.</p>
  );

  return (
    <Page>
      <PageHeader
        back={{ to: "/settings/plugins", label: "Plugins" }}
        title={title}
        badges={
          <>
            <PluginStatus plugin={plugin} />
            <Badge variant="outline" className="font-mono">
              {plugin.version}
            </Badge>
          </>
        }
        description={plugin.description}
        actions={
          write ? (
            <>
              {plugin.canCheck ? (
                <Tooltip content="Checks the saved settings with the service">
                  <Button variant="outline" loading={test.isPending} onClick={() => test.mutate(undefined)}>
                    {test.isPending ? null : <PlugZap />}
                    Test connection
                  </Button>
                </Tooltip>
              ) : null}
              <Label className="h-9 rounded-md border px-3 font-normal">
                <Switch checked={toggle.isPending ? toggle.variables : !!plugin.enabled} disabled={toggle.isPending} onCheckedChange={(on) => toggle.mutate(on)} />
                Enabled
              </Label>
            </>
          ) : null
        }
      />

      {check ? (
        <Alert
          variant={check.ok ? "success" : "destructive"}
          title={check.ok ? "The connection works" : "The connection failed"}
          className="mb-6"
          action={
            <Button variant="ghost" size="icon-sm" className="-my-1" onClick={() => setCheck(null)} aria-label="Dismiss">
              <X />
            </Button>
          }
        >
          {check.message}
        </Alert>
      ) : null}

      <TwoColumn
        main={
          <>
            <SettingsCard title="Settings" description="Changes apply within seconds, without a deploy.">
              <div className="flex flex-col gap-5 px-5 pb-5">
                {missing.length ? (
                  <Alert variant="warning" title="Needs setup">
                    {plugin.enabled ? "The plugin starts" : "The plugin can start"} once {missing.length === 1 ? "this setting has a value" : "these settings have values"}: {missing.join(", ")}.
                  </Alert>
                ) : null}
                {plugin.hasAdmin && module.isLoading ? (
                  <Skeleton className="h-40" />
                ) : Panel && module.data ? (
                  <PluginScope plugin={module.data}>
                    <PluginBoundary plugin={name} fallback={(error) => <Alert variant="destructive" title="The plugin's settings panel failed">{error.message}</Alert>}>
                      <Suspense fallback={<Skeleton className="h-40" />}>
                        <Panel plugin={info} save={savePanel} canEdit={write} />
                      </Suspense>
                    </PluginBoundary>
                  </PluginScope>
                ) : (
                  form
                )}
              </div>
            </SettingsCard>
            {plugin.tasks?.length ? <Tasks name={name} tasks={plugin.tasks} active={!!plugin.active} write={write} /> : null}
            {plugin.capabilities?.events?.length ? <Deliveries deliveries={[...(plugin.failed ?? []), ...(plugin.dead ?? [])]} write={write} /> : null}
          </>
        }
        side={
          <>
            <Provides name={name} plugin={plugin} />
            {plugin.hasAdmin ? <AdminPages name={name} active={!!plugin.active} module={module} /> : null}
            {plugin.permissions?.length ? (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Permissions</CardTitle>
                    <CardDescription>
                      Grant them to roles under{" "}
                      {can("staff:read") ? (
                        <Link to="/system/roles" className="text-primary hover:underline">
                          System › Roles
                        </Link>
                      ) : (
                        "System › Roles"
                      )}
                      .
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <dl className="flex flex-col gap-3">
                    {plugin.permissions.map((p) => (
                      <div key={p.code ?? ""}>
                        <dt className="font-mono text-xs">{p.code}</dt>
                        <dd className="text-[13px] text-muted-foreground">{p.description}</dd>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            ) : null}
          </>
        }
      />

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={submit}
          onDiscard={() => {
            setValues(initial);
            setErrors({});
          }}
          problem={errorCount ? `${errorCount} ${errorCount === 1 ? "setting" : "settings"} to fix` : undefined}
        />
      ) : null}
      {unsaved.dialog}
    </Page>
  );
};

/** One row of "What it adds"; values may be long lists of event names. */
const Adds = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1">
    <dt className="text-[13px] text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-[13px] break-words">{children}</dd>
  </div>
);

const Provides = ({ name, plugin }: { name: string; plugin: Plugin }) => {
  const c = plugin.capabilities;
  const rows = c
    ? [
        c.paymentProviders?.length ? (
          <Adds key="payments" label="Payment providers">
            <Chips items={c.paymentProviders} max={20} />
            <Link to="/settings/payments" className="mt-1.5 block text-xs text-primary hover:underline">
              Use in a payment method
            </Link>
          </Adds>
        ) : null,
        c.shippingProviders?.length ? (
          <Adds key="shipping" label="Shipping providers">
            <Chips items={c.shippingProviders} max={20} />
            <Link to="/settings/shipping" className="mt-1.5 block text-xs text-primary hover:underline">
              Use in a shipping method
            </Link>
          </Adds>
        ) : null,
        c.events?.length ? (
          <Adds key="events" label="Handles events">
            <Chips items={c.events} max={20} />
          </Adds>
        ) : null,
        c.emits?.length ? (
          <Adds key="emits" label="Emits events">
            <Chips items={c.emits} max={20} />
          </Adds>
        ) : null,
        c.hooks?.length ? (
          <Adds key="hooks" label="Hooks">
            <Chips items={c.hooks.map((hook) => HOOKS[hook] ?? hook)} max={20} />
          </Adds>
        ) : null,
        c.tasks?.length ? (
          <Adds key="tasks" label="Scheduled tasks">
            <Chips items={c.tasks} max={20} />
          </Adds>
        ) : null,
        c.graphql ? (
          <Adds key="graphql" label="GraphQL">
            Types and fields in the API
          </Adds>
        ) : null,
        c.routes ? (
          <Adds key="routes" label="HTTP routes">
            <code className="font-mono text-xs">/plugins/{name}/</code>
          </Adds>
        ) : null,
        c.migrations ? (
          <Adds key="migrations" label="Database">
            Tables of its own
          </Adds>
        ) : null,
        c.admin ? (
          <Adds key="admin" label="Admin">
            Pages and widgets
          </Adds>
        ) : null,
      ].filter(Boolean)
    : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>What it adds</CardTitle>
      </CardHeader>
      <CardContent>{rows.length ? <dl className="flex flex-col gap-3">{rows}</dl> : <p className="text-[13px] text-muted-foreground">Settings only.</p>}</CardContent>
    </Card>
  );
};

/** Links to the plugin's pages that take no parameters, and where its widgets show. */
const AdminPages = ({ name, active, module }: { name: string; active: boolean; module: ReturnType<typeof usePluginModule> }) => {
  const definition = module.data?.definition;
  const pages = (definition?.pages ?? []).filter((page) => !page.path.includes("$"));
  const zones = [...new Set((definition?.widgets ?? []).map((widget) => ZONES[widget.zone]))];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin pages</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-[13px]">
        {!bundledPlugin(name) ? (
          <p className="text-muted-foreground">This build of the admin doesn't include the plugin's pages. Build the admin again (pnpm admin:build) to add them.</p>
        ) : module.isLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : module.error ? (
          <p className="text-destructive">The plugin's admin module failed to load: {module.error.message}</p>
        ) : (
          <>
            {pages.length ? (
              <ul className="flex flex-col gap-1">
                {pages.map((page) => (
                  <li key={page.path}>
                    {active ? (
                      <Link to={pluginPath(name, page.path)} className="text-primary hover:underline">
                        {page.title}
                      </Link>
                    ) : (
                      page.title
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {zones.length ? <p className="text-muted-foreground">Widgets on: {zones.join(", ")}</p> : null}
            {!active ? <p className="text-xs text-muted-foreground">They show while the plugin is active.</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
};

const Tasks = ({ name, tasks, active, write }: { name: string; tasks: readonly Task[]; active: boolean; write: boolean }) => {
  const run = useAction(async (task: string) => unwrap((await request(PluginTaskRun, { name, task })).pluginTaskRun), {
    invalidate: [["plugins"]],
    onSuccess: (payload, task) => {
      if (payload.task?.lastStatus === "failed") toast.error(`${task} failed`, { description: payload.task.lastError ?? undefined });
      else toast.success(`${task} ran`);
    },
  });
  return (
    <SettingsCard title="Scheduled tasks" description="The worker runs each at most once per interval while the plugin is active.">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Task</TableHead>
            <TableHead>Interval</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Result</TableHead>
            {write ? <TableHead className="w-28" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.name ?? ""}>
              <TableCell className="min-w-48">
                <span className="font-mono text-[13px] whitespace-nowrap">{task.name}</span>
                {task.description ? <p className="text-xs text-muted-foreground">{task.description}</p> : null}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{every(task.intervalMinutes)}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {task.lastStartedAt ? (
                  <Tooltip content={formatDateTime(task.lastStartedAt)}>
                    <span>{relativeTime(task.lastStartedAt)}</span>
                  </Tooltip>
                ) : (
                  "Never"
                )}
              </TableCell>
              <TableCell>
                {task.lastStatus ? <StatusBadge value={task.lastStatus.toUpperCase()} /> : <span className="text-muted-foreground">—</span>}
                {task.lastError ? (
                  <p className="mt-1 line-clamp-2 max-w-72 text-xs break-words text-destructive" title={task.lastError}>
                    {task.lastError}
                  </p>
                ) : null}
              </TableCell>
              {write ? (
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    loading={run.isPending && run.variables === task.name}
                    disabled={!active || task.lastStatus === "running" || run.isPending}
                    onClick={() => run.mutate(task.name ?? "")}
                  >
                    {run.isPending && run.variables === task.name ? null : <Play />}
                    Run now
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsCard>
  );
};

const Deliveries = ({ deliveries, write }: { deliveries: readonly Delivery[]; write: boolean }) => {
  const retry = useAction(async (id: string) => unwrap((await request(PluginDeliveryRetry, { id })).pluginDeliveryRetry), { success: "Queued for another attempt", invalidate: [["plugins"]] });
  const rows = [...deliveries].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  return (
    <SettingsCard title="Failed event deliveries" description="Events its handlers could not process. Failed ones are retried with backoff; dead ones ran out of attempts.">
      {rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="No failed deliveries" className="py-8" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Event</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Attempts</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>When</TableHead>
              {write ? <TableHead className="w-24" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id ?? ""}>
                <TableCell>
                  <span className="font-mono text-[13px] whitespace-nowrap">{d.eventType}</span>
                  {d.handler !== d.eventType ? <p className="font-mono text-xs whitespace-nowrap text-muted-foreground">{d.handler}</p> : null}
                </TableCell>
                <TableCell>
                  <StatusBadge value={d.status} />
                </TableCell>
                <TableCell className="tabular text-right">{d.attempts}</TableCell>
                <TableCell>
                  <p className="line-clamp-2 max-w-72 text-xs break-words text-muted-foreground" title={d.lastError ?? undefined}>
                    {d.lastError ?? "—"}
                  </p>
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <Tooltip content={`Created ${formatDateTime(d.createdAt)}`}>
                    <span>{d.status === "DEAD" ? `Gave up · ${relativeTime(d.createdAt)}` : `Next ${relativeTime(d.nextAttemptAt)}`}</span>
                  </Tooltip>
                </TableCell>
                {write ? (
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" loading={retry.isPending && retry.variables === d.id} disabled={retry.isPending || !d.id} onClick={() => d.id && retry.mutate(d.id)}>
                      {retry.isPending && retry.variables === d.id ? null : <RotateCw />}
                      Retry
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsCard>
  );
};
