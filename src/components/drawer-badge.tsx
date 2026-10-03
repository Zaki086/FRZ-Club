"use client";
// v4 CD-1: "Cash in drawer ₹X" for the signed-in staff member's open drawer session. Polls every 4 s and refreshes at
// once when a payment/refund/movement response fires DRAWER_CHANGED_EVENT. Renders nothing when no drawer is open.
import Link from "next/link";
import { useEffect } from "react";
import { Wallet } from "lucide-react";
import { useApi } from "./api";
import { formatINR } from "@/lib/money";

export const DRAWER_CHANGED_EVENT = "cc:drawer-changed";

/** Call after any response that moved cash in the signed-in user's drawer. */
export function drawerChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DRAWER_CHANGED_EVENT));
}

type Balance = { open: null | { sessionId: string; name: string; balancePaise: number } };

export function DrawerBadge() {
  const state = useApi<Balance>("/api/drawer/balance", { pollMs: 4000 });
  const { reload } = state;
  useEffect(() => {
    const again = () => void reload();
    window.addEventListener(DRAWER_CHANGED_EVENT, again);
    return () => window.removeEventListener(DRAWER_CHANGED_EVENT, again);
  }, [reload]);
  const open = state.data?.open;
  if (!open) return null;
  return (
    <Link
      href="/app/drawer"
      className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-3 py-1 text-xs font-medium text-foreground hover:bg-success/20"
      title={`${open.name} — open your cash drawer`}
      data-testid="drawer-badge"
    >
      <Wallet className="h-3.5 w-3.5" aria-hidden />
      <span>Cash in drawer</span>
      <span className="font-semibold tabular-nums" data-testid="drawer-badge-amount">{formatINR(open.balancePaise)}</span>
    </Link>
  );
}
