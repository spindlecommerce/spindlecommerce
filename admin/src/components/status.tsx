import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { humanize } from "@/lib/utils";

const TONES: Record<string, BadgeVariant> = {
  // orders
  OPEN: "info",
  COMPLETED: "success",
  CANCELED: "secondary",
  // payment
  PENDING: "warning",
  AUTHORIZED: "info",
  PAID: "success",
  PARTIALLY_PAID: "warning",
  PARTIALLY_REFUNDED: "warning",
  REFUNDED: "secondary",
  VOIDED: "secondary",
  // fulfillment
  UNFULFILLED: "warning",
  PARTIALLY_FULFILLED: "info",
  FULFILLED: "success",
  // products
  ACTIVE: "success",
  DRAFT: "secondary",
  ARCHIVED: "outline",
  // webhooks and audit
  SUCCEEDED: "success",
  FAILED: "warning",
  DEAD: "destructive",
  SUCCESS: "success",
  ERROR: "destructive",
};

/** A coloured badge for any status enum value. */
export const StatusBadge = ({ value, label }: { value: string | null | undefined; label?: string }) =>
  value ? (
    <Badge variant={TONES[value] ?? "secondary"} dot>
      {label ?? humanize(value)}
    </Badge>
  ) : null;

export const BooleanBadge = ({ value, on = "Active", off = "Inactive" }: { value: boolean | null | undefined; on?: string; off?: string }) => (
  <Badge variant={value ? "success" : "secondary"} dot>
    {value ? on : off}
  </Badge>
);
