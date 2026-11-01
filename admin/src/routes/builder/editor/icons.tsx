import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import { iconFor } from "../library/icons";

export { iconFor };

/** By lucide name, from the same set the component library offers. */
export const ComponentIcon = ({ name, className, ...props }: { name: string | null | undefined } & Omit<LucideProps, "name">) => {
  const Icon = iconFor(name);
  return <Icon className={cn("size-4 shrink-0", className)} {...props} />;
};
