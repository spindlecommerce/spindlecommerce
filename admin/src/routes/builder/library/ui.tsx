import { Braces, Copy, Database, LayoutTemplate, PenLine, Rows3 } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/overlay";
import { copyText } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { TEMPLATE_KINDS, type ComponentKind, type TemplateFor } from "../model";

// ---------------------------------------------------------------- badges

export const SourceBadge = ({ source }: { source: string | null | undefined }) =>
  source === "CODE" ? (
    <Tooltip content="Deployed from code with componentsSync; the next push overwrites edits made here.">
      <Badge variant="info">
        <Braces />
        Code
      </Badge>
    </Tooltip>
  ) : (
    <Tooltip content="Created or last edited in the admin.">
      <Badge variant="secondary">
        <PenLine />
        Admin
      </Badge>
    </Tooltip>
  );

export const KindBadge = ({ kind }: { kind: ComponentKind | null | undefined }) => <Badge variant={kind === "CONTENT_TYPE" ? "info" : "outline"}>{kind === "CONTENT_TYPE" ? "Content type" : "Component"}</Badge>;

/** "Product template" on template content types and their pages, "Product data" on components. */
export const TemplateForBadge = ({ templateFor, kind = "CONTENT_TYPE", hint, className }: { templateFor: TemplateFor | null | undefined; kind?: ComponentKind | null; hint?: ReactNode; className?: string }) => {
  if (!templateFor) return null;
  const names = TEMPLATE_KINDS[templateFor];
  const data = kind === "COMPONENT";
  return (
    <Tooltip
      content={
        hint ??
        (data
          ? `Shows the ${names.one}'s data, so it only fits ${names.template.toLowerCase()}s and ${names.sections.toLowerCase()}.`
          : `Its pages are ${names.template.toLowerCase()}s: they have no path, and ${names.pages} render with them. Assign them to ${names.many}, or make one the default.`)
      }
    >
      <Badge variant={data ? "outline" : "info"} className={className}>
        {data ? <Database /> : <LayoutTemplate />}
        {data ? names.data : names.template}
      </Badge>
    </Tooltip>
  );
};

export const SectionsForBadge = ({ sectionsFor, className }: { sectionsFor: TemplateFor | null | undefined; className?: string }) => {
  if (!sectionsFor) return null;
  const names = TEMPLATE_KINDS[sectionsFor];
  return (
    <Tooltip content={`Each page holds one ${names.one}'s own sections, added from the ${names.one}'s screen. They have no path, and show on its page where its template places them.`}>
      <Badge variant="info" className={className}>
        <Rows3 />
        {names.sections}
      </Badge>
    </Tooltip>
  );
};

const RELEASE_STATUS: Record<string, { label: string; variant: BadgeVariant; hint: string }> = {
  OPEN: { label: "Open", variant: "secondary", hint: "Collecting pages; publish it now or schedule it." },
  SCHEDULED: { label: "Scheduled", variant: "info", hint: "Publishes automatically at the scheduled time." },
  PUBLISHED: { label: "Published", variant: "success", hint: "Its pages went live together." },
  FAILED: { label: "Failed", variant: "destructive", hint: "The scheduled publish failed; nothing went live." },
};

export const ReleaseStatusBadge = ({ status }: { status: string | null | undefined }) => {
  const s = RELEASE_STATUS[status ?? ""] ?? { label: status ?? "—", variant: "secondary" as const, hint: "" };
  return (
    <Tooltip content={s.hint}>
      <Badge variant={s.variant} dot>
        {s.label}
      </Badge>
    </Tooltip>
  );
};

const PAGE_STATUS: Record<string, { label: string; variant: BadgeVariant; hint: string }> = {
  DRAFT: { label: "Draft", variant: "secondary", hint: "Never published." },
  PUBLISHED: { label: "Published", variant: "success", hint: "Live, with no unpublished changes." },
  CHANGED: { label: "Changed", variant: "warning", hint: "Live, with draft changes not yet published." },
  SCHEDULED: { label: "Scheduled", variant: "info", hint: "The page itself is scheduled to publish." },
};

export const PageStatusBadge = ({ status }: { status: string | null | undefined }) => {
  const s = PAGE_STATUS[status ?? ""] ?? { label: status ?? "—", variant: "secondary" as const, hint: "" };
  return (
    <Tooltip content={s.hint}>
      <Badge variant={s.variant} dot>
        {s.label}
      </Badge>
    </Tooltip>
  );
};

// ---------------------------------------------------------------- code

export const InlineCode = ({ children, className }: { children: ReactNode; className?: string }) => <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground", className)}>{children}</code>;

export const CodeBlock = ({ code, copyLabel = "Copied", className }: { code: string; copyLabel?: string; className?: string }) => (
  <div className={cn("relative", className)}>
    <pre className="rounded-lg border bg-muted/50 py-2.5 pr-11 pl-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</pre>
    <Button type="button" variant="ghost" size="icon-sm" className="absolute top-1 right-1 opacity-70 hover:opacity-100" onClick={() => void copyText(code, copyLabel)} aria-label="Copy to clipboard">
      <Copy />
    </Button>
  </div>
);

// ---------------------------------------------------------------- drag to reorder

/** Drag to reorder a vertical list. Only the handle starts a drag, so inputs keep text selection. */
export const useDragReorder = (onMove: (from: number, to: number) => void) => {
  const [armed, setArmed] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const reset = () => {
    setArmed(null);
    setDragging(null);
    setOver(null);
  };
  return {
    dragging,
    /** Where the dragged row would land, to draw the drop line. */
    dropLine: (index: number): "before" | "after" | null => (dragging === null || over !== index || dragging === index ? null : dragging < index ? "after" : "before"),
    handleProps: (index: number) => ({
      onPointerDown: () => setArmed(index),
      onPointerUp: () => setArmed(null),
    }),
    rowProps: (index: number) => ({
      draggable: armed === index,
      onDragStart: (event: DragEvent) => {
        event.stopPropagation();
        setDragging(index);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
      },
      onDragOver: (event: DragEvent) => {
        if (dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (over !== index) setOver(index);
      },
      onDrop: (event: DragEvent) => {
        if (dragging === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (dragging !== index) onMove(dragging, index);
        reset();
      },
      onDragEnd: reset,
    }),
  };
};

// ---------------------------------------------------------------- dates

/** ISO date-time ↔ the value of an `<input type="datetime-local">`, in the viewer's time zone. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

/** Quick schedule choices: about an hour from now, tomorrow morning, next Monday morning. */
export const scheduleSuggestions = (now = new Date()) => {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const soon = new Date(now.getTime() + 60 * 60_000);
  soon.setMinutes(0, 0, 0);
  if (soon.getTime() - now.getTime() < 30 * 60_000) soon.setHours(soon.getHours() + 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const choices = [
    { label: `${sameDay(soon, now) ? "Today" : "Tomorrow"}, ${time.format(soon)}`, value: toLocalInput(soon.toISOString()) },
    { label: `Tomorrow, ${time.format(tomorrow)}`, value: toLocalInput(tomorrow.toISOString()) },
    { label: `${day.format(monday)}, ${time.format(monday)}`, value: toLocalInput(monday.toISOString()) },
  ];
  return choices.filter((c, i) => choices.findIndex((x) => x.value === c.value) === i);
};
