import { TriangleAlert, X } from "lucide-react";
import { AlertDialog as AlertPrimitive, Dialog as DialogPrimitive, Popover as PopoverPrimitive, Tooltip as TooltipPrimitive } from "radix-ui";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

// ---------------------------------------------------------------- dialog

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlay = "fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]";

type ContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** Unsaved edits inside: Escape, an outside click and the close button ask before discarding. */
  dirty?: boolean;
};

const closeButton = "absolute rounded-sm opacity-60 transition-opacity outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * With `dirty`, closing shows an inline "Discard changes?" bar; Keep editing or a second Escape
 * returns focus to the field. As a direct child of the portal, the question resets on close.
 */
const GuardedContent = ({ dirty, children, closeClassName, ref, onEscapeKeyDown, onInteractOutside, onScroll, ...props }: ContentProps & { closeClassName: string }) => {
  const node = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);
  // Where the bar sits: the top of the visible part of a scrolled panel.
  const [top, setTop] = useState(0);
  const prompting = asking && !!dirty;
  useEffect(() => {
    if (!dirty) setAsking(false);
  }, [dirty]);

  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      node.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );
  const ask = () => {
    if (!prompting) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTop(node.current?.scrollTop ?? 0);
    setAsking(true);
  };
  const keepEditing = () => {
    setAsking(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected && node.current?.contains(target)) target.focus();
  };

  return (
    <DialogPrimitive.Content
      ref={setRef}
      onEscapeKeyDown={(event) => {
        onEscapeKeyDown?.(event);
        if (event.defaultPrevented || !dirty) return;
        event.preventDefault();
        if (prompting) keepEditing();
        else ask();
      }}
      onInteractOutside={(event) => {
        onInteractOutside?.(event);
        if (event.defaultPrevented || !dirty) return;
        event.preventDefault();
        ask();
      }}
      onScroll={(event) => {
        onScroll?.(event);
        if (prompting) setTop(event.currentTarget.scrollTop);
      }}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(closeButton, closeClassName)}
        onClick={(event) => {
          if (!dirty) return;
          event.preventDefault();
          ask();
        }}
      >
        <X className="size-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
      {prompting ? (
        <div role="alert" style={{ top }} className="absolute inset-x-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-popover px-6 py-3 shadow-md">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <p className="mr-auto text-sm font-medium">Discard changes?</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" autoFocus onClick={keepEditing}>
              Keep editing
            </Button>
            <DialogPrimitive.Close asChild>
              <Button type="button" size="sm" variant="destructive">
                Discard
              </Button>
            </DialogPrimitive.Close>
          </div>
        </div>
      ) : null}
    </DialogPrimitive.Content>
  );
};

export const DialogContent = ({ className, wide, ...props }: ContentProps & { wide?: boolean }) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlay} />
    <GuardedContent
      className={cn(
        "fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl outline-none",
        wide ? "max-w-3xl" : "max-w-lg",
        className,
      )}
      closeClassName="top-4 right-4"
      {...props}
    />
  </DialogPrimitive.Portal>
);

export const DialogHeader = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />;
export const DialogFooter = ({ className, ...props }: ComponentProps<"div">) => <div className={cn("flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end", className)} {...props} />;
export const DialogTitle = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) => <DialogPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />;
export const DialogDescription = ({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />
);

// ---------------------------------------------------------------- sheet (side panel)

export const Sheet = DialogPrimitive.Root;
export const SheetContent = ({ className, ...props }: ContentProps) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlay} />
    <GuardedContent
      className={cn("fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto border-l bg-popover p-6 shadow-xl outline-none sm:w-[36rem]", className)}
      closeClassName="top-5 right-5"
      {...props}
    />
  </DialogPrimitive.Portal>
);

// ---------------------------------------------------------------- confirm

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) => (
  <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className={overlay} />
      <AlertPrimitive.Content className="fixed top-[50%] left-[50%] z-50 grid w-[calc(100%-2rem)] max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border bg-popover p-6 shadow-xl">
        <div className="flex flex-col gap-1.5">
          <AlertPrimitive.Title className="text-base font-semibold">{title}</AlertPrimitive.Title>
          {description ? <AlertPrimitive.Description className="text-sm text-muted-foreground">{description}</AlertPrimitive.Description> : null}
        </div>
        {children}
        <div className="flex justify-end gap-2">
          <AlertPrimitive.Cancel asChild>
            <Button variant="outline">Cancel</Button>
          </AlertPrimitive.Cancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            loading={loading}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertPrimitive.Content>
    </AlertPrimitive.Portal>
  </AlertPrimitive.Root>
);

// ---------------------------------------------------------------- popover and tooltip

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverContent = ({ className, align = "start", sideOffset = 6, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      align={align}
      sideOffset={sideOffset}
      className={cn("z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
);

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = ({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) => (
  <TooltipPrimitive.Root delayDuration={200}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md">
        {content}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);
