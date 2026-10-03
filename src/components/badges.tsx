import { Badge } from "./ui/badge";

const TIER_TONE = { GOLD: "gold", SILVER: "silver", JUNIOR: "junior", WALK_IN: "neutral" } as const;

export function TierBadge({ tier }: { tier: string }) {
  const tone = TIER_TONE[tier as keyof typeof TIER_TONE] ?? "neutral";
  return <Badge tone={tone}>{tier === "WALK_IN" ? "Walk-in" : tier.charAt(0) + tier.slice(1).toLowerCase()}</Badge>;
}

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "blue" | "neutral" | "purple" | "dark"> = {
  ACTIVE: "green", PAID: "green", CONFIRMED: "green", SETTLED: "green", COMPLETED: "green", SUCCEEDED: "green",
  COLLECTED: "green", DELIVERED: "green", WON: "green", APPROVED: "green", JOINED: "green", SERVED: "green",
  SCHEDULED: "blue", READY: "blue", READY_FOR_PICKUP: "blue", ISSUED: "blue", QUOTED: "blue", PACKED: "blue",
  OUT_FOR_DELIVERY: "blue", IN_PROGRESS: "blue", PREPARING: "amber", CONTACTED: "blue", ASSIGNED: "green",
  PENDING_PAYMENT: "amber", UNPAID: "amber", PARTIAL: "amber", PARTIALLY_PAID: "amber", PENDING: "amber",
  NEW: "purple", RECEIVED: "purple", OPEN: "amber", DRAFT: "neutral", CARRIED: "amber",
  EXPIRED: "red", CANCELLED: "red", CANCELLED_BY_CLUB: "amber", NO_SHOW: "red", FAILED: "red", VOID: "red", LOST: "red", REJECTED: "red",
  OVERDUE: "red", REFUNDED: "neutral", PARTIALLY_REFUNDED: "neutral", CHANGED: "neutral", LEFT: "neutral",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{label ?? status.replace(/_/g, " ")}</Badge>;
}
