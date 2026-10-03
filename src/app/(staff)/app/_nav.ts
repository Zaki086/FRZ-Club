import type { Role } from "@prisma/client";
import { can, type Capability } from "@/server/rbac/permissions";
import type { Actor } from "@/server/rbac/actor";

export type NavItem = { href: string; label: string; icon: string; any: Capability[] };
export type NavGroup = { label: string; items: NavItem[] };
export type StaffRole = Exclude<Role, "MEMBER">;

/**
 * Every staff screen, once. `any` is the screen's own gate (the page and its services still enforce it): an entry is
 * never shown to someone who would get a 403.
 */
export const NAV_ITEMS = {
  dashboard: { href: "/app", label: "Dashboard", icon: "LayoutDashboard", any: ["dashboard.full", "dashboard.ops", "dashboard.finance", "dashboard.desk", "dashboard.shop", "dashboard.bar"] },
  reports: { href: "/app/reports", label: "Reports & sharing", icon: "BarChart3", any: ["dashboard.full", "dashboard.finance", "dashboard.ops"] },
  drawer: { href: "/app/drawer", label: "My cash drawer", icon: "Vault", any: ["checkin", "shop.counter", "bar.operate", "invoices"] },
  refunds: { href: "/app/refunds", label: "Refunds", icon: "Undo2", any: ["refunds.request", "refunds.approve", "invoices"] },

  desk: { href: "/app/desk", label: "Check-in & search", icon: "ScanLine", any: ["checkin"] },
  members: { href: "/app/members", label: "Members", icon: "Users", any: ["members.view"] },
  newMember: { href: "/app/members/new", label: "New member", icon: "UserPlus", any: ["members.manage"] },
  renewals: { href: "/app/desk/expiring", label: "Renewals & dues", icon: "CalendarClock", any: ["members.view"] },
  // The notification log; the link opens it on the WhatsApp messages still to send by hand.
  messages: { href: "/app/messages?channel=WHATSAPP_MANUAL&status=QUEUED%2CLINK_OPENED", label: "Messages to send", icon: "MessageCircle", any: ["notifications.log"] },
  visits: { href: "/app/desk/visits", label: "Check-ins", icon: "LogIn", any: ["checkin"] },
  kiosk: { href: "/kiosk", label: "Check-in kiosk", icon: "TabletSmartphone", any: ["checkin"] },

  courts: { href: "/app/courts", label: "Command centre", icon: "Grid3x3", any: ["courts.view"] },
  bookings: { href: "/app/courts/bookings", label: "Bookings", icon: "CalendarCheck", any: ["courts.view"] },
  social: { href: "/app/courts/social", label: "Social play", icon: "PartyPopper", any: ["courts.view"] },
  socialPlayers: { href: "/app/courts/social/players", label: "Social players", icon: "UsersRound", any: ["courts.view"] },

  pos: { href: "/app/shop", label: "Counter POS", icon: "ShoppingCart", any: ["shop.counter"] },
  orders: { href: "/app/shop/orders", label: "Online orders", icon: "Package", any: ["shop.fulfil"] },
  restring: { href: "/app/shop/restring", label: "Restring queue", icon: "Wrench", any: ["shop.view"] },
  sales: { href: "/app/shop/sales", label: "Counter sales", icon: "Receipt", any: ["shop.view"] },
  // Products, stock levels and the shop's own prices and discounts (shop.pricing) on one screen; the gate is the page's (shop.view).
  products: { href: "/app/shop/products", label: "Products & pricing", icon: "Tags", any: ["shop.view"] },
  stock: { href: "/app/shop/stock", label: "Stock & receipts", icon: "Boxes", any: ["shop.view"] },
  movements: { href: "/app/shop/movements", label: "Stock movements", icon: "History", any: ["shop.view"] },
  purchasing: { href: "/app/shop/purchasing", label: "Purchase orders", icon: "ClipboardList", any: ["shop.view"] },
  stockTake: { href: "/app/shop/stock-take", label: "Stock take", icon: "ListChecks", any: ["shop.stock"] },

  barTables: { href: "/app/bar", label: "Tables & tabs", icon: "Beer", any: ["bar.operate"] },
  barReady: { href: "/app/bar/ready", label: "Ready to serve", icon: "BellRing", any: ["bar.operate"] },
  kds: { href: "/app/bar/kds", label: "Kitchen display", icon: "ChefHat", any: ["bar.kds"] },
  barTabs: { href: "/app/bar/tabs", label: "All bar tabs", icon: "Receipt", any: ["bar.operate", "bar.report"] },
  barDay: { href: "/app/bar/day", label: "Bar day & close", icon: "Moon", any: ["bar.report"] },
  barMenu: { href: "/app/bar/menu", label: "Menu & prices", icon: "UtensilsCrossed", any: ["bar.close_day"] },

  crm: { href: "/app/crm", label: "Leads board", icon: "Kanban", any: ["crm"] },

  cash: { href: "/app/finance/cash", label: "Cash reconciliation", icon: "Coins", any: ["cash.reconcile"] },
  drawers: { href: "/app/finance/drawers", label: "All cash drawers", icon: "Vault", any: ["cash.reconcile", "dashboard.ops"] },
  invoices: { href: "/app/finance/invoices", label: "Invoices", icon: "FileText", any: ["invoices"] },
  clients: { href: "/app/finance/clients", label: "Business clients", icon: "Building2", any: ["invoices"] },
  expenses: { href: "/app/finance/expenses", label: "Expenses", icon: "Receipt", any: ["expenses.view"] },
  payroll: { href: "/app/finance/payroll", label: "Payroll", icon: "Wallet", any: ["payroll"] },
  gst: { href: "/app/finance/gst", label: "GST report", icon: "Percent", any: ["gst"] },
  ledger: { href: "/app/finance/ledger", label: "Ledger", icon: "BookOpen", any: ["finance.reports"] },

  leave: { href: "/app/staff/leave", label: "Leave approvals", icon: "Plane", any: ["leave.approve"] },
  roster: { href: "/app/staff/roster", label: "Roster", icon: "CalendarDays", any: ["roster.manage"] },
  attendance: { href: "/app/staff/attendance", label: "Attendance", icon: "Timer", any: ["staff.directory"] },
  employees: { href: "/app/staff/employees", label: "Staff directory", icon: "Contact", any: ["staff.directory"] },
  activity: { href: "/app/staff/activity", label: "Staff activity", icon: "Activity", any: ["staff.activity"] },

  pricing: { href: "/app/pricing", label: "Price book", icon: "BadgeIndianRupee", any: ["pricing.manage"] },
  settings: { href: "/app/settings", label: "Settings", icon: "Settings", any: ["settings"] },
  audit: { href: "/app/settings/audit", label: "Audit log", icon: "History", any: ["audit"] },
  messageLog: { href: "/app/settings/messages", label: "Message log", icon: "MessagesSquare", any: ["messages.log"] },
  backups: { href: "/app/settings/backups", label: "Backups", icon: "DatabaseBackup", any: ["settings"] },
  privacy: { href: "/app/settings/privacy", label: "Data requests", icon: "ShieldCheck", any: ["privacy.manage"] },
  dev: { href: "/app/settings/dev", label: "Dev tools", icon: "FlaskConical", any: ["dev_tools"] },

  staffMe: { href: "/app/staff/me", label: "My shifts & leave", icon: "Clock", any: ["staff.self"] },
  account: { href: "/app/account", label: "My account", icon: "UserCog", any: ["staff.self"] },
} satisfies Record<string, NavItem>;

