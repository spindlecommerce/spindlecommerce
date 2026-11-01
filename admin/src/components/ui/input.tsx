import { Label as LabelPrimitive } from "radix-ui";
import { createContext, useContext, useId, useLayoutEffect, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- field wiring

/**
 * What a Field (components/form.tsx) passes to its controls. Defined here so the two files don't
 * import each other.
 */
export type FieldWiring = {
  id: string;
  labelId?: string;
  describedBy?: string;
  invalid: boolean;
  /** False when the caller pointed the label at a control itself (`htmlFor`). */
  claimable: boolean;
  controls: FieldControls;
};

export const FieldContext = createContext<FieldWiring | null>(null);

type FieldControl = { setTakes: (takes: boolean) => void; owns: boolean; claimable: boolean };

/** The first control in a Field takes the label's id; more than one make the field a group. */
export type FieldControls = { add: (key: string, control: FieldControl) => () => void };

export const createFieldControls = (onCount: (count: number) => void): FieldControls => {
  // Mount order, which is document order.
  const controls = new Map<string, FieldControl>();
  let owner: string | null = null;
  return {
    add: (key, control) => {
      controls.set(key, control);
      // A control given the id itself (the Field's single child) keeps it.
      if (control.claimable && (owner === null || control.owns)) {
        if (owner !== null && owner !== key) controls.get(owner)?.setTakes(false);
        owner = key;
      }
      control.setTakes(owner === key);
      onCount(controls.size);
      return () => {
        controls.delete(key);
        if (owner === key) {
          owner = null;
          const next = controls.entries().next().value;
          if (next?.[1].claimable) {
            owner = next[0];
            next[1].setTakes(true);
          }
        }
        onCount(controls.size);
      };
    },
  };
};

type OwnWiring = { id?: string; "aria-label"?: string; "aria-labelledby"?: string; "aria-describedby"?: string; "aria-invalid"?: ComponentProps<"input">["aria-invalid"] };

/**
 * A control's id, description and invalid state from the Field around it; its own props win. A
 * control that names itself (`aria-label`, `aria-labelledby` or its own id) isn't the field's, e.g.
 * a picker's search box.
 */
export const useFieldControl = (own: OwnWiring) => {
  const field = useContext(FieldContext);
  const key = useId();
  const [takes, setTakes] = useState(false);
  const mine = field !== null && own["aria-label"] === undefined && own["aria-labelledby"] === undefined && (own.id === undefined || own.id === field.id);
  const controls = mine ? field.controls : undefined;
  const owns = own.id !== undefined;
  const claimable = !!field?.claimable;
  useLayoutEffect(() => controls?.add(key, { setTakes, owns, claimable }), [controls, key, owns, claimable]);
  return {
    props: {
      id: own.id ?? (mine && claimable && takes ? field.id : undefined),
      "aria-describedby": own["aria-describedby"] ?? (mine ? field.describedBy : undefined),
      "aria-invalid": own["aria-invalid"] ?? (mine && field.invalid ? true : undefined),
    },
    /** The label's id, for controls `<label for>` can't name (an editable region, a button). */
    labelledBy: mine ? field.labelId : undefined,
  };
};

// ---------------------------------------------------------------- controls

const field =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30";

export const Input = ({ className, type, ...props }: ComponentProps<"input">) => {
  const wiring = useFieldControl(props);
  return <input type={type} className={cn(field, "h-9 py-1 file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium", className)} {...props} {...wiring.props} />;
};

export const Textarea = ({ className, ...props }: ComponentProps<"textarea">) => {
  const wiring = useFieldControl(props);
  return <textarea className={cn(field, "min-h-20 py-2 leading-relaxed", className)} {...props} {...wiring.props} />;
};

export const NativeSelect = ({ className, children, ...props }: ComponentProps<"select">) => {
  const wiring = useFieldControl(props);
  return (
    <select
      className={cn(field, "h-9 appearance-none bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-8", "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]", className)}
      {...props}
      {...wiring.props}
    >
      {children}
    </select>
  );
};

export const Label = ({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) => (
  <LabelPrimitive.Root className={cn("flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:opacity-50", className)} {...props} />
);
