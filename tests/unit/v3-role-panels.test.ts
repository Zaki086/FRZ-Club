// Role panels: each role's staff menu holds only its own daily work, every screen once, and nothing it can't open;
// each role's home leads with what is waiting for it (services/todo.ts), counted from the real records.
import fs from "node:fs";
import path from "node:path";
import type { Role } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { navFor, ROLE_NAV, type StaffRole } from "@/app/(staff)/app/_nav";
import { ROLE_HOME } from "@/server/auth/sessions";
import { can } from "@/server/rbac/permissions";
import type { UserActor } from "@/server/rbac/actor";
import { deskToday } from "@/server/services/desk";
import { requestLeave } from "@/server/services/staff";
import { myTodo, todoKeys, TODO_HOME } from "@/server/services/todo";
import { makeWorld, type World } from "../helpers/world";

const ROLES: StaffRole[] = ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "KITCHEN", "ACCOUNTANT"];
const fake = (role: Role): UserActor => ({ kind: "USER", userId: `u-${role}`, role, name: role, memberId: null, employeeId: null });
const bare = (href: string) => href.split("?")[0];
const hrefs = (role: StaffRole) => navFor(fake(role)).flatMap((g) => g.items.map((i) => bare(i.href)));
const labels = (role: StaffRole) => navFor(fake(role)).flatMap((g) => g.items.map((i) => i.label));

// The same screen counts once, whatever its filter.
const SHOP_BACK_OFFICE = ["/app/shop/orders", "/app/shop/sales", "/app/shop/products", "/app/shop/stock", "/app/shop/movements", "/app/shop/restring", "/app/shop/purchasing", "/app/shop/stock-take"];
const FINANCE = ["/app/finance/invoices", "/app/finance/clients", "/app/finance/expenses", "/app/finance/payroll", "/app/finance/gst", "/app/finance/ledger", "/app/finance/cash", "/app/finance/drawers"];
const OWNER_ONLY = ["/app/settings", "/app/settings/audit", "/app/settings/messages", "/app/settings/backups", "/app/settings/privacy", "/app/settings/dev"];
const DESK = ["/app/desk", "/app/members", "/app/members/new", "/app/desk/expiring", "/app/desk/visits", "/app/messages", "/kiosk"];
const BAR = ["/app/bar", "/app/bar/tabs", "/app/bar/ready", "/app/bar/day", "/app/bar/menu"];
const COURTS = ["/app/courts", "/app/courts/bookings", "/app/courts/social", "/app/courts/social/players"];

