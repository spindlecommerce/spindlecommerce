import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, Copy, ExternalLink, KeyRound, MonitorSmartphone, Plus, RefreshCw, Rocket, TriangleAlert, Undo2, Webhook } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader, TwoColumn } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Alert, Detail, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { MutationError, request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { copyText, useAction, useReference } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { ListSearch } from "@/router";
import { invalidateMatching } from "../builder/library/queries";
import { CodeBlock, InlineCode } from "../builder/library/ui";
import { RowActions } from "./shared";

const FrontendsQuery = graphql(`
  query StorefrontSettings {
    frontends {
      id
      name
      url
      previewPath
      revalidatePath
      hasDeployHook
      deployHookHost
      isDefault
      lastDeployAt
      lastDeployStatus
      defaultChannel {
        id
        name
        code
      }
      webhookSubscription {
        id
        name
        url
        isActive
        events
        deliveries(limit: 1) {
          id
          eventType
          status
          lastStatusCode
          lastError
          deliveredAt
          createdAt
        }
      }
    }
  }
`);

const FrontendCreate = graphql(
  `
    mutation StorefrontSettingsCreate($input: FrontendInput!) {
      frontendCreate(input: $input) {
        __typename
        ... on FrontendPayload {
          frontend {
            id
            name
          }
          revalidateSecret
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const FrontendUpdate = graphql(
  `
    mutation StorefrontSettingsUpdate($id: ID!, $input: FrontendInput!) {
      frontendUpdate(id: $id, input: $input) {
        __typename
        ... on FrontendPayload {
          frontend {
            id
            name
          }
          revalidateSecret
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const FrontendDelete = graphql(
  `
    mutation StorefrontSettingsDelete($id: ID!) {
      frontendDelete(id: $id) {
        __typename
        ... on DeletePayload {
          deletedId
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const FrontendDeploy = graphql(
  `
    mutation StorefrontSettingsDeploy($id: ID!) {
      frontendDeploy(id: $id) {
        __typename
        ... on FrontendPayload {
          frontend {
            id
            lastDeployAt
            lastDeployStatus
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

type Frontend = NonNullable<ResultOf<typeof FrontendsQuery>["frontends"]>[number];

const FRONTENDS_KEY = ["builder-frontends"] as const;
const DEFAULT_PREVIEW_PATH = "/api/draft";
const DEFAULT_REVALIDATE_PATH = "/api/revalidate";
const PATH = /^\/[A-Za-z0-9/_.-]*$/;
/** Must match REVALIDATE_EVENTS in src/modules/builder/frontends.ts. */
const REVALIDATE_EVENTS = ["page.*", "release.published", "product.*", "category.*", "content.updated", "component.updated"];

/** Mirrors the API's webhook guard, which refuses private hosts unless they're allowed. */
const isPrivateUrl = (value: string) => {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host === "0.0.0.0" || host === "::1") return true;
  if (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || !octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

const validUrl = (value: string) => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** The API's own base URL: the admin is served from it at <api>/admin/. */
const apiBase = () => (typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname.replace(/\/admin(\/.*)?$/, "")}`);

export const StorefrontsPage = () => {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const manage = can("settings:write");
  const deploys = can("content:write");
  const query = useQuery({ queryKey: [...FRONTENDS_KEY], queryFn: ({ signal }) => request(FrontendsQuery, undefined, { signal }) });
  const [editing, setEditing] = useState<Frontend | "new" | null>(null);
  const [deleting, setDeleting] = useState<Frontend | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const frontends = query.data?.frontends ?? [];
  const refresh = () => invalidateMatching(queryClient, /frontend|storefront/i);

  const deploy = useAction(async (id: string) => unwrap((await request(FrontendDeploy, { id })).frontendDeploy).frontend, {
    onSuccess: (frontend) => {
      const status = frontend?.lastDeployStatus ?? "";
      if (status.startsWith("Triggered")) toast.success("Deploy triggered", { description: `${status}. The host rebuilds the site now.` });
      else toast.error("The deploy hook did not accept the request", { description: status || undefined });
      void refresh();
    },
  });

  const remove = useAction(async (id: string) => unwrap((await request(FrontendDelete, { id })).frontendDelete), {
    success: "Storefront deleted",
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <Page>
      <PageHeader
        title="Storefronts"
        description="Frontend apps the page builder previews pages in, revalidates when content is published and redeploys. Editors' previews open in the default storefront."
        actions={
          manage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add storefront
            </Button>
          ) : null
        }
      />
      <TwoColumn
        main={
          query.isLoading ? (
            <>
              <Skeleton className="h-64 rounded-xl" />
            </>
          ) : query.error ? (
            <Card>
              <EmptyState icon={MonitorSmartphone} title="Could not load storefronts" description={query.error instanceof Error ? query.error.message : undefined} />
            </Card>
          ) : frontends.length === 0 ? (
            <Card>
              <EmptyState
                icon={MonitorSmartphone}
                title="No storefronts yet"
                description="Add the storefront app so editors can preview drafts in it and published changes reach it straight away."
                action={
                  manage ? (
                    <Button onClick={() => setEditing("new")}>
                      <Plus />
                      Add storefront
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            frontends.map((frontend) => (
              <FrontendCard
                key={frontend.id}
                frontend={frontend}
                manage={manage}
                canDeploy={deploys}
                showDeliveries={can("integrations:read")}
                deploying={deploy.isPending && deploy.variables === frontend.id}
                onDeploy={() => deploy.mutate(frontend.id)}
                onEdit={() => setEditing(frontend)}
                onDelete={() => setDeleting(frontend)}
              />
            ))
          )
        }
        side={<ConnectGuide />}
      />

      {editing !== null ? (
        <FrontendDialog
          key={editing === "new" ? "new" : editing.id}
          frontend={editing === "new" ? null : editing}
          first={frontends.length === 0}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            void refresh();
            if (result.secret) setSecret({ name: result.name, secret: result.secret });
          }}
        />
      ) : null}
      <SecretDialog value={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "the storefront"}?`}
        description="Previews and deploys through it stop, and its revalidation webhook subscription is deleted. The storefront app itself is not touched."
        destructive
        confirmLabel="Delete storefront"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  );
};

// ---------------------------------------------------------------- one storefront

const deliveryText = (delivery: NonNullable<NonNullable<Frontend["webhookSubscription"]>["deliveries"]>[number] | undefined) => {
  if (!delivery) return { text: "No events delivered yet", tone: "text-muted-foreground" };
  const event = delivery.eventType ? ` (${delivery.eventType})` : "";
  if (delivery.status === "SUCCEEDED") return { text: `Last delivery succeeded ${relativeTime(delivery.deliveredAt)}${event}`, tone: "text-muted-foreground" };
  if (delivery.status === "PENDING") return { text: `Delivering${event}`, tone: "text-muted-foreground" };
  const why = delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : (delivery.lastError ?? "failed");
  return { text: `Last delivery ${delivery.status === "DEAD" ? "gave up" : "failed, retrying"}: ${why}${event}`, tone: "text-destructive" };
};

const FrontendCard = ({
  frontend: f,
  manage,
  canDeploy,
  showDeliveries,
  deploying,
  onDeploy,
  onEdit,
  onDelete,
}: {
  frontend: Frontend;
  manage: boolean;
  canDeploy: boolean;
  showDeliveries: boolean;
  deploying: boolean;
  onDeploy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const subscription = f.webhookSubscription;
  const delivery = deliveryText(subscription?.deliveries?.[0]);
  const deployFailed = !!f.lastDeployStatus && !f.lastDeployStatus.startsWith("Triggered");
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MonitorSmartphone className="size-5" />
          </span>
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {f.name}
              {f.isDefault ? (
                <Tooltip content="Previews open here unless the editor picks another storefront.">
                  <Badge>Default</Badge>
                </Tooltip>
              ) : null}
            </CardTitle>
            <a href={f.url ?? "#"} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
              <span className="truncate">{f.url}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canDeploy && f.hasDeployHook ? (
            <Button variant="outline" size="sm" loading={deploying} onClick={onDeploy}>
              {deploying ? null : <Rocket />}
              Deploy
            </Button>
          ) : null}
          {manage ? <RowActions onEdit={onEdit} onDelete={onDelete} deleteLabel="Delete storefront" /> : null}
        </div>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Detail label="Preview route">
            <InlineCode>{f.previewPath}</InlineCode>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {f.url}
              {f.previewPath}?token=…&amp;path=…
            </p>
          </Detail>
          <Detail label="Revalidate on publish">
            {f.revalidatePath ? (
              <div className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" dot>
                    On
                  </Badge>
                  <InlineCode>{f.revalidatePath}</InlineCode>
                </span>
                {subscription ? (
                  <>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Webhook className="size-3.5" />
                      {subscription.name}
                      {subscription.isActive ? null : <Badge variant="warning">Paused</Badge>}
                      {showDeliveries ? (
                        <Link to="/system/webhooks" search={{ tab: "deliveries", subscription: subscription.id } as ListSearch} className="text-primary hover:underline">
                          Deliveries
                        </Link>
                      ) : null}
                    </span>
                    <span className={cn("text-xs", delivery.tone)}>{delivery.text}</span>
                  </>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-warning">
                    <TriangleAlert className="size-3.5" />
                    Its webhook subscription is missing; save the storefront to recreate it.
                  </span>
                )}
              </div>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Off</Badge>
                <span className="text-xs text-muted-foreground">Published changes appear when the storefront's cache expires.</span>
              </span>
            )}
          </Detail>
          <Detail label="Deploy hook">
            {f.hasDeployHook ? (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5">
                  <KeyRound className="size-3.5 text-muted-foreground" />
                  <span className="font-mono text-[13px]">{f.deployHookHost}</span>
                </span>
                {f.lastDeployAt ? (
                  <span className={cn("text-xs", deployFailed ? "text-destructive" : "text-muted-foreground")} title={formatDateTime(f.lastDeployAt)}>
                    Last deploy {relativeTime(f.lastDeployAt)}: {f.lastDeployStatus}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not deployed from here yet</span>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">None, for server-rendered storefronts</span>
            )}
          </Detail>
          <Detail label="Default channel">{f.defaultChannel ? f.defaultChannel.name : <span className="text-muted-foreground">The API's default channel</span>}</Detail>
        </dl>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------- create / edit

type FrontendForm = {
  name: string;
  url: string;
  previewPath: string;
  revalidate: boolean;
  revalidatePath: string;
  deployHookUrl: string;
  clearDeployHook: boolean;
  defaultChannelId: string;
  isDefault: boolean;
};

const FrontendDialog = ({ frontend, first, onClose, onSaved }: { frontend: Frontend | null; first: boolean; onClose: () => void; onSaved: (result: { name: string; secret: string | null }) => void }) => {
  const { channels } = useReference();
  const [refused, setRefused] = useState<string | null>(null);
  const form = useForm<FrontendForm>({
    defaultValues: {
      name: frontend?.name ?? "",
      url: frontend?.url ?? "",
      previewPath: frontend?.previewPath ?? DEFAULT_PREVIEW_PATH,
      revalidate: frontend ? !!frontend.revalidatePath : true,
      revalidatePath: frontend?.revalidatePath ?? DEFAULT_REVALIDATE_PATH,
      deployHookUrl: "",
      clearDeployHook: false,
      defaultChannelId: frontend?.defaultChannel?.id ?? "",
      isDefault: frontend?.isDefault ?? first,
    },
  });
  const [url, previewPath, revalidate, revalidatePath, clearDeployHook, deployHookUrl] = form.watch(["url", "previewPath", "revalidate", "revalidatePath", "clearDeployHook", "deployHookUrl"]);
  const webhookTarget = revalidate && validUrl(url.trim()) ? `${url.trim().replace(/\/+$/, "")}${revalidatePath.trim() || DEFAULT_REVALIDATE_PATH}` : null;
  const privateTarget = !!webhookTarget && isPrivateUrl(webhookTarget);
  // A refusal is about the URL that was sent; editing it clears the explanation.
  useEffect(() => setRefused(null), [url, revalidate, revalidatePath]);
  const turningOn = revalidate && !frontend?.revalidatePath;

  const save = useAction(
    async (v: FrontendForm) => {
      const input = {
        name: v.name.trim(),
        url: v.url.trim().replace(/\/+$/, ""),
        previewPath: v.previewPath.trim() || DEFAULT_PREVIEW_PATH,
        revalidatePath: v.revalidate ? v.revalidatePath.trim() || DEFAULT_REVALIDATE_PATH : null,
        // Write-only: empty keeps the saved hook, an explicit null removes it.
        ...(v.deployHookUrl.trim() ? { deployHookUrl: v.deployHookUrl.trim() } : v.clearDeployHook ? { deployHookUrl: null } : {}),
        defaultChannelId: v.defaultChannelId || null,
        isDefault: v.isDefault,
      };
      if (frontend) return unwrap((await request(FrontendUpdate, { id: frontend.id, input })).frontendUpdate);
      return unwrap((await request(FrontendCreate, { input })).frontendCreate);
    },
    {
      success: frontend ? "Storefront saved" : "Storefront added",
      onSuccess: (payload, v) => onSaved({ name: payload.frontend?.name ?? v.name, secret: payload.revalidateSecret ?? null }),
      onError: (error) => {
        const hit = error instanceof MutationError ? error.fieldErrors.find((f) => /loopback|link-local|private/i.test(f.message)) : undefined;
        setRefused(hit ? hit.message : null);
        reportError(error, form, ["input"]);
      },
    },
  );
  const errors = form.formState.errors;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{frontend ? `Edit ${frontend.name}` : "Add a storefront"}</DialogTitle>
          <DialogDescription>Where the storefront runs and the routes the page builder calls on it.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={form.handleSubmit((v) => {
            setRefused(null);
            save.mutate(v);
          })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name?.message}>
              <Input autoFocus placeholder="Main storefront" maxLength={120} {...form.register("name", { validate: (v) => !!v.trim() || "Required" })} />
            </Field>
            <Field label="URL" required error={errors.url?.message} hint="The storefront's base URL, e.g. https://shop.example.com.">
              <Input
                type="url"
                className="font-mono"
                placeholder="https://shop.example.com"
                {...form.register("url", { validate: (v) => (!v.trim() ? "Required" : validUrl(v.trim()) ? true : "Enter an http(s) URL, e.g. https://shop.example.com") })}
              />
            </Field>
          </div>

          <Field label="Preview route" error={errors.previewPath?.message} hint={<>Turns on draft mode. Editors' previews open {url.trim() ? <InlineCode>{`${url.trim().replace(/\/+$/, "")}${previewPath.trim() || DEFAULT_PREVIEW_PATH}?token=…&path=…`}</InlineCode> : "it with ?token=…&path=…"}.</>}>
            <Input className="font-mono" placeholder={DEFAULT_PREVIEW_PATH} {...form.register("previewPath", { validate: (v) => !v.trim() || PATH.test(v.trim()) || "A path starting with /, e.g. /api/draft" })} />
          </Field>

          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <Label className="justify-between gap-4 font-normal">
              <span>
                <span className="block text-sm font-medium">Revalidate on publish</span>
                <span className="text-xs text-muted-foreground">Sends signed events (page publishes, releases, catalog and component changes) to a route on the storefront so it refreshes its cache right away.</span>
              </span>
              <Controller control={form.control} name="revalidate" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
            </Label>
            {revalidate ? (
              <>
                <Field label="Revalidate route" error={errors.revalidatePath?.message}>
                  <Input className="font-mono" placeholder={DEFAULT_REVALIDATE_PATH} {...form.register("revalidatePath", { validate: (v) => !revalidate || !v.trim() || PATH.test(v.trim()) || "A path starting with /, e.g. /api/revalidate" })} />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {turningOn ? "A webhook subscription is created and its signing secret is shown once, for the storefront's SPINDLE_REVALIDATE_SECRET." : "Its webhook subscription follows the URL and route."}
                </p>
                {refused ? (
                  <Alert variant="destructive" title="The API refused the revalidation URL">
                    <p>{refused}.</p>
                    <p className="mt-1">
                      Webhooks never target loopback or private addresses unless the API runs with <InlineCode>ALLOW_PRIVATE_WEBHOOK_URLS=true</InlineCode>. Set it in the API's <InlineCode>.env</InlineCode> for local development and restart it, use a public URL (e.g. a tunnel), or turn revalidation off.
                    </p>
                  </Alert>
                ) : privateTarget ? (
                  <Alert variant="warning" title="Local address">
                    The API only calls <InlineCode>{webhookTarget}</InlineCode> when it runs with <InlineCode>ALLOW_PRIVATE_WEBHOOK_URLS=true</InlineCode> (development only); otherwise saving is refused.
                  </Alert>
                ) : null}
              </>
            ) : frontend?.revalidatePath ? (
              <p className="text-xs text-warning">Saving deletes its webhook subscription; turning it back on creates a new secret.</p>
            ) : null}
          </div>

          <Field
            label="Deploy hook URL"
            error={errors.deployHookUrl?.message}
            hint={
              frontend?.hasDeployHook && !clearDeployHook
                ? "Leave empty to keep the saved hook; paste a new URL to replace it."
                : "For statically built sites: the build hook from Vercel, Netlify or Cloudflare Pages. Kept secret; only its host is shown."
            }
          >
            <div className="flex flex-col gap-2">
              {frontend?.hasDeployHook ? (
                clearDeployHook ? (
                  <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-dashed px-3 text-[13px] text-muted-foreground">
                    The hook to {frontend.deployHookHost} is removed when you save.
                    <Button type="button" variant="ghost" size="sm" className="-mr-2 h-7" onClick={() => form.setValue("clearDeployHook", false, { shouldDirty: true })}>
                      <Undo2 />
                      Undo
                    </Button>
                  </div>
                ) : (
                  <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 text-[13px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        Saved hook to <span className="font-mono">{frontend.deployHookHost}</span>
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-mr-2 h-7 text-destructive hover:text-destructive"
                      onClick={() => {
                        form.setValue("clearDeployHook", true, { shouldDirty: true });
                        form.setValue("deployHookUrl", "", { shouldDirty: true });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )
              ) : null}
              {clearDeployHook ? null : (
                <Input
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder={frontend?.hasDeployHook ? "Paste a new hook URL to replace it" : "https://api.vercel.com/v1/integrations/deploy/…"}
                  {...form.register("deployHookUrl", { validate: (v) => !v.trim() || validUrl(v.trim()) || "Enter the hook's http(s) URL" })}
                />
              )}
              {deployHookUrl.trim() && !deployHookUrl.trim().startsWith("https://") ? <p className="text-xs text-warning">Production APIs only accept https deploy hooks.</p> : null}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default channel" hint="Previews and links use it unless the editor picks another.">
              <NativeSelect {...form.register("defaultChannelId")}>
                <option value="">The API's default channel</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? c.code}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="flex items-end">
              <Label className="w-full justify-between gap-4 rounded-lg border px-3 py-2.5 font-normal">
                <span>
                  <span className="block text-sm">Default storefront</span>
                  <span className="text-xs text-muted-foreground">Previews open here.</span>
                </span>
                <Controller control={form.control} name="isDefault" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {frontend ? "Save storefront" : "Add storefront"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- secret, shown once

const REVALIDATE_ROUTE = `// app/api/revalidate/route.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";

export async function POST(request: Request) {
  const body = await request.text();
  const header = request.headers.get("x-spindle-signature") ?? "";
  const { t, v1 } = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  const expected = createHmac("sha256", process.env.SPINDLE_REVALIDATE_SECRET!).update(\`\${t}.\${body}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  if (!fresh || !v1 || !timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) return new Response("Bad signature", { status: 401 });
  const event = JSON.parse(body); // { id, type, occurredAt, data }
  revalidatePath(event.data?.path ?? "/", "layout");
  return Response.json({ revalidated: true });
}`;

const SecretDialog = ({ value, onClose }: { value: { name: string; secret: string } | null; onClose: () => void }) => {
  const env = value ? `SPINDLE_REVALIDATE_SECRET=${value.secret}` : "";
  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Revalidation secret for {value?.name}</DialogTitle>
          <DialogDescription>The storefront verifies that revalidation requests come from this API with it.</DialogDescription>
        </DialogHeader>
        <Alert variant="warning" title="This is the only time the secret is shown">
          Add it to the storefront's environment now. To get a new one, turn revalidation off, save, and turn it on again.
        </Alert>
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px]">Environment variable</Label>
          <div className="flex gap-2">
            <Input readOnly value={env} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="SPINDLE_REVALIDATE_SECRET line" />
            <Button type="button" variant="outline" onClick={() => void copyText(env, "Copied SPINDLE_REVALIDATE_SECRET")}>
              <Copy />
              Copy
            </Button>
          </div>
          <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => value && void copyText(value.secret, "Secret copied")}>
            Copy the secret alone
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px]">
            Requests carry <InlineCode>X-Spindle-Signature: t=…,v1=…</InlineCode>, where v1 is HMAC-SHA256 of <InlineCode>{"<t>.<body>"}</InlineCode> in hex. A Next.js route that checks it:
          </p>
          <CodeBlock code={REVALIDATE_ROUTE} copyLabel="Route copied" />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I have stored the secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------- guide

const GuideStep = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <li className="flex gap-3">
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{n}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      {children}
    </div>
  </li>
);

const ConnectGuide = () => {
  const bridge = `${apiBase()}/visual-editing/bridge.js`;
  return (
    <Card className="lg:sticky lg:top-20">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-muted-foreground" />
            Connect a Next.js storefront
          </CardTitle>
          <CardDescription>Three routes and a script make previews, visual editing and instant updates work.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="flex flex-col gap-5">
          <GuideStep n={1} title="Preview route">
            <p>
              Editors' previews open <InlineCode>{"<url><preview route>?token=…&path=/summer-sale"}</InlineCode> (plus locale and channel). Check the token with the storefront API's <InlineCode>previewSession</InlineCode> query, sent as{" "}
              <InlineCode>x-preview-token</InlineCode>, call <InlineCode>draftMode().enable()</InlineCode>, keep the token in an httpOnly cookie and redirect to <InlineCode>path</InlineCode>.
            </p>
            <p>In draft mode, send the token as <InlineCode>x-preview-token</InlineCode> on every storefront API request to get drafts.</p>
          </GuideStep>
          <GuideStep n={2} title="Visual editing bridge">
            <p>In draft mode, load the bridge and start it with the admin origin from <InlineCode>previewSession</InlineCode>:</p>
            <CodeBlock code={`<script src="${bridge}"></script>\nEcomVisualEditing.init({ adminOrigin, onRefresh: () => router.refresh() });`} copyLabel="Snippet copied" />
            <p>
              Mark components with <InlineCode>data-ecom-node</InlineCode> and <InlineCode>data-ecom-component</InlineCode>, and fields with <InlineCode>data-ecom-field</InlineCode>, so editors can click them in the preview.
            </p>
          </GuideStep>
          <GuideStep n={3} title="Revalidate route">
            <p>
              With revalidation on, the route receives signed POSTs for{" "}
              {REVALIDATE_EVENTS.map((e, i) => (
                <span key={e}>
                  {i ? ", " : ""}
                  <InlineCode>{e}</InlineCode>
                </span>
              ))}
              . Verify <InlineCode>X-Spindle-Signature</InlineCode> with <InlineCode>SPINDLE_REVALIDATE_SECRET</InlineCode>, then revalidate the affected paths or tags.
            </p>
          </GuideStep>
          <GuideStep n={4} title="Statically built sites">
            <p>Add the host's deploy hook; Deploy triggers a rebuild after a big release.</p>
          </GuideStep>
        </ol>
        <Alert variant="info" title="Local development">
          The API refuses webhooks to localhost and private networks unless it runs with <InlineCode>ALLOW_PRIVATE_WEBHOOK_URLS=true</InlineCode>. Set it in development to revalidate <InlineCode>http://localhost:3000</InlineCode>.
        </Alert>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The full guide is in <InlineCode>docs/visual-editing.md</InlineCode> (being written).
          </span>
        </p>
      </CardContent>
    </Card>
  );
};
