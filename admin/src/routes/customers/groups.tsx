import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { DataTable, type Column } from "@/components/data-table";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tooltip } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useListSearch, useReference } from "@/lib/hooks";

const GroupsQuery = graphql(`
  query CustomerGroups {
    customerGroups {
      id
      code
      name
      taxClass {
        id
        name
      }
    }
  }
`);

type Group = NonNullable<ResultOf<typeof GroupsQuery>["customerGroups"]>[number];

const CreateMutation = graphql(
  `
    mutation CustomerGroupCreate($code: String!, $name: String!, $taxClassId: ID) {
      customerGroupCreate(code: $code, name: $name, taxClassId: $taxClassId) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const UpdateMutation = graphql(
  `
    mutation CustomerGroupUpdate($id: ID!, $name: String, $taxClassId: ID) {
      customerGroupUpdate(id: $id, name: $name, taxClassId: $taxClassId) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

const DeleteMutation = graphql(
  `
    mutation CustomerGroupDelete($id: ID!) {
      customerGroupDelete(id: $id) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** Guest (not signed in) and General (the default for accounts): the platform needs both. */
const BUILT_IN = new Set(["guest", "general"]);

export const CustomerGroupsPage = () => {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [search] = useListSearch();
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const query = useQuery({ queryKey: ["customer-groups"], queryFn: ({ signal }) => request(GroupsQuery, undefined, { signal }) });
  const write = can("customers:write");
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["customer-groups"] }), queryClient.invalidateQueries({ queryKey: ["reference"] })]);

  const remove = useAction((group: Group) => request(DeleteMutation, { id: group.id }).then((r) => unwrap(r.customerGroupDelete)), {
    success: "Group deleted",
    invalidate: [["customers"]],
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  const needle = search.q?.toLowerCase() ?? "";
  const rows = (query.data?.customerGroups ?? []).filter((g) => !needle || `${g.name} ${g.code}`.toLowerCase().includes(needle));

  const columns: Column<Group>[] = [
    {
      id: "name",
      header: "Group",
      fixed: true,
      cell: (g) => (
        <span className="flex items-center gap-2 font-medium">
          {g.name}
          {BUILT_IN.has(g.code ?? "") ? <Badge variant="outline">Built-in</Badge> : null}
        </span>
      ),
      csv: (g) => g.name,
    },
    { id: "code", header: "Code", cell: (g) => <code className="font-mono text-xs">{g.code}</code>, csv: (g) => g.code },
    { id: "taxClass", header: "Customer tax class", cell: (g) => g.taxClass?.name ?? <span className="text-muted-foreground">None</span>, csv: (g) => g.taxClass?.name },
    ...(write
      ? [
          {
            id: "actions",
            header: "",
            fixed: true,
            align: "right" as const,
            cell: (g: Group) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon-sm" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}>
                  <Pencil />
                </Button>
                {BUILT_IN.has(g.code ?? "") ? (
                  <Tooltip content="Built-in groups cannot be deleted">
                    <span>
                      <Button variant="ghost" size="icon-sm" disabled aria-label={`Delete ${g.name}`}>
                        <Trash2 />
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        back={{ to: "/customers", label: "Customers" }}
        title="Customer groups"
        description="Groups decide which prices, promotions and customer tax class apply. Signed-out shoppers use the guest group."
        actions={
          write ? (
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add group
            </Button>
          ) : null
        }
      />
      <DataTable id="customer-groups" rows={rows} columns={columns} rowKey={(g) => g.id} loading={query.isLoading} error={query.error} onRowClick={write ? (g) => setEditing(g) : undefined} searchPlaceholder="Filter groups" total={rows.length} exportName="customer-groups" />
      {editing ? <GroupDialog group={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "group"}?`}
        description="Its customers move to the General group, its group prices are deleted, and promotions stop targeting it."
        destructive
        confirmLabel="Delete group"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Page>
  );
};

type GroupForm = { code: string; name: string; taxClassId: string };

const GroupDialog = ({ group, onClose, onSaved }: { group: Group | null; onClose: () => void; onSaved: () => Promise<unknown> }) => {
  const { taxClasses } = useReference();
  const form = useForm<GroupForm>({ defaultValues: { code: group?.code ?? "", name: group?.name ?? "", taxClassId: group?.taxClass?.id ?? "" } });
  const save = useAction(
    async (values: GroupForm) => {
      const taxClassId = values.taxClassId || null;
      if (group) return unwrap((await request(UpdateMutation, { id: group.id, name: values.name.trim(), taxClassId })).customerGroupUpdate);
      return unwrap((await request(CreateMutation, { code: values.code.trim(), name: values.name.trim(), taxClassId })).customerGroupCreate);
    },
    {
      success: group ? "Group saved" : "Group created",
      onSuccess: () => {
        onClose();
        void onSaved();
      },
      onError: (error) => reportError(error, form, []),
    },
  );
  const customerClasses = taxClasses.filter((c) => c.kind === "CUSTOMER");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent dirty={form.formState.isDirty}>
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name}` : "Add customer group"}</DialogTitle>
          <DialogDescription>Prices and promotions can target the group; its tax class feeds tax rules.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <Field label="Name" required error={form.formState.errors.name?.message}>
            <Input autoFocus {...form.register("name", { required: "Required" })} />
          </Field>
          <Field label="Code" required hint={group ? "Fixed once created." : "Lowercase letters, digits, - and _."} error={form.formState.errors.code?.message}>
            <Input disabled={!!group} className="font-mono" {...form.register("code", { required: "Required", pattern: { value: /^[a-z0-9_-]{1,40}$/, message: "Use lowercase letters, digits, - and _" } })} />
          </Field>
          <Field label="Customer tax class" hint="Tax rules match it with product tax classes.">
            <NativeSelect {...form.register("taxClassId")}>
              <option value="">None</option>
              {customerClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {group ? "Save group" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
