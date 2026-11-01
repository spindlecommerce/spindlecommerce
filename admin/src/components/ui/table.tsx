import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A table in its own horizontal scroll area. Give `container` a max height to scroll both ways with
 * sticky headers and first columns (see DataTable).
 */
export const Table = ({ className, container, ...props }: ComponentProps<"table"> & { container?: ComponentProps<"div"> }) => (
  <div {...container} className={cn("relative w-full overflow-x-auto", container?.className)}>
    <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
);
export const TableHeader = ({ className, ...props }: ComponentProps<"thead">) => <thead className={cn("[&_tr]:border-b", className)} {...props} />;
export const TableBody = ({ className, ...props }: ComponentProps<"tbody">) => <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
export const TableFooter = ({ className, ...props }: ComponentProps<"tfoot">) => <tfoot className={cn("border-t bg-muted/40 font-medium", className)} {...props} />;
export const TableRow = ({ className, ...props }: ComponentProps<"tr">) => (
  <tr className={cn("border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-accent/60", className)} {...props} />
);
export const TableHead = ({ className, ...props }: ComponentProps<"th">) => (
  <th className={cn("h-10 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5", className)} {...props} />
);
export const TableCell = ({ className, ...props }: ComponentProps<"td">) => <td className={cn("px-3 py-2.5 align-middle first:pl-5 last:pr-5", className)} {...props} />;

/** Sticky header cells. Collapsed table borders scroll away with the rows, hence the inset shadow. */
export const stickyHeadClass = "sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--color-border)]";
