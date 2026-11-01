import dark from "@/assets/brand/spindle-dark-bg.svg";
import light from "@/assets/brand/spindle-light-bg.svg";
import { cn } from "@/lib/utils";

/**
 * The compact lockup: the full lockup's "commerce" line is unreadable at admin sizes. The lettering
 * is artwork, never live text. The wrapper's height sizes it.
 */
export const BrandLogo = ({ className }: { className?: string }) => (
  <span className={cn("inline-flex shrink-0", className)}>
    <img src={light} alt="SpindleCommerce" className="h-full w-auto dark:hidden" />
    <img src={dark} alt="SpindleCommerce" className="hidden h-full w-auto dark:block" />
  </span>
);
