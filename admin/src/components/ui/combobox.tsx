import { Check, ChevronsUpDown, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";
import { useFieldControl } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./overlay";

export type ComboOption = { value: string; label: string; hint?: string; icon?: ReactNode };

/** Inside a Field these default to the field's. */
type TriggerAria = { id?: string; "aria-label"?: string; "aria-labelledby"?: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

const trigger =
  "flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1.5 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30";

/**
 * In a Field the trigger is named by the label plus its own text ("Channels US Store, EU Store"),
 * since a `<label for>` alone would replace the value.
 */
const useTriggerAria = (aria: TriggerAria) => {
  const wiring = useFieldControl(aria);
  const localId = useId();
  const id = wiring.props.id ?? localId;
  return {
    ...wiring.props,
    id,
    "aria-label": aria["aria-label"],
    "aria-labelledby": aria["aria-labelledby"] ?? (wiring.labelledBy ? `${wiring.labelledBy} ${id}` : undefined),
  };
};

/** Searchable multi-select; selected values show as removable chips. */
export const MultiSelect = ({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  className,
  disabled,
  max,
  ...aria
}: {
  options: readonly ComboOption[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
  max?: number;
} & TriggerAria) => {
  const [open, setOpen] = useState(false);
  const triggerAria = useTriggerAria(aria);
  const selected = value.map((v) => options.find((o) => o.value === v) ?? { value: v, label: v });
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : max === 1 ? [v] : [...value, v]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" {...triggerAria} className={cn(trigger, className)}>
          <span className="flex flex-1 flex-wrap gap-1">
            {selected.length === 0 ? <span className="text-muted-foreground">{placeholder}</span> : null}
            {selected.map((o) => (
              <Badge key={o.value} variant="secondary" className="rounded-md pr-1">
                {o.label}
                {/* Pointer only: the list in the popover adds and removes by keyboard, so it stays out of the button's name. */}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-hidden
                  aria-label={`Remove ${o.label}`}
                  className="rounded-sm opacity-60 hover:opacity-100"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggle(o.value);
                  }}
                >
                  <X className="size-3" />
                </span>
              </Badge>
            ))}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.value} value={`${o.label} ${o.hint ?? ""} ${o.value}`} onSelect={() => toggle(o.value)}>
                  <span className={cn("flex size-4 items-center justify-center rounded-[4px] border", value.includes(o.value) && "border-primary bg-primary text-primary-foreground")}>
                    {value.includes(o.value) ? <Check className="size-3 !text-primary-foreground" /> : null}
                  </span>
                  {o.icon}
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint ? <span className="text-xs text-muted-foreground">{o.hint}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

/** Searchable single select. */
export const Combobox = ({
  options,
  value,
  onChange,
  placeholder = "Select…",
  className,
  disabled,
  clearable,
  ...aria
}: {
  options: readonly ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  clearable?: boolean;
} & TriggerAria) => {
  const [open, setOpen] = useState(false);
  const triggerAria = useTriggerAria(aria);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" {...triggerAria} className={cn(trigger, className)}>
          <span className={cn("flex-1 truncate", !current && "text-muted-foreground")}>{current?.label ?? (value || placeholder)}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {clearable && value ? (
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  <X />
                  <span className="text-muted-foreground">Clear</span>
                </CommandItem>
              ) : null}
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ""} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", o.value === value ? "opacity-100" : "opacity-0")} />
                  {o.icon}
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint ? <span className="text-xs text-muted-foreground">{o.hint}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
