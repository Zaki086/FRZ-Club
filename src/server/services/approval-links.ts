// v4 RN-4: the detail page of each kind of approval. The "Needs your approval" row and the approval notification
// open the same page. (A module of its own so the services that send those notifications can import it freely.)
export const APPROVAL_HREF = {
  /** The refund's own page (the "refund to approve" notification opens it too). */
  refund: (id: string) => `/app/refunds/${encodeURIComponent(id)}`,
  /** Pending leave of that person. */
  leave: (employeeId: string) => `/app/staff/leave?status=PENDING&employee=${encodeURIComponent(employeeId)}`,
  /** That person's missing clock-outs, each with its correction. */
  attendance: (employeeId: string) => `/app/staff/attendance?flag=missing&employee=${encodeURIComponent(employeeId)}`,
};
