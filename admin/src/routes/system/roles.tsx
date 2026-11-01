import { useQuery } from "@tanstack/react-query";
import { Plus, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { ConfirmDialog, Sheet, SheetContent } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/hooks";
import { RowActions } from "../settings/shared";
import { PermissionAreasQuery, PermissionMatrix, PermissionSummary, type PermissionArea } from "./permission-matrix";

const RolesQuery = graphql(`
  query Roles {
    roles {
      id
      code
      name
      permissions
    }
    staffUsers {
      id
      name
      isActive
      roles {
        id
      }
    }
  }
`);

type Role = NonNullable<ResultOf<typeof RolesQuery>["roles"]>[number];

const RoleCreate = graphql(
  `
    mutation RoleCreate($code: String!, $name: String!, $permissions: [String!]!) {
      roleCreate(code: $code, name: $name, permissions: $permissions) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const RoleUpdate = graphql(
  `
    mutation RoleUpdate($id: ID!, $name: String, $permissions: [String!]) {
      roleUpdate(id: $id, name: $name, permissions: $permissions) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const RoleDelete = graphql(
  `
    mutation RoleDelete($id: ID!) {
      roleDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

export const RolesPage = () => {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ["roles"], queryFn: () => request(RolesQuery) });
  const areas = useQuery({ queryKey: ["permission-areas"], queryFn: () => request(PermissionAreasQuery), staleTime: Infinity });
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const write = can("staff:write");
  const roles = query.data?.roles ?? [];
  const staff = query.data?.staffUsers ?? [];
  const areaList = areas.data?.permissionAreas ?? [];
  const members = (role: Role) => staff.filter((s) => (s.roles ?? []).some((r) => r.id === role.id));

  const remove = useAction((id: string) => request(RoleDelete, { id }).then((r) => unwrap(r.roleDelete)), { success: "Role deleted", invalidate: [["roles"], ["staff"]], onSuccess: () => setDeleting(null) });

  return (
    <Page>
      <PageHeader
        title="Roles"
        description="A staff user's permissions are the union of their roles. Managing an area includes viewing it."
        actions={
          write ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add role
            </Button>
          ) : null
        }
      />
      {query.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : roles.length === 0 ? (
        <Card>
          <EmptyState icon={ShieldCheck} title="No roles" description="Create a role before inviting staff." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {roles.map((role) => {
            const people = members(role);
            return (
              <Card key={role.id} className="flex flex-col">
                <CardHeader>
                  <div>
                    <CardTitle>{role.name}</CardTitle>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{role.code}</p>
                  </div>
                  {write ? <RowActions onEdit={() => setEditing(role)} onDelete={() => setDeleting(role)} /> : null}
                </CardHeader>
                <CardContent className="flex-1">
                  <PermissionSummary permissions={role.permissions ?? []} areas={areaList} max={8} />
                </CardContent>
                <CardFooter className="text-[13px] text-muted-foreground">
                  <Users className="size-4" />
                  {people.length === 0 ? "Not assigned" : people.map((p) => p.name).join(", ")}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent aria-describedby={undefined} className="sm:w-[40rem]">
          {editing !== null ? <RoleEditor key={editing === "new" ? "new" : editing.id} role={editing === "new" ? null : editing} areas={areaList} onDone={() => setEditing(null)} /> : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete role ${deleting?.name ?? ""}?`}
        description={deleting && members(deleting).length ? `Assigned to ${members(deleting).length} staff user(s); reassign them first.` : "This cannot be undone."}
        destructive
        confirmLabel="Delete role"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Page>
  );
};

const RoleEditor = ({ role, areas, onDone }: { role: Role | null; areas: readonly PermissionArea[]; onDone: () => void }) => {
  const form = useForm<{ code: string; name: string }>({ defaultValues: { code: role?.code ?? "", name: role?.name ?? "" } });
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const save = useAction(
    async (v: { code: string; name: string }) => {
      if (role) return unwrap((await request(RoleUpdate, { id: role.id, name: v.name.trim(), permissions })).roleUpdate);
      return unwrap((await request(RoleCreate, { code: v.code.trim(), name: v.name.trim(), permissions })).roleCreate);
    },
    { success: role ? "Role saved" : "Role created", invalidate: [["roles"], ["staff"]], onSuccess: onDone, onError: (error) => reportError(error, form, ["input"]) },
  );
  const errors = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-5">
      <div>
        <h2 className="text-base font-semibold">{role ? `Edit ${role.name}` : "New role"}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Changes apply on each staff user's next request.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" required hint={role ? "Fixed once created." : "e.g. fulfillment"} error={errors.code?.message}>
          <Input disabled={!!role} className="font-mono" {...form.register("code", { required: !role && "Required", pattern: { value: /^[a-z0-9_-]{1,40}$/, message: "Lowercase letters, digits, - and _" } })} />
        </Field>
        <Field label="Name" required error={errors.name?.message}>
          <Input {...form.register("name", { required: "Required" })} />
        </Field>
      </div>
      <Field label="Permissions">
        <PermissionMatrix value={permissions} onChange={setPermissions} areas={areas} />
      </Field>
      <div className="sticky bottom-0 -mx-6 -mb-6 flex justify-end gap-2 border-t bg-popover px-6 py-4">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {role ? "Save role" : "Create role"}
        </Button>
      </div>
    </form>
  );
};
