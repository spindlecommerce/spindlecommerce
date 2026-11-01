import { cloneElement, isValidElement, useId, useMemo, useState, type ReactNode } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ApiError, MutationError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { createFieldControls, FieldContext, Label, type FieldWiring } from "./ui/input";

// Custom controls inside a Field use `useFieldControl` to be labelled, described and marked invalid.
export { FieldContext, useFieldControl } from "./ui/input";

/** Elements a `<label for>` can name. */
const LABELABLE = new Set(["input", "select", "textarea", "button", "meter", "output", "progress"]);

/**
 * Label, control, hint and error for one form field. The wiring reaches nested controls through
 * context (`useFieldControl`); a field with several controls labels them as a group.
 */
export const Field = ({
  label,
  hint,
  error,
  children,
  className,
  required,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  required?: boolean;
  htmlFor?: string;
}) => {
  const autoId = useId();
  const [several, setSeveral] = useState(false);
  const [controls] = useState(() => createFieldControls((count) => setSeveral(count > 1)));
  const id = htmlFor ?? autoId;
  const labelId = label ? `${autoId}-label` : undefined;
  const messageId = error || hint ? `${autoId}-message` : undefined;
  const wiring = useMemo<FieldWiring>(() => ({ id, labelId, describedBy: messageId, invalid: !!error, claimable: htmlFor === undefined, controls }), [id, labelId, messageId, error, htmlFor, controls]);
  // A single labelable child also gets the id directly, for controls that don't read the field (a
  // Switch). A wrapper div doesn't; the control inside it takes the id.
  const linkable =
    htmlFor === undefined && isValidElement<{ id?: string }>(children) && typeof children.type !== "symbol" && (typeof children.type !== "string" || LABELABLE.has(children.type)) && !children.props.id;
  const group = several && !!label;
  return (
    <FieldContext.Provider value={wiring}>
      <div role={group ? "group" : undefined} aria-labelledby={group ? labelId : undefined} aria-describedby={group ? messageId : undefined} className={cn("flex flex-col gap-1.5", className)}>
        {label ? (
          <Label id={labelId} htmlFor={id} className="text-[13px]">
            {label}
            {required ? <span className="text-destructive">*</span> : null}
          </Label>
        ) : null}
        {linkable ? cloneElement(children, { id }) : children}
        {error ? (
          <p key="error" id={messageId} aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p key="hint" id={messageId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
};

export const useFieldId = () => useId();

/** A titled group of fields inside a page or card. */
export const FormSection = ({ title, description, children, className, aside }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) => (
  <section className={cn("grid gap-4", className)}>
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {aside}
    </div>
    {children}
  </section>
);

/**
 * Once the errors render, focuses the first invalid control (in the open dialog, if any).
 * `fallback` runs when there is none.
 */
export const focusFirstError = (fallback?: () => void) =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
      const scope: ParentNode = dialogs[dialogs.length - 1] ?? document;
      const target = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (!target) return fallback?.();
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus({ preventScroll: true });
    }),
  );

/**
 * Puts a ValidationError's field errors on the form's fields (paths relative to `prefix`) and
 * focuses the first; anything else becomes a toast.
 */
export const reportError = <T extends FieldValues>(error: unknown, form?: UseFormReturn<T>, prefix: string[] = ["input"]) => {
  if (error instanceof MutationError && error.fieldErrors.length && form) {
    let placed = 0;
    let first: string | undefined;
    for (const fieldError of error.fieldErrors) {
      const path = fieldError.path.slice(prefix.every((p, i) => fieldError.path[i] === p) ? prefix.length : 0).join(".");
      if (path) {
        form.setError(path as Path<T>, { message: fieldError.message });
        placed++;
        first ??= path;
      }
    }
    toast.error(error.message, { description: placed < error.fieldErrors.length ? error.fieldErrors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n") : undefined });
    // A field the screen doesn't show the error on can still take focus if it's registered.
    if (first) focusFirstError(() => form.setFocus(first as Path<T>));
    return;
  }
  if (error instanceof MutationError && error.fieldErrors.length) {
    toast.error(error.message, { description: error.fieldErrors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n") });
    return;
  }
  toast.error(error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong");
};
