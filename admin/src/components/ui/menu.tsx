import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu as MenuPrimitive, Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./input";

// ---------------------------------------------------------------- dropdown menu

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;

export const DropdownMenuContent = ({ className, sideOffset = 6, align = "end", ...props }: ComponentProps<typeof MenuPrimitive.Content>) => (
  <MenuPrimitive.Portal>
    <MenuPrimitive.Content
      sideOffset={sideOffset}
      align={align}
      className={cn("z-50 min-w-44 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg", className)}
      {...props}
    />
  </MenuPrimitive.Portal>
);

const item =
  "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

export const DropdownMenuItem = ({ className, destructive, ...props }: ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean }) => (
  <MenuPrimitive.Item className={cn(item, destructive && "text-destructive focus:text-destructive [&_svg]:text-destructive", className)} {...props} />
);

export const DropdownMenuCheckboxItem = ({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.CheckboxItem>) => (
  <MenuPrimitive.CheckboxItem className={cn(item, "pl-8", className)} {...props}>
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <MenuPrimitive.ItemIndicator>
        <Check className="size-4" />
      </MenuPrimitive.ItemIndicator>
    </span>
    {children}
  </MenuPrimitive.CheckboxItem>
);

export const DropdownMenuLabel = ({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) => (
  <MenuPrimitive.Label className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />
);

export const DropdownMenuSeparator = ({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) => <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;

// ---------------------------------------------------------------- select

export type SelectOption = { value: string; label: string; description?: string };

/** A single select where `""` means no value. Wired to a surrounding Field like Input. */
export const Select = ({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  disabled,
  allowEmpty,
  emptyLabel = "Any",
  ...rest
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  id?: string;
}) => {
  const EMPTY = "__empty__";
  const wiring = useFieldControl(rest);
  return (
    <SelectPrimitive.Root value={value === "" ? (allowEmpty ? EMPTY : undefined) : value} onValueChange={(v) => onValueChange(v === EMPTY ? "" : v)} disabled={disabled}>
      <SelectPrimitive.Trigger
        {...wiring.props}
        aria-label={rest["aria-label"]}
        aria-labelledby={rest["aria-labelledby"]}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm whitespace-nowrap shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground dark:bg-input/30 [&>span]:truncate",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <SelectPrimitive.Viewport className="p-1">
            {allowEmpty ? <SelectRow value={EMPTY} label={emptyLabel} /> : null}
            {options.map((o) => (
              <SelectRow key={o.value} value={o.value} label={o.label} description={o.description} />
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
};

const SelectRow = ({ value, label, description }: SelectOption) => (
  <SelectPrimitive.Item value={value} className={cn(item, "pr-8")}>
    <div className="flex flex-col">
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
    <span className="absolute right-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
);
