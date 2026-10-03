export type Kpi = { value: number; prev: number; change: number | null };
export type PeriodKey = "TODAY" | "WEEK" | "MONTH" | "CUSTOM";
export type PeriodState = { period: PeriodKey; from: string; to: string };
export type Scope = "FULL" | "OPS" | "FINANCE" | "BAR" | "SHOP" | "DESK";

export type Dashboard = {
  period: { key: string; label: string; from: string; to: string; prevFrom: string; prevTo: string };
  scope: Scope;
  generatedAt: string;
  money: {
    collected?: Kpi;
    bySource?: Record<string, Kpi>;
    byMethod?: Record<string, Kpi>;
    expenses?: Kpi;
    payroll?: Kpi;
    netCashFlow?: Kpi;
    courts?: Kpi;
    social?: Kpi;
    memberships?: Kpi;
  };
  receivables?: { total: number; count: number };
  payables?: { total: number; expenses: number; payroll: number; gst: number; expenseCount?: number; payrollRuns?: number };
  ops?: {
    bookings?: Kpi;
    cancellations?: Kpi;
    noShows?: Kpi;
    utilization?: { pct: number; bookedHours: number; openHours: number; heatmap: { hours: number[]; courts: Array<{ court: string; cells: number[] }> } };
    members?: { activeByTier: Record<string, number>; activeTotal: number; newMembers: number; expiringSoon: number };
    shop?: { topProducts: Array<{ name: string; qty: number; revenue: number }>; lowStock: number; openOrders: number };
    bar?: { revenue: Kpi; averageTab: number; settledTabs: number; openTabs: number };
    leads?: { newLeads: number; overdue: number; won: number; conversionRate: number };
  };
  daily?: Array<Record<string, number | string>>;
};

export const SOURCES = ["COURTS", "SOCIAL", "SHOP", "BAR", "MEMBERSHIP", "INVOICE"] as const;
export const METHODS = ["CASH", "CARD", "UPI", "BANK_TRANSFER", "ONLINE"] as const;

export const SOURCE_LABEL: Record<string, string> = {
  COURTS: "Courts", SOCIAL: "Social play", SHOP: "Shop", BAR: "Bar & cafe", MEMBERSHIP: "Memberships", INVOICE: "Invoices",
};
export const METHOD_LABEL: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", BANK_TRANSFER: "Bank transfer", ONLINE: "Online" };

/** Categorical palette for sources (also used by the stacked daily chart). */
export const SOURCE_COLOR: Record<string, string> = {
  COURTS: "#0f5132", SOCIAL: "#7c3aed", SHOP: "#2563eb", BAR: "#d97706", MEMBERSHIP: "#db2777", INVOICE: "#0891b2",
};

export function periodQuery(p: PeriodState): string {
  const q = new URLSearchParams({ period: p.period });
  if (p.period === "CUSTOM") {
    q.set("from", p.from);
    q.set("to", p.to);
  }
  return q.toString();
}

export function periodReady(p: PeriodState): boolean {
  return p.period !== "CUSTOM" || (/^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to) && p.from <= p.to);
}
