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

  // v4 §1.2: arrivals today and in the next 2 hours that will hit a problem at check-in, each with its one-click fix.
  checkinRisk: { href: "/app/desk/risk", label: "Check-in risk", icon: "ShieldAlert", any: ["checkin"] },

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
  // v5 §1.1: the menu builder (categories, items, photos, base prices, print, table QR cards).
  barMenu: { href: "/app/bar/menu", label: "Menu", icon: "UtensilsCrossed", any: ["menu.manage"] },

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
  // v4 §1.2: the Owner's HR and login administration (create staff, role, salary, join date, deactivate, reset link, force logout).
  people: { href: "/app/employees", label: "Employees", icon: "IdCard", any: ["users.manage"] },

  pricing: { href: "/app/pricing", label: "Price book", icon: "BadgeIndianRupee", any: ["pricing.manage"] },
  settings: { href: "/app/settings", label: "Settings", icon: "Settings", any: ["settings"] },
  audit: { href: "/app/settings/audit", label: "Audit log", icon: "History", any: ["audit"] },
  messageLog: { href: "/app/settings/messages", label: "Message log", icon: "MessagesSquare", any: ["messages.log"] },
  // The notification log itself (every member notification, per channel), unfiltered.
  notificationLog: { href: "/app/messages", label: "Notification log", icon: "BellRing", any: ["notifications.log"] },
  backups: { href: "/app/settings/backups", label: "Backups", icon: "DatabaseBackup", any: ["settings"] },
  privacy: { href: "/app/settings/privacy", label: "Data requests", icon: "ShieldCheck", any: ["privacy.manage"] },
  dev: { href: "/app/settings/dev", label: "Dev tools", icon: "FlaskConical", any: ["dev_tools"] },

  staffMe: { href: "/app/staff/me", label: "My shifts & leave", icon: "Clock", any: ["staff.self"] },
  account: { href: "/app/account", label: "My account", icon: "UserCog", any: ["staff.self"] },
  // The full page of the header bell (the person's own staff notifications).
  inbox: { href: "/app/notifications", label: "Notifications", icon: "Bell", any: ["notifications.staff"] },
} satisfies Record<string, NavItem>;

const I = NAV_ITEMS;
const ME: NavGroup = { label: "Me", items: [I.staffMe, I.account] };
/** v4 §1.1 labels are the spec's, word for word (the shared entries keep their own labels on the other roles' menus). */
const as = (item: NavItem, label: string): NavItem => ({ ...item, label });

/**
 * v4 §1.1: the Owner, Manager and Front desk menus are exactly these items, in this order, with these labels — one
 * flat list without group headings (the owner asked for nothing else on these three menus). RN-1: for the Manager and Front desk these are also the pages they may
 * open (plus the detail pages in `server/rbac/page-access.ts`); RN-2: the Owner may still open any page by URL.
 */
const OWNER_NAV: NavGroup[] = [
  {
    label: "",
    items: [
      as(I.dashboard, "Dashboard"), as(I.people, "Employees"), as(I.courts, "Command Centre"), as(I.invoices, "Invoices"),
      as(I.clients, "Business Clients"), as(I.expenses, "Expenses"), as(I.payroll, "Payroll"), as(I.gst, "GST Reports"),
      as(I.ledger, "Ledgers"), as(I.cash, "Cash Reconciliation"), as(I.drawers, "Cash Drawers"), as(I.account, "My Account"),
      as(I.employees, "Staff Directory"), as(I.attendance, "Attendance"), as(I.pricing, "Price Book"), as(I.reports, "Reports & Sharing"),
      as(I.settings, "Settings"), as(I.audit, "Audit Log"), as(I.messageLog, "Message Log"), as(I.notificationLog, "Notification Log"),
      as(I.backups, "Backups"), as(I.privacy, "Data Requests"),
    ],
  },
];

const MANAGER_NAV: NavGroup[] = [
  {
    label: "",
    items: [
      as(I.dashboard, "Dashboard"), as(I.members, "Members"), as(I.courts, "Command Centre"), as(I.bookings, "Bookings"),
      as(I.social, "Social Play"), as(I.socialPlayers, "Social Players"), as(I.purchasing, "Purchase Orders"), as(I.stock, "Stock & Receipts"),
      as(I.sales, "Counter Sales"), as(I.barDay, "Bar Day & Close"), as(I.crm, "Leads Board"), as(I.invoices, "Invoices"),
      as(I.clients, "Business Clients"), as(I.expenses, "Expenses"), as(I.cash, "Cash Reconciliation"), as(I.account, "My Account"),
      as(I.employees, "Staff Directory"), as(I.attendance, "Attendance"), as(I.roster, "Rosters"), as(I.leave, "Leave Approvals"),
      as(I.activity, "Staff Activity"),
    ],
  },
];

const FRONT_DESK_NAV: NavGroup[] = [
  {
    label: "",
    items: [
      as(I.dashboard, "Dashboard"), as(I.drawer, "My Cash Drawer"), as(I.refunds, "Refunds"), as(I.desk, "Check-in & Search Members"),
      as(I.newMember, "New Members"), as(I.renewals, "Renewal & Dues"), as(I.messages, "Messages to Send"), as(I.checkinRisk, "Check-in Risk"),
      as(I.courts, "Command Centre"), as(I.bookings, "Bookings"), as(I.social, "Social Play"), as(I.socialPlayers, "Social Players"),
      as(I.crm, "Leads Board"), as(I.staffMe, "My Shifts & Leave"), as(I.account, "My Account"), as(I.inbox, "Notifications"),
    ],
  },
];

/**
 * Each role's menu: only the screens of its own daily work, each once. Shop, bar, kitchen and accountant menus are
 * unchanged from v3 (they may still open other screens their capabilities allow by URL).
 */
export const ROLE_NAV: Record<StaffRole, NavGroup[]> = {
  OWNER: OWNER_NAV,
  MANAGER: MANAGER_NAV,
  FRONT_DESK: FRONT_DESK_NAV,
  SHOP_STAFF: [
    // v6 SM-1: "Café menu" — the v5 menu builder (the bar staff's "Menu"), under its café name.
    { label: "Shop", items: [I.pos, I.orders, I.restring, I.sales, I.products, I.stock, I.movements, I.purchasing, I.stockTake, as(I.barMenu, "Café menu"), I.refunds, I.drawer] },
    ME,
  ],
  BAR_STAFF: [
    { label: "Bar & cafeteria", items: [I.barTables, I.barReady, I.kds, I.barTabs, I.barDay, I.barMenu, I.refunds, I.drawer] },
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

/** The bare paths (no query) of a role's menu, in order. */
export function navPaths(role: StaffRole): string[] {
  return ROLE_NAV[role].flatMap((g) => g.items.map((i) => i.href.split("?")[0]));
}

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
