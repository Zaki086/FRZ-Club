// v4 §1: role navigation and the page-access rule. The Owner, Manager and Front desk menus are exactly the §1.1 lists
// (labels and order); the Manager and Front desk open only those pages and the detail pages reached from them (RN-1);
// the Owner opens everything by URL (RN-2). Shop, bar, kitchen and accountant menus are unchanged.
import fs from "node:fs";
import path from "node:path";
import type { Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { navFor, navPaths, type StaffRole } from "@/app/(staff)/app/_nav";
import { CAPABILITIES } from "@/server/rbac/permissions";
import { canOpenPage, isStaffPage, PAGE_ALLOWLIST } from "@/server/rbac/page-access";
import type { UserActor } from "@/server/rbac/actor";

const fake = (role: Role): UserActor => ({ kind: "USER", userId: `u-${role}`, role, name: role, memberId: null, employeeId: null });
const labels = (role: StaffRole) => navFor(fake(role), { devTools: true }).flatMap((g) => g.items.map((i) => i.label));
const hrefs = (role: StaffRole) => navFor(fake(role), { devTools: true }).flatMap((g) => g.items.map((i) => i.href.split("?")[0]));

/** v4 §1.1, word for word. */
const SPEC: Record<"OWNER" | "MANAGER" | "FRONT_DESK", string[]> = {
  OWNER: [
    "Dashboard", "Employees", "Command Centre", "Invoices", "Business Clients", "Expenses", "Payroll", "GST Reports", "Ledgers", "Cash Reconciliation",
    "Cash Drawers", "My Account", "Staff Directory", "Attendance", "Price Book", "Reports & Sharing", "Settings", "Audit Log", "Message Log",
    "Notification Log", "Backups", "Data Requests",
  ],
  MANAGER: [
    "Dashboard", "Members", "Command Centre", "Bookings", "Social Play", "Social Players", "Purchase Orders", "Stock & Receipts", "Counter Sales",
    "Bar Day & Close", "Leads Board", "Invoices", "Business Clients", "Expenses", "Cash Reconciliation", "My Account", "Staff Directory", "Attendance",
    "Rosters", "Leave Approvals", "Staff Activity",
  ],
  FRONT_DESK: [
    "Dashboard", "My Cash Drawer", "Refunds", "Check-in & Search Members", "New Members", "Renewal & Dues", "Messages to Send", "Check-in Risk",
    "Command Centre", "Bookings", "Social Play", "Social Players", "Leads Board", "My Shifts & Leave", "My Account", "Notifications",
  ],
};

/** §1.2: the screen behind each item (existing screens; Employees and Check-in Risk are new). */
const SCREEN: Record<string, string> = {
  Dashboard: "/app", Employees: "/app/employees", "Command Centre": "/app/courts", Invoices: "/app/finance/invoices", "Business Clients": "/app/finance/clients",
  Expenses: "/app/finance/expenses", Payroll: "/app/finance/payroll", "GST Reports": "/app/finance/gst", Ledgers: "/app/finance/ledger",
  "Cash Reconciliation": "/app/finance/cash", "Cash Drawers": "/app/finance/drawers", "My Account": "/app/account", "Staff Directory": "/app/staff/employees",
  Attendance: "/app/staff/attendance", "Price Book": "/app/pricing", "Reports & Sharing": "/app/reports", Settings: "/app/settings", "Audit Log": "/app/settings/audit",
  "Message Log": "/app/settings/messages", "Notification Log": "/app/messages", Backups: "/app/settings/backups", "Data Requests": "/app/settings/privacy",
  Members: "/app/members", Bookings: "/app/courts/bookings", "Social Play": "/app/courts/social", "Social Players": "/app/courts/social/players",
  "Purchase Orders": "/app/shop/purchasing", "Stock & Receipts": "/app/shop/stock", "Counter Sales": "/app/shop/sales", "Bar Day & Close": "/app/bar/day",
  "Leads Board": "/app/crm", Rosters: "/app/staff/roster", "Leave Approvals": "/app/staff/leave", "Staff Activity": "/app/staff/activity",
  "My Cash Drawer": "/app/drawer", Refunds: "/app/refunds", "Check-in & Search Members": "/app/desk", "New Members": "/app/members/new",
  "Renewal & Dues": "/app/desk/expiring", "Messages to Send": "/app/messages", "Check-in Risk": "/app/desk/risk", "My Shifts & Leave": "/app/staff/me",
  Notifications: "/app/notifications",
};

/** Shop, bar, kitchen and accountant menus as they were in v3 (unchanged by v4). */
const UNCHANGED: Record<"SHOP_STAFF" | "BAR_STAFF" | "KITCHEN" | "ACCOUNTANT", string[]> = {
  // v6 SM-1 changed this (was: no "Café menu"): Shop staff gain "Café menu" (the v5 menu builder) — the only v6 menu change.
  SHOP_STAFF: ["Counter POS", "Online orders", "Restring queue", "Counter sales", "Products & pricing", "Stock & receipts", "Stock movements", "Purchase orders", "Stock take", "Café menu", "Refunds", "My cash drawer", "My shifts & leave", "My account"],
  // v5 §1.1 changed this (was: no "Menu"): the Bar staff menu gains "Menu" (the menu builder) — the only v5 staff-menu addition.
  BAR_STAFF: ["Tables & tabs", "Ready to serve", "Kitchen display", "All bar tabs", "Bar day & close", "Menu", "Refunds", "My cash drawer", "My shifts & leave", "My account"],
  KITCHEN: ["Kitchen display", "My shifts & leave", "My account"],
  ACCOUNTANT: ["Cash reconciliation", "All cash drawers", "Invoices", "Business clients", "Expenses", "Payroll", "GST report", "Ledger", "Refunds", "My cash drawer", "Dashboard", "Reports & sharing", "Attendance", "Staff directory", "My shifts & leave", "My account"],
};

const APP = path.resolve(__dirname, "../../src/app");
/** Every staff page as a path ("[id]" → "x"). */
function staffPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name), f.name.startsWith("(") ? url : `${url}/${f.name.startsWith("[") ? "x" : f.name}`);
      else if (f.name === "page.tsx") out.push(url || "/");
    }
  };
  walk(path.join(APP, "(staff)"), "");
  return out.filter((p) => !p.startsWith("/setup"));
}
const pageExists = (href: string) => staffPages().includes(href.replace(/\/\*$/, "/x").replace(/\/\*\*$/, "/x/x"));

