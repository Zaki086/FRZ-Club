"use client";
// v4 §2.4: how a drawer movement is shown — type, what it points at (bill, refund, expense) and the running balance.
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Money } from "./money";
import { BillLines, type BillView } from "./payment-panel";
import { DataState } from "./states";
import { useApi } from "./api";

export const MOVEMENT_LABEL: Record<string, string> = {
  OPENING_FLOAT: "Opening float", CASH_SALE: "Cash sale", CASH_REFUND: "Cash refund", PAY_IN: "Pay in",
  PAY_OUT: "Pay out", CASH_DROP: "Cash drop", CLOSING_ADJUSTMENT: "Closing adjustment",
};
const TONE: Record<string, "green" | "red" | "amber" | "blue" | "neutral"> = {
  OPENING_FLOAT: "blue", CASH_SALE: "green", CASH_REFUND: "red", PAY_IN: "blue", PAY_OUT: "amber", CASH_DROP: "neutral", CLOSING_ADJUSTMENT: "amber",
};
const SOURCE: Record<string, string> = {
  BOOKING: "booking", SOCIAL_JOIN: "social play", MEMBERSHIP: "membership", COUNTER_SALE: "shop sale", SHOP_ORDER: "shop order",
  SERVICE_TICKET: "restring", BAR_TAB: "bar tab", INVOICE: "invoice",
};

export type MovementRow = {
  id: string; line_no: number; type: string; amount: number; balance_after: number; at: string; at_close?: boolean;
  reference: string | null; category: string | null; note: string | null; bill_id: string | null; customer: string | null; source: string | null;
  refund_code: string | null; expense_vendor?: string | null; expense_id?: string | null;
};

export function MovementType({ type }: { type: string }) {
  return <Badge tone={TONE[type] ?? "neutral"}>{MOVEMENT_LABEL[type] ?? type}</Badge>;
}

/** What the movement is about, with the link to the refund where there is one. */
export function MovementDetail({ m }: { m: MovementRow }) {
  const parts: ReactNode[] = [];
  if (m.customer) parts.push(<span key="c" className="font-medium">{m.customer}</span>);
  if (m.source) parts.push(<span key="s" className="text-muted-foreground">{SOURCE[m.source] ?? m.source.toLowerCase()}</span>);
  if (m.refund_code) parts.push(<Link key="r" href={`/app/refunds?q=${m.refund_code}`} className="font-mono text-primary underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{m.refund_code}</Link>);
  if (m.type === "PAY_OUT") parts.push(<span key="e">Expense{m.expense_vendor ? ` · ${m.expense_vendor}` : ""}{m.category ? ` · ${m.category.replace(/_/g, " ").toLowerCase()}` : ""}</span>);
  if (m.type === "CASH_DROP" && m.reference) parts.push(<span key="b">Bag {m.reference}</span>);
  if (m.note) parts.push(<span key="n" className="text-muted-foreground">{m.note}</span>);
  return <span className="flex flex-wrap gap-x-2 text-sm">{parts.length ? parts.reduce<ReactNode[]>((a, p, i) => (i ? [...a, <span key={`d${i}`} aria-hidden>·</span>, p] : [p]), []) : "—"}</span>;
}

export function MovementAmount({ m }: { m: MovementRow }) {
  return <Money paise={m.amount} className={m.amount > 0 ? "font-semibold text-success-text" : "font-semibold"} />;
}

/** The bill behind a sale or refund (expanded under the row). */
export function MovementBill({ billId }: { billId: string }) {
  const state = useApi<BillView>(`/api/bills/${billId}`);
  return <DataState state={state}>{(b) => <div className="max-w-xl"><BillLines bill={b} /></div>}</DataState>;
}
