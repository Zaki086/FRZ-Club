// Permission matrix (plan §3), enforced inside services. The UI may hide things, but this is the gate.
import type { Role } from "@prisma/client";
import { DomainError } from "../errors";
import type { Actor, UserActor } from "./actor";

const O: Role = "OWNER";
const M: Role = "MANAGER";
const FD: Role = "FRONT_DESK";
const SS: Role = "SHOP_STAFF";
const BS: Role = "BAR_STAFF";
const AC: Role = "ACCOUNTANT";
const K: Role = "KITCHEN";
const STAFF: Role[] = [O, M, FD, SS, BS, AC];
/** Everyone employed by the club, including the kitchen (which only uses the KDS and its own shifts/leave). */
const EMPLOYEES: Role[] = [...STAFF, K];

export const CAPABILITIES = {
  "members.manage": [O, M, FD],
  "members.view": [O, M, FD, AC],
  // Name/phone/code search so the shop and bar can attach a sale or tab to a member (R-05, R-24, R-27).
  "members.lookup": STAFF,
  "bookings.any": [O, M, FD],
  "courts.view": [O, M, FD],
  "social.manage": [O, M],
  "maintenance.manage": [O, M],
  "checkin": [O, M, FD],
  "shop.counter": [O, M, FD, SS],
  "shop.stock": [O, M, SS],
  "shop.fulfil": [O, M, SS],
  "shop.view": [O, M, FD, SS],
  "bar.operate": [O, M, BS],
  "bar.kds": [O, M, BS, K],
  "bar.void_after_prep": [O, M],
  "bar.close_day": [O, M],
  "bar.report": [O, M, BS],
  "refunds.issue": [O, M],
  "membership.cancel": [O, M],
  "crm": [O, M, FD],
  "invoices": [O, M, AC],
  "expenses.manage": [O, AC],
  "expenses.view": [O, M, AC],
  "roster.manage": [O, M],
  "roster.view_own": EMPLOYEES,
  "staff.self": EMPLOYEES,
  "cash.reconcile": [O, M, AC],
  "users.manage": [O],
  "password.links": [O, M, FD],
  "leave.approve": [O, M],
  "payroll": [O, AC],
  "finance.reports": [O, AC],
  "gst": [O, AC],
  "dashboard.full": [O],
  "dashboard.ops": [O, M],
  "dashboard.finance": [O, AC],
  "dashboard.desk": [O, M, FD],
  "dashboard.shop": [O, M, SS],
  "dashboard.bar": [O, M, BS],
  "settings": [O],
  "audit": [O],
  "share_links": [O],
  "dev_tools": [O],
  "notifications.staff": EMPLOYEES,
  // Completion pass §3: WhatsApp links from staff screens; the Owner reads every message sent.
  "messages.send": STAFF,
  "messages.log": [O],
  // Completion pass P1 (DPDP): data export / erasure requests are decided by the Owner.
  "privacy.manage": [O],
  // Completion pass §7 (manager): what each staff member did, by day.
  "staff.activity": [O, M],
} as const satisfies Record<string, Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(actor: Actor, cap: Capability): boolean {
  if (actor.kind === "SYSTEM") return true;
  if (actor.kind !== "USER") return false;
  return (CAPABILITIES[cap] as readonly Role[]).includes(actor.role);
}

const CAP_LABEL: Partial<Record<Capability, string>> = {
  payroll: "payroll",
  gst: "the GST report",
  settings: "settings",
  "finance.reports": "finance reports",
  "dashboard.full": "the owner dashboard",
  audit: "the audit log",
};

/** Throws FORBIDDEN unless the actor holds the capability. */
export function assertCan(actor: Actor, cap: Capability): asserts actor is UserActor | Extract<Actor, { kind: "SYSTEM" }> {
  if (!can(actor, cap)) {
    const who = actor.kind === "USER" ? actor.role.replace("_", " ").toLowerCase() : "the public";
    throw new DomainError(
      "FORBIDDEN",
      `Not allowed: ${who} cannot access ${CAP_LABEL[cap] ?? cap.replace(/[._]/g, " ")}.`,
      { capability: cap },
    );
  }
}

/** Staff with `cap`, or the member themself. */
export function assertStaffOrSelf(actor: Actor, cap: Capability, memberId: string | null | undefined): void {
  if (can(actor, cap)) return;
  if (actor.kind === "USER" && actor.role === "MEMBER" && memberId && actor.memberId === memberId) return;
  throw new DomainError("FORBIDDEN", "Not allowed: you can only act on your own records.", { capability: cap });
}

export function assertUser(actor: Actor): asserts actor is UserActor {
  if (actor.kind !== "USER") throw new DomainError("UNAUTHENTICATED", "Please log in.");
}
