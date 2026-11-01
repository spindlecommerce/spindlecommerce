import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Card = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)} {...props} />;

export const CardHeader = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-start justify-between gap-4 px-5 pt-5 pb-3", className)} {...props} />;

export const CardTitle = ({ className, ...props }: ComponentProps<"h3">) => <h3 className={cn("text-[15px] leading-tight font-semibold", className)} {...props} />;

export const CardDescription = ({ className, ...props }: ComponentProps<"p">) => <p className={cn("mt-1 text-[13px] text-muted-foreground", className)} {...props} />;

export const CardContent = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("px-5 pb-5", className)} {...props} />;

export const CardFooter = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex items-center gap-2 border-t px-5 py-3", className)} {...props} />;