describe("v4 §1.1 — exact sidebars", () => {
  it.each(["OWNER", "MANAGER", "FRONT_DESK"] as const)("%s: the rendered sidebar is exactly the §1.1 list (labels and order)", (role) => {
    expect(labels(role)).toEqual(SPEC[role]);
  });

  it.each(["OWNER", "MANAGER", "FRONT_DESK"] as const)("%s: each item opens the §1.2 screen, which is a real page", (role) => {
    expect(hrefs(role)).toEqual(SPEC[role].map((l) => SCREEN[l]));
    for (const h of hrefs(role)) expect(staffPages(), `${h} has no page`).toContain(h);
  });

  it("Messages to Send opens the notification log on the WhatsApp messages still to send by hand; Notification Log opens it whole", () => {
    const fd = navFor(fake("FRONT_DESK")).flatMap((g) => g.items).find((i) => i.label === "Messages to Send")!;
    expect(fd.href).toBe("/app/messages?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED");
    expect(navFor(fake("OWNER")).flatMap((g) => g.items).find((i) => i.label === "Notification Log")!.href).toBe("/app/messages");
  });

  it.each(Object.keys(UNCHANGED) as Array<keyof typeof UNCHANGED>)("%s: menu unchanged by v4", (role) => {
    expect(labels(role)).toEqual(UNCHANGED[role]);
  });
});

