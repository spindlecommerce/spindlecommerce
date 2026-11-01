import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Field } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { requestPasswordReset, resetPassword } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** Where to go after signing in: a path in this app from ?redirect=, never another site. */
const redirectTarget = (redirect: string | undefined) => {
  if (!redirect?.startsWith("/") || redirect.startsWith("//")) return { to: "/" };
  const url = new URL(redirect.replace(/^\/admin(?=\/|$)/, "") || "/", window.location.origin);
  return { to: url.pathname, search: Object.fromEntries(url.searchParams) };
};

const AuthCard = ({ title, description, children }: { title: string; description: string; children: React.ReactNode }) => {
  useEffect(() => {
    document.title = `${title} · SpindleCommerce`;
  }, [title]);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandLogo className="h-10" />
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-base font-semibold">{title}</h1>
          <p className="mt-1 mb-5 text-[13px] text-muted-foreground">{description}</p>
          {children}
        </div>
      </div>
    </div>
  );
};

export const LoginPage = () => {
  const { signIn, verify, status } = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { redirect?: string };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"signIn" | "forgot" | "sent">("signIn");

  // Signed in (now or already): continue to where the user was going.
  const target = useMemo(() => redirectTarget(search.redirect), [search.redirect]);
  useEffect(() => {
    if (status === "signedIn" && !busy) void navigate({ ...target, replace: true });
  }, [status, busy, target, navigate]);

  if (status === "signedIn") return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "forgot") {
        await requestPasswordReset(email);
        setMode("sent");
      } else if (challenge) {
        await verify(challenge, code);
      } else {
        const result = await signIn(email, password);
        if (result.kind === "challenge") setChallenge(result.challengeToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      if (challenge) setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (mode === "sent") {
    return (
      <AuthCard title="Check your email" description="If an account exists for that address, a reset link is on its way.">
        <Button variant="outline" className="w-full" onClick={() => setMode("signIn")}>
          Back to sign in
        </Button>
      </AuthCard>
    );
  }

  if (challenge) {
    return (
      <AuthCard title="Two-factor authentication" description="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Field label="Code" htmlFor="code">
            <Input id="code" autoFocus inputMode="text" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className="text-center font-mono text-lg tracking-[0.3em]" />
          </Field>
          <Button type="submit" loading={busy} disabled={!code.trim()}>
            <ShieldCheck />
            Verify
          </Button>
          <Button type="button" variant="ghost" onClick={() => { setChallenge(null); setCode(""); setError(null); }}>
            Use a different account
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={mode === "forgot" ? "Reset your password" : "Sign in"}
      description={mode === "forgot" ? "We'll email you a link to choose a new password." : "Use your staff account to manage the store."}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {mode === "signIn" ? (
          <div className="flex flex-col gap-1.5">
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <button type="button" className="self-end text-xs text-primary hover:underline" onClick={() => { setMode("forgot"); setError(null); }}>
              Forgot password?
            </button>
          </div>
        ) : null}
        <Button type="submit" loading={busy}>
          {mode === "forgot" ? "Send reset link" : "Sign in"}
        </Button>
        {mode === "forgot" ? (
          <Button type="button" variant="ghost" onClick={() => setMode("signIn")}>
            Back to sign in
          </Button>
        ) : null}
      </form>
    </AuthCard>
  );
};

export const ResetPasswordPage = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { token?: string };
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return setError("The passwords do not match");
    setError(null);
    setBusy(true);
    try {
      await resetPassword(search.token ?? "", password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The reset failed");
    } finally {
      setBusy(false);
    }
  };

  if (!search.token) {
    return (
      <AuthCard title="Invalid link" description="This reset link is incomplete. Request a new one from the sign-in page.">
        <Button className="w-full" onClick={() => void navigate({ to: "/login" })}>
          Go to sign in
        </Button>
      </AuthCard>
    );
  }
  if (done) {
    return (
      <AuthCard title="Password changed" description="Every session was signed out. Sign in with your new password.">
        <Button className="w-full" onClick={() => void navigate({ to: "/login" })}>
          Sign in
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" description="Use at least 12 characters.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label="New password" htmlFor="new">
          <Input id="new" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <Input id="confirm" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Set password
        </Button>
      </form>
    </AuthCard>
  );
};
