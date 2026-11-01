import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useBackTarget, useNavTitle } from "@/lib/nav-history";
import { cn } from "@/lib/utils";

/** A screen's header. The back link returns to the list as last left (lib/nav-history.ts). */
export const PageHeader = ({
  title,
  description,
  actions,
  back,
  badges,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  badges?: ReactNode;
}) => {
  useEffect(() => {
    if (typeof title === "string") document.title = `${title} · SpindleCommerce`;
  }, [title]);
  useNavTitle(typeof title === "string" ? title : undefined);
  const backTarget = useBackTarget(back?.to);
  return (
    <div className="mb-6 flex flex-col gap-3">
      {back && backTarget ? (
        <Link to={backTarget.to} search={backTarget.search} hash={backTarget.hash} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {badges}
          </div>
          {description ? <p className="mt-1 text-[13px] text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
};

export const Page = ({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) => (
  <div className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8", wide ? "max-w-[100rem]" : "max-w-7xl", className)}>{children}</div>
);

/** Main column plus a narrower side column on large screens. */
export const TwoColumn = ({ main, side }: { main: ReactNode; side: ReactNode }) => (
  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <div className="flex min-w-0 flex-col gap-6">{main}</div>
    <div className="flex min-w-0 flex-col gap-6">{side}</div>
  </div>
);
