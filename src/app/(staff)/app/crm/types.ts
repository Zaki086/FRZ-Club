// Shapes returned by the CRM API (rendered as-is).
export type LeadRow = {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string;
  interest: string;
  status: "NEW" | "CONTACTED" | "QUOTED" | "WON" | "LOST";
  assignee: string | null;
  assignedTo: string | null;
  nextFollowUpAt: string;
  overdue: boolean;
  createdAt: string;
  lostReason: string | null;
};

export type LeadDetail = LeadRow & {
  message: string;
  memberId: string | null;
  bookingId: string | null;
  activities: Array<{ id: string; type: string; note: string; at: string; by: string }>;
  quotes: Array<{ id: string; token: string; total: number; validUntil: string; status: string; expired: boolean; createdAt: string; lines: Array<{ description: string; amount: number }> }>;
  assignable: Array<{ id: string; name: string; role: string }>;
  /** v3 LA-6/LA-7 */
  assignmentReason: string | null;
  canReassign: boolean;
  convertUrl: string;
};

export const STATUSES = ["NEW", "CONTACTED", "QUOTED", "WON", "LOST"] as const;
