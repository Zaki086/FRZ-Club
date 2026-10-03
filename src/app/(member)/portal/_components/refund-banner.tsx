"use client";
// v4 §3.4: on the portal home, while money waits at the desk — "₹550 refund ready to collect at the front desk" with
// Show QR (the member's own and their Juniors' refunds).
import Link from "next/link";
import { Banknote } from "lucide-react";
import { useApi } from "@/components/api";
import { formatINR } from "@/lib/money";
import { RefundQrButton } from "./refund-qr";

type Data = { refunds: Array<{ id: string; code: string; amount: number; toCollect: number; token: string | null; forName: string | null }>; ready: { count: number; amount: number } };

export function RefundReadyBanner() {
  const { data } = useApi<Data>("/api/portal/refunds");
  if (!data?.ready.count) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-4" data-testid="refund-ready-banner">
      <p className="flex items-center gap-2 font-semibold">
        <Banknote className="h-5 w-5" /> {formatINR(data.ready.amount)} refund ready to collect at the front desk
      </p>
      <div className="flex items-center gap-2">
        <Link href="/portal/refunds" className="text-sm font-semibold text-primary underline">Details</Link>
        <RefundQrButton refunds={data.refunds.filter((r) => r.token)} />
      </div>
    </div>
  );
}