const I = NAV_ITEMS;
const ME: NavGroup = { label: "Me", items: [I.staffMe, I.account] };

/** The Owner and Manager run the whole club; the capability filter drops what a Manager can't open (payroll, GST, ledger, admin). */
const CLUB: NavGroup[] = [
  { label: "Overview", items: [I.dashboard, I.reports, I.drawer] },
  { label: "Front desk", items: [I.desk, I.members, I.newMember, I.renewals, I.visits, I.messages, I.kiosk] },
  { label: "Courts", items: [I.courts, I.bookings, I.social, I.socialPlayers] },
  { label: "Shop", items: [I.pos, I.orders, I.restring, I.sales, I.products, I.stock, I.movements, I.purchasing, I.stockTake] },
  { label: "Bar & cafeteria", items: [I.barTables, I.barReady, I.kds, I.barTabs, I.barDay, I.barMenu] },
  { label: "CRM", items: [I.crm] },
  { label: "Finance", items: [I.refunds, I.cash, I.drawers, I.invoices, I.clients, I.expenses, I.payroll, I.gst, I.ledger] },
  { label: "Staff", items: [I.leave, I.roster, I.attendance, I.employees, I.activity] },
  { label: "Admin", items: [I.pricing, I.settings, I.audit, I.messageLog, I.backups, I.privacy, I.dev] },
  ME,
];

/**
 * Each role's menu: only the screens of its own daily work, each once, in the section where that role works. A role
 * may still open other screens it is allowed to see by URL (same RBAC); they are just not on its menu.
 */
export const ROLE_NAV: Record<StaffRole, NavGroup[]> = {
  OWNER: CLUB,
  MANAGER: CLUB,
  FRONT_DESK: [
    { label: "Front desk", items: [I.desk, I.members, I.newMember, I.renewals, I.visits, I.messages, I.refunds, I.drawer, I.pos, I.kiosk] },
    { label: "Courts", items: [I.courts, I.bookings, I.social, I.socialPlayers] },
    { label: "CRM", items: [I.crm] },
    ME,
  ],
  SHOP_STAFF: [
    { label: "Shop", items: [I.pos, I.orders, I.restring, I.sales, I.products, I.stock, I.movements, I.purchasing, I.stockTake, I.refunds, I.drawer] },
    ME,
  ],
  BAR_STAFF: [
    { label: "Bar & cafeteria", items: [I.barTables, I.barReady, I.kds, I.barTabs, I.barDay, I.refunds, I.drawer] },
    ME,
  ],
  KITCHEN: [{ label: "Kitchen", items: [I.kds] }, ME],
  ACCOUNTANT: [
    { label: "Finance", items: [I.cash, I.drawers, I.invoices, I.clients, I.expenses, I.payroll, I.gst, I.ledger, I.refunds, I.drawer] },
    { label: "Reports", items: [I.dashboard, I.reports] },
    { label: "Staff", items: [I.attendance, I.employees] },
    ME,
  ],
};

/** The menu for this person: their role's screens they can actually open. */
export function navFor(actor: Actor, opts: { devTools?: boolean } = {}): NavGroup[] {
  if (actor.kind !== "USER" || actor.role === "MEMBER") return [];
  return ROLE_NAV[actor.role]
    .map((g) => ({
      label: g.label,
      items: g.items.filter((i) => i.any.some((c) => can(actor, c))).filter((i) => i.href !== I.dev.href || opts.devTools !== false),
    }))
    .filter((g) => g.items.length);
}
