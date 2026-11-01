import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/overlay";
import { formatDateTime } from "@/lib/format";

export const PAGE_STATUSES = [
  { value: "DRAFT", label: "Draft", description: "Never published" },
  { value: "PUBLISHED", label: "Published", description: "Live, no unpublished changes" },
  { value: "CHANGED", label: "Changed", description: "Live, with draft changes not yet published" },
  { value: "SCHEDULED", label: "Scheduled", description: "Publishes at a set time" },
] as const;

const TONE: Record<string, BadgeVariant> = { DRAFT: "secondary", PUBLISHED: "success", CHANGED: "warning", SCHEDULED: "info" };

/** `dirty` (unsaved edits) shows a published page as changed. */
export const StatusBadge = ({ status, dirty, scheduledAt, className }: { status: string | null | undefined; dirty?: boolean; scheduledAt?: string | null; className?: string }) => {
  const shown = dirty && status === "PUBLISHED" ? "CHANGED" : (status ?? "DRAFT");
  const info = PAGE_STATUSES.find((s) => s.value === shown);
  const badge = (
    <Badge variant={TONE[shown] ?? "secondary"} dot className={className}>
      {info?.label ?? shown}
    </Badge>
  );
  const hint = shown === "SCHEDULED" && scheduledAt ? `Publishes ${formatDateTime(scheduledAt)}` : info?.description;
  return hint ? <Tooltip content={hint}>{badge}</Tooltip> : badge;
};
