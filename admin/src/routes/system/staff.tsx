import { useQuery } from "@tanstack/react-query";
import { KeyRound, Lock, LockOpen, Plus, ShieldOff, UserPlus } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { DataTable, FilterSelect, type Column } from "@/components/data-table";
import { Field, FormSection, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { BooleanBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/combobox";
import { Switch } from "@/components/ui/controls";
import { Alert, Detail, Separator } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/input";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Sheet, SheetContent, Tooltip } from "@/components/ui/overlay";
import { ErrorFields, graphql, type ResultOf } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useAction, useListSearch } from "@/lib/hooks";

const StaffQuery = graphql(`
  query Staff {
    staffUsers {
      id
      name
      email
      isActive
      lastLoginAt
      passwordChangedAt
      lockedUntil
      twoFactorEnabled
      recoveryCodesRemaining
      createdAt
      roles {
        id
        code
        name
      }
    }
    roles {
      id
      code
      name
    }
  }
`);

type Staff = NonNullable<ResultOf<typeof StaffQuery>["staffUsers"]>[number];
type Role = NonNullable<ResultOf<typeof StaffQuery>["roles"]>[number];

const StaffCreate = graphql(`mutation StaffUserCreate($input: StaffUserInput!) { staffUserCreate(input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const StaffUpdate = graphql(`mutation StaffUserUpdate($id: ID!, $input: StaffUserUpdateInput!) { staffUserUpdate(id: $id, input: $input) { __typename ...ErrorFields } }`, [ErrorFields]);
const StaffUnlock = graphql(`mutation StaffUserUnlock($id: ID!) { staffUserUnlock(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);
const StaffSetPassword = graphql(`mutation StaffUserSetPassword($id: ID!, $password: String!) { staffUserSetPassword(id: $id, password: $password) { __typename ...ErrorFields } }`, [ErrorFields]);
const StaffResetTwoFactor = graphql(`mutation StaffUserResetTwoFactor($id: ID!) { staffUserResetTwoFactor(id: $id) { __typename ...ErrorFields } }`, [ErrorFields]);

const isLocked = (s: Staff) => !!s.lockedUntil && Date.parse(s.lockedUntil) > Date.now();

/** A random password that satisfies the 12-character minimum, for handing over out of band. */
const generatePassword = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  // Bytes past the last whole multiple of the alphabet's length would favour its first characters, so they are redrawn.
  const limit = 256 - (256 % alphabet.length);
  let password = "";
  while (password.length < 18) {
    for (const byte of crypto.getRandomValues(new Uint8Array(18 - password.length))) {
      if (byte < limit) password += alphabet.charAt(byte % alphabet.length);
    }
  }
  return password;
};

export const StaffPage = () => {
  const { can, viewer } = useAuth();
  const [search] = useListSearch();
  const query = useQuery({ queryKey: ["staff"], queryFn: () => request(StaffQuery) });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const write = can("staff:write");
  const q = search.q?.toLowerCase() ?? "";
  const rows = (query.data?.staffUsers ?? []).filter((s) => {
    if (q && !`${s.name} ${s.email}`.toLowerCase().includes(q)) return false;
    if (search.status === "ACTIVE") return !!s.isActive;
    if (search.status === "INACTIVE") return !s.isActive;
    if (search.status === "LOCKED") return isLocked(s);
    if (search.status === "NO_2FA") return !s.twoFactorEnabled;
    return true;
  });

  const columns: Column<Staff>[] = [
    {
      id: "name",
      header: "Name",
      fixed: true,
      cell: (s) => (
        <div>
          <span className="font-medium">{s.name}</span>
          {s.id === viewer?.staffUser?.id ? <Badge variant="secondary" className="ml-2">You</Badge> : null}
          <p className="text-xs text-muted-foreground">{s.email}</p>
        </div>
      ),
      csv: (s) => s.name,
    },
    { id: "email", header: "Email", cell: (s) => s.email, csv: (s) => s.email, hidden: true },
    { id: "roles", header: "Roles", cell: (s) => <span className="text-[13px]">{(s.roles ?? []).map((r) => r.name).join(", ") || "—"}</span>, csv: (s) => (s.roles ?? []).map((r) => r.code).join(" ") },
    {
      id: "status",
      header: "Status",
      cell: (s) =>
        isLocked(s) ? (
          <Tooltip content={`Locked until ${formatDateTime(s.lockedUntil)} after repeated failed sign-ins`}>
            <Badge variant="destructive" dot>
              Locked
            </Badge>
          </Tooltip>
        ) : (
          <BooleanBadge value={s.isActive} />
        ),
      csv: (s) => (isLocked(s) ? "locked" : s.isActive ? "active" : "inactive"),
    },
    { id: "twoFactor", header: "2FA", cell: (s) => (s.twoFactorEnabled ? <Badge variant="success">On</Badge> : <Badge variant="warning">Off</Badge>), csv: (s) => (s.twoFactorEnabled ? "on" : "off") },
    {
      id: "lastLogin",
      header: "Last sign-in",
      cell: (s) => (s.lastLoginAt ? <Tooltip content={formatDateTime(s.lastLoginAt)}><span className="text-muted-foreground">{relativeTime(s.lastLoginAt)}</span></Tooltip> : <span className="text-muted-foreground">Never</span>),
      csv: (s) => s.lastLoginAt,
    },
    { id: "created", header: "Added", cell: (s) => <span className="text-muted-foreground">{formatDateTime(s.createdAt)}</span>, csv: (s) => s.createdAt, hidden: true },
  ];

  const locked = (query.data?.staffUsers ?? []).filter(isLocked);
  return (
    <Page>
      <PageHeader
        title="Staff"
        description="Everyone who can sign in to this admin. Accounts lock for a while after repeated failed sign-ins."
        actions={
          write ? (
            <Button onClick={() => setCreating(true)}>
              <UserPlus />
              Add staff user
            </Button>
          ) : null
        }
      />
      {locked.length && write ? (
        <Alert variant="warning" className="mb-4" title={`${locked.length} locked account${locked.length === 1 ? "" : "s"}`}>
          {locked.map((s) => s.name).join(", ")} — open the account to unlock it now.
        </Alert>
      ) : null}
      <DataTable
        id="staff"
        rows={rows}
        columns={columns}
        rowKey={(s) => s.id}
        loading={query.isLoading}
        error={query.error}
        onRowClick={(s) => setEditing(s)}
        searchPlaceholder="Name or email"
        total={rows.length}
        exportName="staff"
        filters={
          <FilterSelect
            param="status"
            label="Status"
            options={[
              { value: "ACTIVE", label: "Active" },
              { value: "INACTIVE", label: "Inactive" },
              { value: "LOCKED", label: "Locked" },
              { value: "NO_2FA", label: "Without 2FA" },
            ]}
          />
        }
      />
      {creating ? <CreateDialog roles={query.data?.roles ?? []} onClose={() => setCreating(false)} /> : null}
      <Sheet open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent aria-describedby={undefined}>
          {editing ? (
            <StaffEditor
              key={editing.id}
              staff={(query.data?.staffUsers ?? []).find((s) => s.id === editing.id) ?? editing}
              roles={query.data?.roles ?? []}
              self={editing.id === viewer?.staffUser?.id}
              write={write}
              onDone={() => setEditing(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </Page>
  );
};

type CreateForm = { name: string; email: string; password: string; roleIds: string[] };

const CreateDialog = ({ roles, onClose }: { roles: Role[]; onClose: () => void }) => {
  const form = useForm<CreateForm>({ defaultValues: { name: "", email: "", password: generatePassword(), roleIds: [] } });
  const save = useAction((v: CreateForm) => request(StaffCreate, { input: { ...v, name: v.name.trim(), email: v.email.trim() } }).then((r) => unwrap(r.staffUserCreate)), {
    success: "Staff user created",
    invalidate: [["staff"], ["roles"], ["staff-names"]],
    onSuccess: onClose,
    onError: (error) => reportError(error, form),
  });
  const errors = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add staff user</DialogTitle>
          <DialogDescription>Share the password securely; they can change it and set up two-factor authentication under Account.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name?.message}>
              <Input {...form.register("name", { required: "Required" })} />
            </Field>
            <Field label="Email" required error={errors.email?.message}>
              <Input type="email" autoComplete="off" {...form.register("email", { required: "Required" })} />
            </Field>
          </div>
          <Field label="Initial password" required hint="At least 12 characters." error={errors.password?.message}>
            <div className="flex gap-2">
              <Input className="font-mono" autoComplete="new-password" {...form.register("password", { required: "Required", minLength: { value: 12, message: "Use at least 12 characters" } })} />
              <Button type="button" variant="outline" onClick={() => form.setValue("password", generatePassword())}>
                Generate
              </Button>
            </div>
          </Field>
          <Field label="Roles" required error={errors.roleIds?.message}>
            <Controller
              control={form.control}
              name="roleIds"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one role" }}
              render={({ field }) => <MultiSelect options={roles.map((r) => ({ value: r.id, label: r.name ?? r.code ?? "" }))} value={field.value} onChange={field.onChange} placeholder="Pick roles" />}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              <Plus />
              Add staff user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

type EditForm = { name: string; isActive: boolean; roleIds: string[] };

const StaffEditor = ({ staff, roles, self, write, onDone }: { staff: Staff; roles: Role[]; self: boolean; write: boolean; onDone: () => void }) => {
  const form = useForm<EditForm>({ defaultValues: { name: staff.name ?? "", isActive: staff.isActive ?? true, roleIds: (staff.roles ?? []).map((r) => r.id) } });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const save = useAction((v: EditForm) => request(StaffUpdate, { id: staff.id, input: { name: v.name.trim(), isActive: v.isActive, roleIds: v.roleIds } }).then((r) => unwrap(r.staffUserUpdate)), {
    success: "Staff user saved",
    invalidate: [["staff"], ["roles"], ["staff-names"]],
    onSuccess: onDone,
    onError: (error) => reportError(error, form),
  });
  const unlock = useAction(() => request(StaffUnlock, { id: staff.id }).then((r) => unwrap(r.staffUserUnlock)), { success: "Account unlocked", invalidate: [["staff"]] });
  const resetTwoFactor = useAction(() => request(StaffResetTwoFactor, { id: staff.id }).then((r) => unwrap(r.staffUserResetTwoFactor)), {
    success: "Two-factor authentication removed; they were signed out",
    invalidate: [["staff"]],
    onSuccess: () => setResetOpen(false),
  });
  const errors = form.formState.errors;
  const locked = isLocked(staff);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold">{staff.name}</h2>
        <p className="text-[13px] text-muted-foreground">{staff.email}</p>
      </div>
      {locked ? (
        <Alert
          variant="warning"
          title="Locked after repeated failed sign-ins"
          action={
            write ? (
              <Button size="sm" variant="outline" loading={unlock.isPending} onClick={() => unlock.mutate(undefined)}>
                <LockOpen />
                Unlock
              </Button>
            ) : undefined
          }
        >
          Until {formatDateTime(staff.lockedUntil)}.
        </Alert>
      ) : null}
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-5">
        <FormSection title="Account">
          <Field label="Name" required error={errors.name?.message}>
            <Input disabled={!write} {...form.register("name", { required: "Required" })} />
          </Field>
          <Field label="Roles" required hint={self ? "Removing your own roles can lock you out of these screens." : undefined} error={errors.roleIds?.message}>
            <Controller
              control={form.control}
              name="roleIds"
              rules={{ validate: (v) => v.length > 0 || "Pick at least one role" }}
              render={({ field }) => <MultiSelect options={roles.map((r) => ({ value: r.id, label: r.name ?? r.code ?? "" }))} value={field.value} onChange={field.onChange} disabled={!write} />}
            />
          </Field>
          <Label className="font-normal">
            <Controller control={form.control} name="isActive" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!write || self} />} />
            Active {self ? "(you cannot deactivate yourself)" : "— deactivating signs them out everywhere"}
          </Label>
        </FormSection>
        {write ? (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
          </div>
        ) : null}
      </form>
      <Separator />
      <FormSection title="Security">
        <dl>
          <Detail label="Two-factor">{staff.twoFactorEnabled ? `On · ${staff.recoveryCodesRemaining ?? 0} recovery codes left` : "Off"}</Detail>
          <Detail label="Last sign-in">{staff.lastLoginAt ? formatDateTime(staff.lastLoginAt) : "Never"}</Detail>
          <Detail label="Password changed">{staff.passwordChangedAt ? formatDateTime(staff.passwordChangedAt) : "—"}</Detail>
          <Detail label="Added">{formatDateTime(staff.createdAt)}</Detail>
        </dl>
        {write ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
              <KeyRound />
              Set a new password
            </Button>
            {staff.twoFactorEnabled && !self ? (
              <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
                <ShieldOff />
                Reset two-factor
              </Button>
            ) : null}
            {!locked ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="size-3.5" /> Not locked
              </span>
            ) : null}
          </div>
        ) : null}
      </FormSection>
      {passwordOpen ? <PasswordDialog staff={staff} onClose={() => setPasswordOpen(false)} /> : null}
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset two-factor authentication?"
        description={`For a lost device: removes ${staff.name}'s authenticator and recovery codes and signs them out. They can set it up again after signing in with their password.`}
        destructive
        confirmLabel="Reset two-factor"
        loading={resetTwoFactor.isPending}
        onConfirm={() => resetTwoFactor.mutate(undefined)}
      />
    </div>
  );
};

const PasswordDialog = ({ staff, onClose }: { staff: Staff; onClose: () => void }) => {
  const [password, setPassword] = useState(generatePassword);
  const save = useAction(() => request(StaffSetPassword, { id: staff.id, password }).then((r) => unwrap(r.staffUserSetPassword)), {
    success: "Password set; they were signed out everywhere",
    invalidate: [["staff"]],
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a new password for {staff.name}</DialogTitle>
          <DialogDescription>Signs them out of every session and clears any lockout. Share the password securely.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined);
          }}
        >
          <Field label="New password" hint="At least 12 characters.">
            <div className="flex gap-2">
              <Input className="font-mono" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required autoComplete="new-password" />
              <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
                Generate
              </Button>
            </div>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={password.length < 12}>
              Set password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
