// v3 §3.2: members' data requests (DPDP, Owner): erasure requests to decide, and the self-service downloads logged
// as completed EXPORT requests. Opens on erasure requests, as the page did before.
import { Prisma } from "@prisma/client";
import type { ListDef } from "./core";

export const dataRequestsList: ListDef = {
  name: "data-requests",
  title: "Data requests",
  view: ["privacy.manage"],
  exportCaps: ["privacy.manage"],
  base: () => Prisma.sql`
    SELECT d.id, d.kind, d.status, d.note, d.created_at, d.handled_at, d.member_id, d.handled_by,
      m.name AS member_name, m.member_code, m.anonymised_at, hu.name AS handled_by_name
    FROM data_requests d
    LEFT JOIN members m ON m.id = d.member_id
    LEFT JOIN users hu ON hu.id = d.handled_by`,
  search: ["b.member_name", "b.member_code", "b.note"],
  dateColumn: { expr: "b.created_at", label: "Asked", kind: "timestamp" },
  facets: [
    { key: "kind", label: "Kind", expr: "b.kind", options: [{ value: "ERASE", label: "Erase my data" }, { value: "EXPORT", label: "Download (self-service)" }] },
    { key: "status", label: "Status", expr: "b.status", options: [{ value: "OPEN", label: "Open" }, { value: "DONE", label: "Done" }, { value: "REJECTED", label: "Rejected" }] },
  ],
  sorts: {
    todo: { label: "Open first", sql: "CASE b.status WHEN 'OPEN' THEN 0 ELSE 1 END, b.created_at DESC" },
    newest: { label: "Newest first", sql: "b.created_at DESC" },
    oldest: { label: "Oldest first", sql: "b.created_at ASC" },
  },
  defaultSort: "todo",
  defaults: () => ({ kind: "ERASE" }),
  summary: [
    { key: "open", label: "Open", sql: "count(*) FILTER (WHERE b.status = 'OPEN')", format: "count", apply: { status: "OPEN" } },
    { key: "done", label: "Done", sql: "count(*) FILTER (WHERE b.status = 'DONE')", format: "count", apply: { status: "DONE" } },
    { key: "rejected", label: "Rejected", sql: "count(*) FILTER (WHERE b.status = 'REJECTED')", format: "count", apply: { status: "REJECTED" } },
  ],
  csv: [
    { key: "created_at", label: "Asked", format: "datetime" }, { key: "member_code", label: "Member" }, { key: "member_name", label: "Name" },
    { key: "kind", label: "Kind" }, { key: "status", label: "Status" }, { key: "note", label: "Note" },
    { key: "handled_by_name", label: "Handled by" }, { key: "handled_at", label: "Handled", format: "datetime" },
  ],
};
