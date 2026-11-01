import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3", {
  variants: {
    variant: {
      default: "border-transparent bg-primary/10 text-primary",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      outline: "text-foreground",
      success: "border-transparent bg-success/12 text-success",
      warning: "border-transparent bg-warning/12 text-warning dark:bg-warning/15",
      destructive: "border-transparent bg-destructive/10 text-destructive",
      info: "border-transparent bg-info/12 text-info",
    },
  },
  defaultVariants: { variant: "default" },
});

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export const Badge = ({ className, variant, dot, children, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { dot?: boolean }) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props}>
    {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
    {children}
  </span>
);
