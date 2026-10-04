// v4 §1.3 — which staff pages a role may open.
//  RN-1: the Manager and the Front desk open only the pages on their menu (v4 §1.1), plus the detail pages and linked
//        screens listed below — each entry says which listed page (or notification) leads there. Anything else → 403.
//  RN-2: the Owner opens every page by direct link (the menu shows only the §1.1 list).
// The other roles (shop, bar, kitchen, accountant) are unchanged: each page's own capability check decides.
// This is a page rule only: API routes keep their capability checks (a listed page's own API calls never change).
import type { Role } from "@prisma/client";
import { navPaths } from "@/app/(staff)/app/_nav";

/** The roles whose pages are limited to their menu (RN-1). */
export const MENU_BOUND_ROLES = ["MANAGER", "FRONT_DESK"] as const;
export type MenuBoundRole = (typeof MENU_BOUND_ROLES)[number];

/**
 * A page pattern: "/app/x" is that page only; "/app/x/*" is one more path segment (an id, or "new"); "/print/**"
 * is anything below. Query strings never matter (a filtered list is still its page).
 */
export type PagePattern = { path: string; why: string };

/** Reached from the header on every staff page, and the 403 page itself. */
const EVERY_PAGE: PagePattern[] = [
  { path: "/app/account", why: "the name link in the header" },
  { path: "/app/notifications", why: "the bell in the header (the full inbox)" },
  { path: "/app/forbidden", why: "the 403 page" },
  { path: "/print/**", why: "receipts and the welcome slip printed from a bill, a tab or a member (each print page checks its own access)" },
  { path: "/kiosk", why: "the entrance tablet: a device session set up by staff who check members in, not a menu screen" },
];

/** RN-1 exceptions: detail pages opened from a listed page (or from a notification), per role. */
export const PAGE_ALLOWLIST: Record<MenuBoundRole, PagePattern[]> = {
  MANAGER: [
    ...EVERY_PAGE,
    { path: "/app/drawer", why: "the header drawer badge, shown while the Manager has a drawer open (cash taken at a counter) — to count and close it" },
    { path: "/app/staff/me", why: "own clock-in/out, shifts and leave requests — the link on My Account (the Manager's menu has no such entry)" },
    { path: "/app/members/*", why: "member detail from Members, Bookings, lead detail and the notification log" },
    { path: "/app/members/new", why: "\"New member\" on Members and \"Convert to member\" on a lead" },
    { path: "/app/crm/*", why: "lead detail from the Leads Board and lead notifications" },
    { path: "/app/bar/tabs/*", why: "tab detail from Bar Day & Close" },
    { path: "/app/finance/invoices/*", why: "invoice detail and new invoice from Invoices and Business Clients, invoice notifications" },
    { path: "/app/staff/employees/*", why: "employee page from the Staff Directory and Attendance" },
    { path: "/app/staff/attendance/summary", why: "the per-employee summary linked from Attendance" },
    { path: "/app/refunds/*", why: "a refund's page, from the approvals panel and the \"refund to approve\" notification" },
    { path: "/app/refunds", why: "\"← All refunds\" on a refund's page" },
    { path: "/app/finance/drawers", why: "drawer session detail from the approvals panel (variances) and Cash Reconciliation" },
    { path: "/app/finance/drawers/*", why: "drawer session detail from the approvals panel (variances) and Cash Reconciliation" },
    // v5 §1.1: the menu builder is the Bar staff's menu item; the Manager opens it by direct link (not on the menu).
    { path: "/app/bar/menu", why: "v5 §1.1 the bar & café menu builder (categories, items, base prices) — by direct link" },
    { path: "/app/bar/menu/preview", why: "v5 MN-4 \"Preview as member\" on the Menu screen (its A4 print and table QR cards are /print/menu/**)" },
  ],
  FRONT_DESK: [
    ...EVERY_PAGE,
    { path: "/app/members/*", why: "member detail from Check-in & Search Members, Renewal & Dues, Check-in Risk, Messages to Send and leads" },
    { path: "/app/crm/*", why: "lead detail from the Leads Board and lead notifications" },
    { path: "/app/desk/visits", why: "\"Checked in\" on the desk's Today strip (Check-in & Search Members)" },
    { path: "/app/refunds/*", why: "refund detail and receipt from Refunds" },
    { path: "/app/drawer/*", why: "drawer screens opened from My Cash Drawer" },
  ],
};

function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
  const p = pattern.split("/");
  const q = path.split("/");
  return p.length === q.length && p.every((seg, i) => (seg === "*" ? q[i].length > 0 : seg === q[i]));
}

/** The bare path of a request path ("/app/x?y" → "/app/x", no trailing slash). */
export function barePath(path: string): string {
  const p = path.split("?")[0].split("#")[0];
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Is this a page the access rule covers (the staff screens, prints and the kiosk)? API routes and other areas are not. */
export function isStaffPage(path: string): boolean {
  const p = barePath(path);
  return p === "/app" || p.startsWith("/app/") || p.startsWith("/print/") || p === "/kiosk";
}

/** RN-1 / RN-2: may this role open this staff page? (Pages outside the staff area are not this rule's business.) */
export function canOpenPage(role: Role, path: string): boolean {
  if (!isStaffPage(path)) return true;
  if (!(MENU_BOUND_ROLES as readonly Role[]).includes(role)) return true; // RN-2 for the Owner; other roles unchanged
  const p = barePath(path);
  const r = role as MenuBoundRole;
  return navPaths(r).includes(p) || PAGE_ALLOWLIST[r].some((x) => matches(x.path, p));
}
