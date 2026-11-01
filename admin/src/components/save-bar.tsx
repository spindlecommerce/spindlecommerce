import { Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SAVE_SHORTCUT = isMac ? "⌘S" : "Ctrl+S";

/** Sticky save bar for editors with unsaved changes. Render it as the Page's last child. */
export const SaveBar = ({
  onSave,
  onDiscard,
  saving,
  status = "Unsaved changes",
  problem,
  saveLabel = "Save",
  className,
}: {
  onSave: () => void;
  /** Adds Discard, which puts the form back as last saved. */
  onDiscard?: () => void;
  saving?: boolean;
  status?: ReactNode;
  /** Shown in place of the status, in red, e.g. "2 things to fix". */
  problem?: ReactNode;
  saveLabel?: ReactNode;
  className?: string;
}) => (
  <div className={cn("no-print sticky bottom-0 z-20 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8", className)}>
    <p className="text-[13px] text-muted-foreground" aria-live="polite">
      {problem ? <span className="font-medium text-destructive">{problem}</span> : status} · <Kbd>{SAVE_SHORTCUT}</Kbd> to save
    </p>
    <div className="flex gap-2">
      {onDiscard ? (
        <Button type="button" variant="outline" disabled={saving} onClick={onDiscard}>
          Discard
        </Button>
      ) : null}
      <Button type="button" loading={saving} onClick={onSave}>
        {saving ? null : <Save />}
        {saveLabel}
      </Button>
    </div>
  </div>
);

/**
 * ⌘S / Ctrl+S runs `onSave` instead of the browser's "Save page". Ignored in dialogs and side
 * panels, which may save something else.
 */
export const useSaveShortcut = (onSave: () => void, enabled = true) => {
  const latest = useRef({ onSave, enabled });
  latest.current = { onSave, enabled };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (event.repeat || (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"]'))) return;
      if (latest.current.enabled) latest.current.onSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
};

// ---------------------------------------------------------------- going to problems

/** A problem: a control with aria-invalid="true", or a row or group with data-invalid="true". */
export const PROBLEM_SELECTOR = '[data-invalid="true"], [aria-invalid="true"]';

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * The problem itself if focusable; else, within it or its `data-problem-focus` part, an invalid
 * control, then an empty text input, then the first control.
 */
const focusTarget = (marked: HTMLElement) => {
  if (marked.matches(FOCUSABLE)) return marked;
  const scope = marked.querySelector<HTMLElement>("[data-problem-focus]") ?? marked;
  if (scope.matches(FOCUSABLE)) return scope;
  const empty = [...scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled])")].find((input) => !input.value.trim());
  return scope.querySelector<HTMLElement>('[aria-invalid="true"]') ?? empty ?? scope.querySelector<HTMLElement>(FOCUSABLE);
};

export const focusProblem = (marked: HTMLElement) => {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  marked.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  focusTarget(marked)?.focus({ preventScroll: true });
};

export const focusFirstProblem = (root: ParentNode = document) => {
  const marked = root.querySelector<HTMLElement>(PROBLEM_SELECTOR);
  if (marked) focusProblem(marked);
  return !!marked;
};

/** Returns a function that runs `focusFirstProblem` once newly found problems have rendered. */
export const useProblemFocus = (root?: () => ParentNode | null | undefined) => {
  const [request, setRequest] = useState(0);
  const rootRef = useRef(root);
  rootRef.current = root;
  useEffect(() => {
    if (request) focusFirstProblem(rootRef.current?.() ?? document);
  }, [request]);
  return useCallback(() => setRequest((n) => n + 1), []);
};
