// v3 RF-6: the refunds queue — every refund request with its stage, who asked, who decided and how it was paid.
import { Prisma } from "@prisma/client";
import { can } from "../../rbac/permissions";
import { BILL_CAPABILITY } from "../payments";
import type { ListDef } from "./core";

const SOURCES = Object.keys(BILL_CAPABILITY) as Array<keyof typeof BILL_CAPABILITY>;

export const refundsList: ListDef = {
  name: "refunds",
  title: "Refunds",
  view: ["refunds.request", "refunds.approve", "invoices"],
  exportCaps: ["dashboard.ops", "dashboard.finance"],
  base: (ctx) => {
    // Staff see refunds on the bills they can see (the same rule as viewing a bill).
    const wide = can(ctx.actor, "members.view") || can(ctx.actor, "finance.reports");
    const sources = SOURCES.filter((s) => wide || can(ctx.actor, BILL_CAPABILITY[s]));
    return Prisma.sql`
      SELECT r.id, r.code, r.created_at, r.bill_id, r.decided_by, b.customer_name AS customer, b.source_type::text AS source, b.member_id,
        r.amount, r.reason, r.note, r.status, r.auto_approved, r.policy, r.requested_via, r.requested_by,
        ru.name AS requested_by_name, du.name AS decided_by_name, r.decided_at, r.decision_note, r.completed_at, r.failure_reason,
        r.amount > COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = 'refund_manager_limit'), 500000) AS needs_owner,
        COALESCE(pp.pending, 0) AS pending_amount, pp.paid_methods,
        (SELECT array_agg(DISTINCT p.method::text) FROM payments p WHERE p.bill_id = r.bill_id AND p.type = 'PAYMENT' AND p.status = 'SUCCEEDED') AS original_methods
      FROM refund_requests r
      JOIN bills b ON b.id = r.bill_id
      LEFT JOIN users ru ON ru.id = r.requested_by
      LEFT JOIN users du ON du.id = r.decided_by
      LEFT JOIN LATERAL (SELECT sum(p.amount) FILTER (WHERE p.status = 'PENDING') AS pending,
                                string_agg(DISTINCT p.method::text, ', ') FILTER (WHERE p.status = 'SUCCEEDED') AS paid_methods
                           FROM payments p WHERE p.refund_request_id = r.id AND p.type = 'REFUND') pp ON TRUE
      WHERE b.source_type::text = ANY(${sources}::text[])`;
  },
  search: ["b.code", "b.customer", "b.note"],
  dateColumn: { expr: "b.created_at", label: "Asked", kind: "timestamp" },
  facets: [
    { key: "status", label: "Status", expr: "b.status", options: [
      { value: "REQUESTED", label: "Awaiting approval" }, { value: "APPROVED", label: "Ready to pay out" }, { value: "COMPLETED", label: "Completed" },
      { value: "FAILED", label: "Failed" }, { value: "REJECTED", label: "Rejected" }, { value: "CANCELLED", label: "Withdrawn" },
    ] },
    { key: "reason", label: "Reason", expr: "b.reason", options: [
      { value: "POLICY_CANCELLATION", label: "Cancellation within policy" }, { value: "CLUB_CANCELLATION", label: "Cancelled by the club" },
      { value: "PRODUCT_RETURN", label: "Product return" }, { value: "SERVICE_ISSUE", label: "Service issue" },
      { value: "DUPLICATE_CHARGE", label: "Duplicate or over-payment" }, { value: "GOODWILL", label: "Goodwill" }, { value: "OTHER", label: "Other" },
    ] },
    { key: "source", label: "For", expr: "b.source", options: [
      { value: "BOOKING", label: "Court booking" }, { value: "SOCIAL_JOIN", label: "Social play" }, { value: "MEMBERSHIP", label: "Membership" },
      { value: "COUNTER_SALE", label: "Shop sale" }, { value: "SHOP_ORDER", label: "Online order" }, { value: "SERVICE_TICKET", label: "Restring" },
      { value: "BAR_TAB", label: "Bar tab" }, { value: "INVOICE", label: "Invoice" },
    ] },
    { key: "method", label: "Method", expr: "COALESCE(b.original_methods, ARRAY[]::text[])", multi: true, options: [
      { value: "CASH", label: "Cash" }, { value: "UPI", label: "UPI" }, { value: "CARD", label: "Card" }, { value: "ONLINE", label: "Online" }, { value: "BANK_TRANSFER", label: "Bank transfer" },
    ] },
    { key: "requester", label: "Requested by", expr: "b.requested_by", labelsSql: "SELECT id AS value, name AS label FROM users" },
    { key: "approver", label: "Approver", expr: "b.decided_by", labelsSql: "SELECT id AS value, name AS label FROM users" },
    { key: "amount", label: "Amount", expr: "CASE WHEN b.amount < 50000 THEN 'lt500' WHEN b.amount < 200000 THEN '500-2000' WHEN b.amount <= 500000 THEN '2000-5000' ELSE 'gt5000' END", options: [
      { value: "lt500", label: "Under ₹500" }, { value: "500-2000", label: "₹500 – ₹2,000" }, { value: "2000-5000", label: "₹2,000 – ₹5,000" }, { value: "gt5000", label: "Over ₹5,000" },
    ] },
    { key: "approval", label: "Approval", expr: "CASE WHEN b.auto_approved THEN 'policy' ELSE 'manual' END", options: [{ value: "policy", label: "By policy (automatic)" }, { value: "manual", label: "Approved by a person" }] },
    { key: "via", label: "Asked by", expr: "b.requested_via", options: [{ value: "STAFF", label: "Staff" }, { value: "MEMBER", label: "Member" }, { value: "SYSTEM", label: "System" }] },
    { key: "mine", label: "Mine", expr: "b.requested_by", meAlias: true, options: [{ value: "me", label: "Asked by me" }] },
  ],
  sorts: {
    stage: { label: "To do first", sql: "CASE b.status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'FAILED' THEN 2 ELSE 3 END, b.created_at DESC" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    amount: { label: "Largest first", sql: "b.amount DESC, b.created_at DESC" },
  },
  defaultSort: "stage",
  summary: [
    { key: "awaiting", label: "Awaiting approval", sql: "count(*) FILTER (WHERE b.status = 'REQUESTED')", format: "count", apply: { status: "REQUESTED" } },
    { key: "ready", label: "Ready to pay out", sql: "count(*) FILTER (WHERE b.status = 'APPROVED')", format: "count", apply: { status: "APPROVED" } },
    { key: "today", label: "Completed today", sql: "COALESCE(sum(b.amount) FILTER (WHERE b.status = 'COMPLETED' AND (b.completed_at AT TIME ZONE 'Asia/Kolkata')::date = (app_now() AT TIME ZONE 'Asia/Kolkata')::date), 0)", format: "money", apply: { status: "COMPLETED", range: "TODAY" } },
    { key: "failed", label: "Failed", sql: "count(*) FILTER (WHERE b.status = 'FAILED')", format: "count", apply: { status: "FAILED" } },
  ],
  csv: [
    { key: "code", label: "Request" }, { key: "created_at", label: "Asked", format: "datetime" }, { key: "customer", label: "Customer" },
    { key: "source", label: "For" }, { key: "amount", label: "Amount (₹)", format: "money" }, { key: "reason", label: "Reason" }, { key: "note", label: "Note" },
    { key: "status", label: "Status" }, { key: "requested_by_name", label: "Asked by" }, { key: "decided_by_name", label: "Decided by" },
    { key: "paid_methods", label: "Paid by" }, { key: "completed_at", label: "Completed", format: "datetime" },
  ],
};
