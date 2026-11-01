import { useQuery } from "@tanstack/react-query";
import { Copy, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Alert, EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatDateTime, relativeTime } from "@/lib/format";
import { copyText, useAction } from "@/lib/hooks";
import { PermissionAreasQuery, PermissionMatrix, PermissionSummary, type PermissionArea } from "./permission-matrix";

const ApiKeysQuery = graphql(`
  query ApiKeys {
    apiKeys {
      id
      name
      prefix
      permissions
      lastUsedAt
      expiresAt
      revokedAt
      createdAt
    }
  }
`);

type ApiKey = NonNullable<ResultOf<typeof ApiKeysQuery>["apiKeys"]>[number];

const ApiKeyCreate = graphql(
  `
    mutation ApiKeyCreate($name: String!, $permissions: [String!]!, $expiresAt: DateTime) {
      apiKeyCreate(name: $name, permissions: $permissions, expiresAt: $expiresAt) {
        __typename
        ... on ApiKeyCreatePayload {
          secret
          apiKey {
            name
          }
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const ApiKeyRevoke = graphql(
  `
    mutation ApiKeyRevoke($id: ID!) {
      apiKeyRevoke(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const status = (key: ApiKey) => {
  if (key.revokedAt) return { label: "Revoked", variant: "secondary" as const };
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return { label: "Expired", variant: "warning" as const };
  return { label: "Active", variant: "success" as const };
};

export const ApiKeysPage = () => {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ["api-keys"], queryFn: () => request(ApiKeysQuery) });
  const areas = useQuery({ queryKey: ["permission-areas"], queryFn: () => request(PermissionAreasQuery), staleTime: Infinity });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const write = can("integrations:write");
  const areaList = areas.data?.permissionAreas ?? [];
  const keys = [...(query.data?.apiKeys ?? [])].reverse().filter((k) => showInactive || status(k).label === "Active");

  const revoke = useAction((id: string) => request(ApiKeyRevoke, { id }).then((r) => unwrap(r.apiKeyRevoke)), { success: "API key revoked", invalidate: [["api-keys"]], onSuccess: () => setRevoking(null) });

  return (
    <Page>
      <PageHeader
        title="API keys"
        description="Give each integration (ERP, PIM, warehouse, email service) its own key with only the permissions it needs. Keys authenticate as Authorization: Bearer <key> on the admin API."
        actions={
          write ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              Create API key
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
          <p className="text-[13px] text-muted-foreground">{keys.length} key{keys.length === 1 ? "" : "s"}</p>
          <Label className="text-[13px] font-normal">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} />
            Show revoked and expired
          </Label>
        </div>
        {query.isLoading ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="No API keys" description="Create a key for each integration that talks to the admin API." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Key</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => {
                const s = status(key);
                return (
                  <TableRow key={key.id} className={key.revokedAt ? "opacity-60" : undefined}>
                    <TableCell>
                      <span className="font-medium">{key.name}</span>
                      <p className="font-mono text-xs text-muted-foreground">ek_{key.prefix}_••••</p>
                    </TableCell>
                    <TableCell>
                      <PermissionSummary permissions={key.permissions ?? []} areas={areaList} max={4} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {key.lastUsedAt ? (
                        <Tooltip content={formatDateTime(key.lastUsedAt)}>
                          <span>{relativeTime(key.lastUsedAt)}</span>
                        </Tooltip>
                      ) : (
                        "Never"
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{key.expiresAt ? formatDate(key.expiresAt) : "Never"}</TableCell>
                    <TableCell>
                      <Badge variant={s.variant} dot>
                        {s.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {write && !key.revokedAt ? (
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(key)}>
                          Revoke
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      {creating ? (
        <CreateDialog
          areas={areaList}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setSecret(created);
          }}
        />
      ) : null}
      <SecretDialog value={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "key"}?`}
        description="Requests with this key fail immediately. This cannot be undone; create a new key instead."
        destructive
        confirmLabel="Revoke key"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Page>
  );
};

const EXPIRY = [
  { value: "", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In a year" },
  { value: "custom", label: "On a date…" },
];

const CreateDialog = ({ areas, onClose, onCreated }: { areas: readonly PermissionArea[]; onClose: () => void; onCreated: (created: { name: string; secret: string }) => void }) => {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("90");
  const [date, setDate] = useState("");
  const expiresAt = expiry === "" ? null : expiry === "custom" ? (date ? new Date(`${date}T23:59:59`).toISOString() : null) : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
  const create = useAction(
    async () => {
      const payload = unwrap((await request(ApiKeyCreate, { name: name.trim(), permissions, expiresAt })).apiKeyCreate);
      return { name: payload.apiKey?.name ?? name, secret: payload.secret ?? "" };
    },
    { invalidate: [["api-keys"]], onSuccess: onCreated },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Grant only what the integration needs. Write access to an area includes reading it.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required hint="Which integration uses it, e.g. Warehouse sync.">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Expires">
              <div className="flex gap-2">
                <NativeSelect value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  {EXPIRY.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
                {expiry === "custom" ? <Input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} required /> : null}
              </div>
            </Field>
          </div>
          <PermissionMatrix value={permissions} onChange={setPermissions} areas={areas} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim() || permissions.length === 0}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** The plaintext key exists only in this response; the server keeps a hash. */
const SecretDialog = ({ value, onClose }: { value: { name: string; secret: string } | null; onClose: () => void }) => (
  <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
    <DialogContent onInteractOutside={(e) => e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>Copy the key for {value?.name}</DialogTitle>
        <DialogDescription>Store it in the integration's secret manager now.</DialogDescription>
      </DialogHeader>
      <Alert variant="warning" title="This is the only time the key is shown">
        Only a hash is stored. If it is lost, revoke it and create another.
      </Alert>
      <div className="flex gap-2">
        <Input readOnly value={value?.secret ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" onClick={() => value && void copyText(value.secret, "Key copied")}>
          <Copy />
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{`curl ${location.origin}/admin/graphql \\\n  -H "Authorization: Bearer ${value?.secret.slice(0, 14) ?? ""}…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"query":"{ viewer { permissions } }"}'`}</pre>
      <DialogFooter>
        <Button onClick={onClose}>I have stored the key</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
