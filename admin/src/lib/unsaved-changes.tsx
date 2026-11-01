import { useBlocker } from "@tanstack/react-router";
import { AlertDialog as AlertPrimitive } from "radix-ui";
import { useCallback, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Options = {
  /** Runs on "Discard changes", e.g. to forget a stored draft. */
  onDiscard?: () => void;
  /** What is lost, under the dialog's title. */
  description?: ReactNode;
};

type Location = { pathname: string };

/**
 * Confirms before leaving a screen with unsaved changes; reloads get the browser's prompt. Search
 * param changes on the same screen pass. Render `dialog`, and call `release()` (or navigate with
 * `ignoreBlocker: true`) before leaving on purpose, e.g. after a delete.
 */
export const useUnsavedChanges = (dirty: boolean, options: Options = {}) => {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const released = useRef(false);

  // Stable callbacks, so the router keeps one blocker rather than one per render.
  const shouldBlockFn = useCallback(({ current, next }: { current: Location; next: Location }) => dirtyRef.current && !released.current && current.pathname !== next.pathname, []);
  const enableBeforeUnload = useCallback(() => dirtyRef.current && !released.current, []);
  const blocker = useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true });

  const release = useCallback(() => {
    released.current = true;
  }, []);

  const dialog = (
    <AlertPrimitive.Root
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <AlertPrimitive.Content className="fixed top-[50%] left-[50%] z-50 grid w-[calc(100%-2rem)] max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl">
          <div className="flex flex-col gap-1.5">
            <AlertPrimitive.Title className="text-base font-semibold">Leave without saving?</AlertPrimitive.Title>
            <AlertPrimitive.Description className="text-sm text-muted-foreground">{options.description ?? "Your changes on this page will be lost."}</AlertPrimitive.Description>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertPrimitive.Cancel asChild>
              <Button variant="outline">Keep editing</Button>
            </AlertPrimitive.Cancel>
            <Button
              variant="destructive"
              onClick={() => {
                optionsRef.current.onDiscard?.();
                blocker.proceed?.();
              }}
            >
              Discard changes
            </Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );

  return { dialog, release };
};