describe("v4 §1.3 — access rule", () => {
  // A sample of v3 screens the v4 menus dropped.
  const REMOVED: Record<"MANAGER" | "FRONT_DESK", string[]> = {
    MANAGER: ["/app/pricing", "/app/reports", "/app/desk", "/app/desk/expiring", "/app/desk/visits", "/app/messages", "/app/shop", "/app/shop/orders", "/app/shop/products", "/app/shop/movements", "/app/shop/stock-take", "/app/bar", "/app/bar/kds", "/app/bar/tabs", "/app/employees", "/app/settings", "/app/finance/payroll", "/app/finance/ledger"],
    FRONT_DESK: ["/app/members", "/app/shop", "/app/desk/risk/x", "/app/courts/bookings/x", "/app/pricing", "/app/reports", "/app/finance/invoices", "/app/staff/employees", "/app/staff/roster", "/app/staff/leave", "/app/bar", "/app/settings", "/app/employees", "/app/finance/drawers"],
  };

  it.each(["MANAGER", "FRONT_DESK"] as const)("RN-1: %s — every page on its menu opens (200), with or without a filter", (role) => {
    for (const p of navPaths(role)) {
      expect(canOpenPage(role, p), p).toBe(true);
      expect(canOpenPage(role, `${p}?q=x&status=A%2CB`), p).toBe(true);
    }
  });

  it.each(["MANAGER", "FRONT_DESK"] as const)("RN-1: %s — removed pages return 403", (role) => {
    for (const p of REMOVED[role]) expect(canOpenPage(role, p), p).toBe(false);
  });

  it("RN-1: detail pages opened from a listed page are the exception (member, lead, invoice, employee, refund, prints)", () => {
    for (const p of ["/app/members/m1", "/app/crm/l1", "/app/finance/invoices/i1", "/app/finance/invoices/new", "/app/staff/employees/e1", "/app/staff/attendance/summary", "/app/bar/tabs/t1", "/app/refunds?q=RF-000001", "/print/bill/b1", "/print/welcome/m1?t=x", "/app/notifications", "/app/account", "/app/staff/me"]) {
      expect(canOpenPage("MANAGER", p), p).toBe(true);
    }
    for (const p of ["/app/members/m1", "/app/crm/l1", "/app/desk/visits", "/print/bill/b1", "/print/welcome/m1", "/app/notifications", "/kiosk"]) {
      expect(canOpenPage("FRONT_DESK", p), p).toBe(true);
    }
    // v5 §1.1 changed this (was: /app/bar/menu returned 403 for the Manager): the menu builder and its "Preview as
    // member" open by direct link (they are not on the Manager's menu); its prints are under /print/**.
    for (const p of ["/app/bar/menu", "/app/bar/menu/preview", "/print/menu", "/print/menu/tables"]) expect(canOpenPage("MANAGER", p), p).toBe(true);
    expect(canOpenPage("FRONT_DESK", "/app/bar/menu")).toBe(false);
    // One segment only: a detail pattern never opens a deeper screen.
    expect(canOpenPage("MANAGER", "/app/members/m1/edit")).toBe(false);
    expect(canOpenPage("FRONT_DESK", "/app/members")).toBe(false);
  });

  it("RN-1: every allow-listed pattern is a real page and says why", () => {
    for (const role of ["MANAGER", "FRONT_DESK"] as const) {
      for (const x of PAGE_ALLOWLIST[role]) {
        expect(x.why.length, x.path).toBeGreaterThan(10);
        expect(pageExists(x.path) || x.path === "/print/**" || x.path.startsWith("/app/refunds/") || x.path.startsWith("/app/drawer/") || x.path.startsWith("/app/finance/drawers/"), `${role} ${x.path}`).toBe(true);
      }
    }
  });

  it("RN-1: every app link written on a listed page's own screen leads to a page that role may open", () => {
    // Static links in each listed screen's own files (not the dashboard root, whose links come from the server and are
    // checked in the dashboard tests). `${…}` parts stand for an id.
    const linkRe = /["'`](\/(?:app|print)\/[^"'`\s?#]*)/g;
    for (const role of ["MANAGER", "FRONT_DESK"] as const) {
      for (const p of navPaths(role).filter((x) => x !== "/app")) {
        const dir = path.join(APP, "(staff)", p);
        const files = fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".tsx")).map((f) => path.join(dir, f.name));
        for (const sub of ["_components"]) if (fs.existsSync(path.join(dir, sub))) files.push(...fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith(".tsx")).map((f) => path.join(dir, sub, f)));
        for (const f of files) {
          for (const m of fs.readFileSync(f, "utf8").matchAll(linkRe)) {
            const target = m[1].replace(/\$\{[^}]*\}/g, "x").replace(/\/$/, "");
            if (target.includes("/api/")) continue;
            expect(canOpenPage(role, target), `${role}: ${path.relative(APP, f)} links to ${target}`).toBe(true);
          }
        }
      }
    }
  });

  it("RN-2: the Owner opens every staff page by URL; the other roles are not limited by the menu rule (their capabilities decide)", () => {
    const pages = staffPages();
    expect(pages.length).toBeGreaterThan(50);
    for (const p of pages) expect(canOpenPage("OWNER", p), p).toBe(true);
    for (const role of ["SHOP_STAFF", "BAR_STAFF", "KITCHEN", "ACCOUNTANT"] as const) for (const p of pages) expect(canOpenPage(role, p)).toBe(true);
  });

  it("the rule covers staff pages only (API routes, the portal and the public site keep their own checks)", () => {
    for (const p of ["/api/approvals", "/api/refunds/x/approve", "/portal", "/login", "/"]) {
      expect(isStaffPage(p)).toBe(false);
      expect(canOpenPage("FRONT_DESK", p)).toBe(true);
    }
  });
});

describe("v4 RN-3 — capability matrix", () => {
  it("RN-3: the price book is Owner-only; shop pricing is Owner and shop staff (no Manager)", () => {
    expect(CAPABILITIES["pricing.manage"]).toEqual(["OWNER"]);
    expect(CAPABILITIES["shop.pricing"]).toEqual(["OWNER", "SHOP_STAFF"]);
  });

  it("RN-3: refund approval stays Manager and Owner; leave approval stays Manager and Owner", () => {
    expect(CAPABILITIES["refunds.approve"]).toEqual(["OWNER", "MANAGER"]);
    expect(CAPABILITIES["leave.approve"]).toEqual(["OWNER", "MANAGER"]);
  });
});
