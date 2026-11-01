import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Toaster = () => {
  const theme = useTheme();
  return <SonnerToaster richColors closeButton position="bottom-right" theme={theme} />;
};

export const Skeleton = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;

export const Separator = ({ className, vertical }: { className?: string; vertical?: boolean }) => (
  <div role="separator" className={cn("shrink-0 bg-border", vertical ? "h-full w-px" : "h-px w-full", className)} />
);

const ALERT: Record<string, { icon: LucideIcon; tone: string }> = {
  info: { icon: Info, tone: "border-info/30 bg-info/5 [&>svg]:text-info" },
  success: { icon: CheckCircle2, tone: "border-success/30 bg-success/5 [&>svg]:text-success" },
  warning: { icon: AlertTriangle, tone: "border-warning/40 bg-warning/8 [&>svg]:text-warning" },
  destructive: { icon: AlertCircle, tone: "border-destructive/30 bg-destructive/5 text-destructive [&>svg]:text-destructive" },
};

export const Alert = ({ variant = "info", title, children, className, action }: { variant?: keyof typeof ALERT; title?: ReactNode; children?: ReactNode; className?: string; action?: ReactNode }) => {
  const { icon: Icon, tone } = ALERT[variant]!;
  return (
    <div role="alert" className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", tone, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-[13px] opacity-90">{children}</div> : null}
      </div>
      {action}
    </div>
  );
};

export const EmptyState = ({ icon: Icon, title, description, action, className }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) => (
  <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-14 text-center", className)}>
    {Icon ? (
      <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
    ) : null}
    <p className="font-medium">{title}</p>
    {description ? <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p> : null}
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
);

export const Kbd = ({ className, ...props }: ComponentProps<"kbd">) => (
  <kbd className={cn("pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground", className)} {...props} />
);

/** Two-column definition list for detail panels. */
export const Detail = ({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) => (
  <div className={cn("grid grid-cols-[minmax(7rem,40%)_1fr] gap-3 py-1.5 text-sm", className)}>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);