/** The page file behind a staff href (route groups in parentheses). */
function pageExists(href: string): boolean {
  const root = path.resolve(__dirname, "../../src/app");
  const rel = href === "/kiosk" ? "kiosk" : href.replace(/^\//, "");
  const candidates = ["(staff)", "(kiosk)", ""].map((g) => path.join(root, g, rel, "page.tsx"));
  return candidates.some((p) => fs.existsSync(p)) || fs.readdirSync(root).some((d) => d.startsWith("(") && fs.existsSync(path.join(root, d, rel, "page.tsx")));
}

describe("role panels — staff menus", () => {
  it.each(ROLES)("%s: every screen once, each one it can open, each one a real page", (role) => {
    const actor = fake(role);
    const list = hrefs(role);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
    expect(new Set(labels(role)).size).toBe(labels(role).length);
    for (const g of navFor(actor)) for (const i of g.items) {
      expect(i.any.some((c) => can(actor, c)), `${role} sees ${i.href} without access`).toBe(true);
      expect(pageExists(bare(i.href)), `${i.href} has no page`).toBe(true);
    }
    // The role's home is on its own menu.
    expect(list).toContain(ROLE_HOME[role]);
  });

  it("owner-only screens (settings, audit, message log, backups, data requests) are on the Owner's menu only", () => {
    for (const p of OWNER_ONLY.filter((x) => x !== "/app/settings/dev")) expect(hrefs("OWNER")).toContain(p);
    for (const role of ROLES.filter((r) => r !== "OWNER")) for (const p of OWNER_ONLY) expect(hrefs(role)).not.toContain(p);
  });

  it("the notification log is one entry (Messages to send), not two", () => {
    for (const role of ["OWNER", "MANAGER", "FRONT_DESK"] as const) {
      expect(hrefs(role).filter((h) => h === "/app/messages")).toHaveLength(1);
      expect(labels(role)).toContain("Messages to send");
      expect(labels(role)).not.toContain("Notification log");
    }
  });

  it("front desk: desk, members, renewals, bookings, social, leads, refunds and its drawer — no shop back office, no finance", () => {
    const d = hrefs("FRONT_DESK");
    for (const p of [...DESK, ...COURTS, "/app/crm", "/app/refunds", "/app/drawer", "/app/shop"]) expect(d).toContain(p);
    for (const p of [...SHOP_BACK_OFFICE, ...FINANCE, ...BAR, "/app", "/app/reports", "/app/pricing"]) expect(d).not.toContain(p);
  });

  it("shop: counter, orders, sales, products, stock and purchasing — no desk, courts, bar or finance", () => {
    const s = hrefs("SHOP_STAFF");
    for (const p of ["/app/shop", ...SHOP_BACK_OFFICE, "/app/refunds", "/app/drawer"]) expect(s).toContain(p);
    for (const p of [...DESK, ...COURTS, ...BAR, ...FINANCE, "/app/crm", "/app"]) expect(s).not.toContain(p);
  });

  it("bar: tables, tabs, ready queue, kitchen display and the bar day — nothing else but its own pages", () => {
    const b = hrefs("BAR_STAFF");
    for (const p of ["/app/bar", "/app/bar/tabs", "/app/bar/ready", "/app/bar/kds", "/app/bar/day"]) expect(b).toContain(p);
    for (const p of [...DESK, ...COURTS, "/app/shop", ...SHOP_BACK_OFFICE, ...FINANCE, "/app"]) expect(b).not.toContain(p);
  });

  it("kitchen: the kitchen display and its own shifts/account only", () => {
    expect(hrefs("KITCHEN").sort()).toEqual(["/app/account", "/app/bar/kds", "/app/staff/me"]);
  });

  it("accountant: finance (with its dashboard and reports) — no member desk, shop or bar", () => {
    const a = hrefs("ACCOUNTANT");
    for (const p of [...FINANCE, "/app", "/app/reports", "/app/refunds"]) expect(a).toContain(p);
    for (const p of [...DESK, ...COURTS, "/app/shop", ...SHOP_BACK_OFFICE, ...BAR, "/app/crm"]) expect(a).not.toContain(p);
  });

  it("owner and manager: the whole club, grouped; the manager without payroll, GST, ledger or admin", () => {
    const o = hrefs("OWNER");
    for (const p of [...DESK, ...COURTS, "/app/shop", ...SHOP_BACK_OFFICE, ...BAR, ...FINANCE, "/app/pricing", "/app/staff/leave", "/app/refunds"]) expect(o).toContain(p);
    const m = hrefs("MANAGER");
    for (const p of [...DESK, ...COURTS, "/app/shop", ...SHOP_BACK_OFFICE, ...BAR, "/app/pricing", "/app/staff/leave", "/app/refunds", "/app/finance/cash"]) expect(m).toContain(p);
    for (const p of ["/app/finance/payroll", "/app/finance/gst", "/app/finance/ledger"]) expect(m).not.toContain(p);
  });

  it("every role has a menu; members have none", () => {
    for (const role of ROLES) expect(ROLE_NAV[role].length).toBeGreaterThan(0);
    expect(navFor(fake("MEMBER"))).toEqual([]);
  });
});

describe("role panels — what is waiting for each role", () => {
  let w: World;
  beforeEach(async () => {
    w = await makeWorld();
  });

  it("each role's to-do items are only ones it can act on, on its own home", async () => {
    expect(TODO_HOME).toEqual({ OWNER: "dashboard", MANAGER: "dashboard", SHOP_STAFF: "shop", BAR_STAFF: "bar", ACCOUNTANT: "finance" });
    const keys = async (role: StaffRole) => (await myTodo(w.actors[role])).items.map((i) => i.key);
    expect(await keys("OWNER")).toEqual(todoKeys("dashboard"));
    expect(await keys("MANAGER")).toEqual(["refundsToApprove", "leaveToApprove", "priceRulesToApprove", "missingClockOuts"]);
    expect(await keys("SHOP_STAFF")).toEqual(todoKeys("shop"));
    expect(await keys("BAR_STAFF")).toEqual(["readyToServe", "refundsToPayOut"]);
    expect(await keys("ACCOUNTANT")).toEqual(["drawersToBank", "supplierBills", "overdueInvoices", "payrollToPay"]);
    // The desk's to-dos are its Today strip; the kitchen's is the kitchen display.
    expect(await keys("FRONT_DESK")).toEqual([]);
    expect(await keys("KITCHEN")).toEqual([]);
    // A fresh club: every count is a real zero.
    for (const role of ROLES) for (const i of (await myTodo(w.actors[role])).items) expect(i.count).toBe(0);
  });

  it("a leave request waits for the Owner and Manager, never for the person who asked", async () => {
    await requestLeave(w.actors.MANAGER, { type: "CASUAL", startDate: "2026-10-20", endDate: "2026-10-21", reason: "family function" });
    await requestLeave(w.actors.FRONT_DESK, { type: "CASUAL", startDate: "2026-10-22", endDate: "2026-10-22", reason: "exam" });
    const leave = async (role: StaffRole) => (await myTodo(w.actors[role])).items.find((i) => i.key === "leaveToApprove")?.count;
    expect(await leave("OWNER")).toBe(2);
    expect(await leave("MANAGER")).toBe(1); // not their own
  });

  it("the desk's Today strip carries its messages to send and overdue follow-ups", async () => {
    const t = await deskToday(w.actors.FRONT_DESK);
    expect(t.messagesToSend).toBe(0);
    expect(t.overdueFollowUps).toBe(0);
  });
});
