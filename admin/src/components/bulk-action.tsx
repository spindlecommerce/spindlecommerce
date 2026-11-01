import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/overlay";

export type BulkOutcome<T> = { done: T[]; failed: { item: T; message: string }[]; skipped: T[]; stopped: boolean };

const ItemList = ({ children }: { children: ReactNode }) => <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border text-[13px]">{children}</ul>;

/**
 * Runs one request per selected row: a confirmation listing skips, progress with Stop, then a
 * summary of failures, or only a toast if all worked. Mount it when the action starts.
 */
export const BulkActionDialog = <T,>({
  items,
  title,
  description,
  noun,
  verbs,
  confirmLabel,
  destructive,
  itemKey,
  itemLabel,
  skipReason,
  run,
  onClose,
  onFinished,
}: {
  items: readonly T[];
  title: string;
  /** What happens to each row. */
  description?: ReactNode;
  noun: [singular: string, plural: string];
  /** For "Capturing 4 of 12…" and "Captured 11 of 12 orders". */
  verbs: [doing: string, done: string];
  confirmLabel: string;
  destructive?: boolean;
  itemKey: (item: T) => string;
  /** How a row is named in the skipped and failed lists, e.g. a link to it. */
  itemLabel: (item: T) => ReactNode;
  /** Why a row will be skipped, or null to process it. */
  skipReason?: (item: T) => string | null;
  run: (item: T) => Promise<unknown>;
  onClose: () => void;
  /** After the last request or Stop, e.g. to refresh the list and clear the selection. */
  onFinished: (outcome: BulkOutcome<T>) => void;
}) => {
  const [phase, setPhase] = useState<"confirm" | "running" | "result">("confirm");
  const [completed, setCompleted] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [outcome, setOutcome] = useState<BulkOutcome<T> | null>(null);
  const stop = useRef(false);
  // Leaving the screen mid-run stops after the request in flight.
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  const count = (n: number) => `${n} ${n === 1 ? noun[0] : noun[1]}`;
  const skipped = items.flatMap((item) => {
    const reason = skipReason?.(item);
    return reason ? [{ item, reason }] : [];
  });
  const eligible = items.filter((item) => !skipReason?.(item));

  const start = async () => {
    stop.current = false;
    setPhase("running");
    const done: T[] = [];
    const failed: BulkOutcome<T>["failed"] = [];
    for (const [index, item] of eligible.entries()) {
      if (stop.current) break;
      setCompleted(index);
      try {
        await run(item);
        done.push(item);
      } catch (error) {
        failed.push({ item, message: error instanceof Error ? error.message : "Failed" });
      }
    }
    const result: BulkOutcome<T> = { done, failed, skipped: skipped.map((s) => s.item), stopped: done.length + failed.length < eligible.length };
    onFinished(result);
    if (!failed.length && !result.stopped) {
      toast.success(`${verbs[1]} ${count(done.length)}`, skipped.length ? { description: `${count(skipped.length)} skipped` } : undefined);
      onClose();
      return;
    }
    setOutcome(result);
    setPhase("result");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && phase !== "running" && onClose()}>
      <DialogContent>
        {phase === "confirm" ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </DialogHeader>
            <p className="text-sm">
              {eligible.length === 0
                ? `None of the selected ${noun[1]} can be ${verbs[1].toLowerCase()}.`
                : skipped.length
                  ? `${eligible.length} of the ${count(items.length)} selected will be ${verbs[1].toLowerCase()}.`
                  : `${count(eligible.length)} will be ${verbs[1].toLowerCase()}.`}
            </p>
            {skipped.length ? (
              <div className="grid gap-1.5">
                <p className="text-[13px] font-medium">Skipped ({skipped.length})</p>
                <ItemList>
                  {skipped.map(({ item, reason }) => (
                    <li key={itemKey(item)} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5">
                      <span>{itemLabel(item)}</span>
                      <span className="text-muted-foreground">{reason}</span>
                    </li>
                  ))}
                </ItemList>
              </div>
            ) : null}
            <DialogFooter>
              {/* Not "Cancel": one of these actions is canceling orders. */}
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button variant={destructive ? "destructive" : "default"} disabled={!eligible.length} onClick={() => void start()}>
                {confirmLabel}
              </Button>
            </DialogFooter>
          </>
        ) : phase === "running" ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription aria-live="polite">
                {stopping ? `Stopping after the current ${noun[0]}…` : `${verbs[0]} ${Math.min(completed + 1, eligible.length)} of ${eligible.length}…`}
              </DialogDescription>
            </DialogHeader>
            <div role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={eligible.length} aria-valuenow={completed} className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(completed / Math.max(1, eligible.length)) * 100}%` }} />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={stopping}
                onClick={() => {
                  stop.current = true;
                  setStopping(true);
                }}
              >
                Stop
              </Button>
            </DialogFooter>
          </>
        ) : outcome ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {verbs[1]} {outcome.done.length} of {count(eligible.length)}
              </DialogTitle>
              <DialogDescription>
                {[
                  outcome.failed.length ? `${outcome.failed.length} failed` : null,
                  outcome.stopped ? `${eligible.length - outcome.done.length - outcome.failed.length} not processed after Stop` : null,
                  outcome.skipped.length ? `${outcome.skipped.length} skipped` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </DialogDescription>
            </DialogHeader>
            {outcome.failed.length ? (
              <div className="grid gap-1.5">
                <p className="text-[13px] font-medium">Failed ({outcome.failed.length})</p>
                <ItemList>
                  {outcome.failed.map(({ item, message }) => (
                    <li key={itemKey(item)} className="flex flex-col gap-0.5 px-3 py-2">
                      <span className="font-medium">{itemLabel(item)}</span>
                      <span className="text-destructive">{message}</span>
                    </li>
                  ))}
                </ItemList>
              </div>
            ) : null}
            {outcome.stopped ? <Alert variant="info">Stopped before every {noun[0]} was processed. Run the action again for the rest.</Alert> : null}
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
