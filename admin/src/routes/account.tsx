import { Copy, Download, KeyRound, ShieldCheck, ShieldOff, Smartphone, UserRound } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { Field, reportError } from "@/components/form";
import { Page, PageHeader } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Detail } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";
import { ErrorFields, graphql } from "@/graphql/graphql";
import { request, unwrap } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { copyText, useAction } from "@/lib/hooks";
import { downloadText, humanize } from "@/lib/utils";

const ProfileUpdate = graphql(
  `
    mutation StaffProfileUpdate($name: String!) {
      staffProfileUpdate(name: $name) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const PasswordChange = graphql(
  `
    mutation StaffPasswordChange($currentPassword: String!, $newPassword: String!) {
      staffPasswordChange(currentPassword: $currentPassword, newPassword: $newPassword) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const TwoFactorSetup = graphql(
  `
    mutation StaffTwoFactorSetup {
      staffTwoFactorSetup {
        __typename
        ... on StaffTwoFactorSetupPayload {
          secret
          uri
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const TwoFactorEnable = graphql(
  `
    mutation StaffTwoFactorEnable($code: String!) {
      staffTwoFactorEnable(code: $code) {
        __typename
        ... on StaffTwoFactorEnablePayload {
          recoveryCodes
        }
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);
const TwoFactorDisable = graphql(
  `
    mutation StaffTwoFactorDisable($password: String!) {
      staffTwoFactorDisable(password: $password) {
        __typename
        ...ErrorFields
      }
    }
  `,
  [ErrorFields],
);

/** Your profile, password and second sign-in factor. */
export const AccountPage = () => {
  const { viewer } = useAuth();
  const user = viewer?.staffUser;
  if (!user) {
    return (
      <Page>
        <PageHeader title="Account" description="API keys have no account; sign in as a staff user." />
      </Page>
    );
  }
  return (
    <Page className="max-w-4xl">
      <PageHeader title="Account and security" description={user.email ?? undefined} />
      <div className="flex flex-col gap-6">
        <ProfileCard name={user.name ?? ""} />
        <TwoFactorCard enabled={!!user.twoFactorEnabled} remaining={user.recoveryCodesRemaining ?? null} />
        <PasswordCard />
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Access</CardTitle>
              <CardDescription>What your roles allow. Ask an administrator to change them.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <dl>
              <Detail label="Roles">{(user.roles ?? []).map((r) => r.name).join(", ") || "—"}</Detail>
              <Detail label="Permissions">
                <span className="flex flex-wrap gap-1">
                  {(viewer?.permissions ?? []).map((p) => (
                    <Badge key={p} variant={p === "*" ? "default" : "secondary"}>
                      {p === "*" ? "Full access" : `${humanize(p.split(":")[0])}: ${p.endsWith(":write") ? "manage" : "view"}`}
                    </Badge>
                  ))}
                </span>
              </Detail>
              <Detail label="Last sign-in">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}</Detail>
            </dl>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
};

const ProfileCard = ({ name }: { name: string }) => {
  const { reload } = useAuth();
  const form = useForm<{ name: string }>({ defaultValues: { name } });
  const save = useAction((v: { name: string }) => request(ProfileUpdate, { name: v.name.trim() }).then((r) => unwrap(r.staffProfileUpdate)), {
    success: "Profile saved",
    invalidate: [["staff"], ["staff-names"]],
    onSuccess: () => void reload(),
    onError: (error) => reportError(error, form, []),
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <UserRound className="size-4 text-muted-foreground" /> Profile
          </CardTitle>
          <CardDescription>Your name appears on order timelines and in the audit log.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-wrap items-end gap-3">
          <Field label="Name" className="min-w-64 flex-1" error={form.formState.errors.name?.message}>
            <Input {...form.register("name", { required: "Required" })} />
          </Field>
          <Button type="submit" variant="outline" loading={save.isPending} disabled={!form.formState.isDirty}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

type PasswordForm = { currentPassword: string; newPassword: string; confirm: string };

const PasswordCard = () => {
  const { signOut } = useAuth();
  const form = useForm<PasswordForm>({ defaultValues: { currentPassword: "", newPassword: "", confirm: "" } });
  const save = useAction(
    (v: PasswordForm) => request(PasswordChange, { currentPassword: v.currentPassword, newPassword: v.newPassword }).then((r) => unwrap(r.staffPasswordChange)),
    {
      onSuccess: () => {
        toast.success("Password changed. Every session was signed out — sign in again with your new password.");
        void signOut();
      },
      onError: (error) => reportError(error, form, []),
    },
  );
  const errors = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" /> Password
          </CardTitle>
          <CardDescription>Changing it signs you out everywhere, including here.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-3">
          <Field label="Current password" error={errors.currentPassword?.message}>
            <Input type="password" autoComplete="current-password" {...form.register("currentPassword", { required: "Required" })} />
          </Field>
          <Field label="New password" hint="At least 12 characters." error={errors.newPassword?.message}>
            <Input type="password" autoComplete="new-password" {...form.register("newPassword", { required: "Required", minLength: { value: 12, message: "Use at least 12 characters" } })} />
          </Field>
          <Field label="Confirm new password" error={errors.confirm?.message}>
            <Input type="password" autoComplete="new-password" {...form.register("confirm", { validate: (v) => v === form.getValues("newPassword") || "Does not match" })} />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" loading={save.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
};

/** Base32 in groups of four for manual entry. */
const groupSecret = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

const qrDataUri = (uri: string) => `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(uri, { ecc: "M", border: 2, pixelSize: 5, whiteColor: "#ffffff", blackColor: "#18181b" }))}`;

const TwoFactorCard = ({ enabled, remaining }: { enabled: boolean; remaining: number | null }) => {
  const { reload } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = useAction(() => request(TwoFactorSetup).then((r) => unwrap(r.staffTwoFactorSetup)), {
    onSuccess: (payload) => {
      setSetup({ secret: payload.secret ?? "", uri: payload.uri ?? "" });
      setCode("");
    },
  });
  const enable = useAction((value: string) => request(TwoFactorEnable, { code: value }).then((r) => unwrap(r.staffTwoFactorEnable)), {
    success: "Two-factor authentication is on",
    onSuccess: (payload) => {
      setSetup(null);
      setRecoveryCodes(payload.recoveryCodes ?? []);
    },
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" /> Two-factor authentication
            {enabled ? <Badge variant="success">On</Badge> : <Badge variant="warning">Off</Badge>}
          </CardTitle>
          <CardDescription>After your password, sign-in asks for a 6-digit code from an authenticator app such as 1Password, Google Authenticator or Authy.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {recoveryCodes ? (
          <RecoveryCodes
            codes={recoveryCodes}
            onDone={() => {
              setRecoveryCodes(null);
              void reload();
            }}
          />
        ) : enabled ? (
          <>
            {remaining !== null && remaining <= 3 ? (
              <Alert variant="warning" title={`${remaining} recovery code${remaining === 1 ? "" : "s"} left`}>
                Turn two-factor off and on again to get a new set.
              </Alert>
            ) : (
              <p className="text-[13px] text-muted-foreground">{remaining ?? 0} unused recovery codes. Each works once if you lose your device.</p>
            )}
            <Button variant="outline" className="self-start" onClick={() => setDisabling(true)}>
              <ShieldOff />
              Turn off
            </Button>
          </>
        ) : setup ? (
          <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
            <img src={qrDataUri(setup.uri)} alt="QR code for your authenticator app" className="size-44 rounded-lg border bg-white p-1" />
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                enable.mutate(code.trim());
              }}
            >
              <ol className="list-decimal space-y-1 pl-4 text-[13px] text-muted-foreground">
                <li>Scan the code with your authenticator app.</li>
                <li>Or enter this key manually (time-based, 6 digits):</li>
              </ol>
              <div className="flex items-center gap-2">
                <code className="rounded-md bg-muted px-2 py-1 font-mono text-[13px] tracking-wider">{groupSecret(setup.secret)}</code>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copyText(setup.secret, "Key copied")} aria-label="Copy key">
                  <Copy />
                </Button>
              </div>
              <Field label="Code from the app">
                <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="w-40 font-mono tracking-widest" />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" loading={enable.isPending} disabled={!/^\d{6}$/.test(code.replace(/\s/g, ""))}>
                  Turn on
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <Button className="self-start" loading={start.isPending} onClick={() => start.mutate(undefined)}>
            {start.isPending ? null : <Smartphone />}
            Set up two-factor authentication
          </Button>
        )}
      </CardContent>
      {disabling ? (
        <DisableDialog
          onClose={() => setDisabling(false)}
          onDone={() => {
            setDisabling(false);
            void reload();
          }}
        />
      ) : null}
    </Card>
  );
};

const RecoveryCodes = ({ codes, onDone }: { codes: string[]; onDone: () => void }) => (
  <div className="flex flex-col gap-3">
    <Alert variant="warning" title="Save your recovery codes now">
      Each code signs you in once without your device. They will not be shown again.
    </Alert>
    <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-4 font-mono text-sm sm:grid-cols-5">
      {codes.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => void copyText(codes.join("\n"), "Recovery codes copied")}>
        <Copy />
        Copy
      </Button>
      <Button variant="outline" onClick={() => downloadText("spindlecommerce-recovery-codes.txt", `SpindleCommerce recovery codes (each works once)\n\n${codes.join("\n")}\n`, "text/plain;charset=utf-8")}>
        <Download />
        Download
      </Button>
      <Button onClick={onDone}>I have saved them</Button>
    </div>
  </div>
);

const DisableDialog = ({ onClose, onDone }: { onClose: () => void; onDone: () => void }) => {
  const form = useForm<{ password: string }>({ defaultValues: { password: "" } });
  const disable = useAction((v: { password: string }) => request(TwoFactorDisable, { password: v.password }).then((r) => unwrap(r.staffTwoFactorDisable)), {
    success: "Two-factor authentication is off",
    onSuccess: onDone,
    onError: (error) => reportError(error, form, []),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn off two-factor authentication?</DialogTitle>
          <DialogDescription>Your account will be protected by your password alone, and your recovery codes stop working.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => disable.mutate(v))} className="grid gap-4">
          <Field label="Your password" error={form.formState.errors.password?.message}>
            <Input type="password" autoComplete="current-password" autoFocus {...form.register("password", { required: "Required" })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={disable.isPending}>
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
