export type TabSummary = { id: string; code: string; payer: string; tier: string; total: number; due: number };
export type TableRow = { id: string; number: number; capacity: number; area: string; status: "FREE" | "OCCUPIED"; tabs: TabSummary[] };
export type TablesData = { tables: TableRow[]; unassigned: TabSummary[] };
export type MenuItem = { id: string; name: string; category: "FOOD" | "BEVERAGE" | "ALCOHOL"; price: number; isAlcoholic: boolean; available: boolean };
export type TabLine = {
  id: string; name: string; category: string; isAlcoholic: boolean; qty: number; unitPrice: number; discountPct: number;
  discountAmount: number; netAmount: number; note: string | null; status: "NEW" | "PREPARING" | "READY" | "SERVED" | "VOID";
  sent: boolean; voidReason: string | null; explanation: string;
  /** v5 MO-10: ordered by the member in the app or entered by staff; app lines wait for the bar's Accept (MO-3). */
  source?: "APP" | "STAFF"; awaitingAcceptance?: boolean;
};
export type TabView = {
  id: string; code: string; status: string; payer: string; memberId: string | null; guestId: string | null; tier: string;
  table: { id: string; number: number } | null; guestIdVerified: boolean; billId: string; total: number; paid: number; due: number;
  discountTotal: number; carriedReason: string | null; openedAt: string; barDate: string; lines: TabLine[];
  /** v6 JR-1: a Junior's / under-18's tab — settled in one payment (no split). */
  noSplit?: boolean;
};
export type StaffMe = {
  clockedIn: { id: string; since: string; openingFloat: number; cashExpected: number } | null;
  shifts: Array<{ id: string; date: string; startAt: string; endAt: string; area: string; status: string }>;
  leave: Array<{ id: string; type: string; startDate: string; endDate: string; days: number; reason: string; status: string; decisionNote: string | null }>;
  attendance: Array<{ id: string; clockIn: string; clockOut: string | null; cashExpected: number | null; cashCounted: number | null; variance: number | null }>;
  allowance: { CASUAL: { total: number; used: number }; SICK: { total: number; used: number } };
  today: string;
};
