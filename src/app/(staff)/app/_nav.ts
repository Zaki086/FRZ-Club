import type { Capability } from "@/server/rbac/permissions";

export type NavItem = { href: string; label: string; icon: string; any: Capability[] };
export type NavGroup = { label: string; items: NavItem[] };

/** Staff navigation. Items are shown only to roles holding one of the capabilities (the server still enforces). */
export const STAFF_NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/app", label: "Dashboard", icon: "LayoutDashboard", any: ["notifications.staff"] }],
  },
  {
    label: "Front desk",
    items: [
      { href: "/app/desk", label: "Check-in & search", icon: "ScanLine", any: ["checkin"] },
      { href: "/app/members", label: "Members", icon: "Users", any: ["members.view"] },
      { href: "/app/members/new", label: "New member", icon: "UserPlus", any: ["members.manage"] },
      { href: "/app/desk/expiring", label: "Expiring & dues", icon: "CalendarClock", any: ["members.view"] },
    ],
  },
  {
    label: "Courts",
    items: [
      { href: "/app/courts", label: "Command centre", icon: "Grid3x3", any: ["courts.view"] },
      { href: "/app/courts/bookings", label: "Bookings", icon: "CalendarCheck", any: ["courts.view"] },
      { href: "/app/courts/social", label: "Social play", icon: "PartyPopper", any: ["courts.view"] },
    ],
  },
  {
    label: "Shop",
    items: [
      { href: "/app/shop", label: "Counter POS", icon: "ShoppingCart", any: ["shop.counter"] },
      { href: "/app/shop/orders", label: "Online orders", icon: "Package", any: ["shop.fulfil"] },
      { href: "/app/shop/stock", label: "Stock & receipts", icon: "Boxes", any: ["shop.view"] },
      { href: "/app/shop/restring", label: "Restring queue", icon: "Wrench", any: ["shop.view"] },
    ],
  },
  {
    label: "Bar & cafeteria",
    items: [
      { href: "/app/bar", label: "Tables & tabs", icon: "Beer", any: ["bar.operate"] },
      { href: "/app/bar/kds", label: "Kitchen display", icon: "ChefHat", any: ["bar.kds"] },
      { href: "/app/bar/ready", label: "Ready to serve", icon: "BellRing", any: ["bar.operate"] },
      { href: "/app/bar/day", label: "Bar day & close", icon: "Moon", any: ["bar.report"] },
    ],
  },
  {
    label: "CRM",
    items: [{ href: "/app/crm", label: "Leads board", icon: "Kanban", any: ["crm"] }],
  },
  {
    label: "Finance",
    items: [
      { href: "/app/finance/invoices", label: "Invoices", icon: "FileText", any: ["invoices"] },
      { href: "/app/finance/clients", label: "Business clients", icon: "Building2", any: ["invoices"] },
      { href: "/app/finance/expenses", label: "Expenses", icon: "Receipt", any: ["expenses.view"] },
      { href: "/app/finance/payroll", label: "Payroll", icon: "Wallet", any: ["payroll"] },
      { href: "/app/finance/gst", label: "GST report", icon: "Percent", any: ["gst"] },
      { href: "/app/finance/ledger", label: "Ledger", icon: "BookOpen", any: ["finance.reports"] },
    ],
  },
  {
    label: "Staff",
    items: [
      { href: "/app/staff/me", label: "My shifts & leave", icon: "Clock", any: ["staff.self"] },
      { href: "/app/staff/roster", label: "Roster", icon: "CalendarDays", any: ["roster.manage"] },
      { href: "/app/staff/leave", label: "Leave approvals", icon: "Plane", any: ["leave.approve"] },
    ],
  },
  {
    label: "Owner",
    items: [
      { href: "/app/reports", label: "Reports & sharing", icon: "BarChart3", any: ["dashboard.full", "dashboard.finance", "dashboard.ops"] },
      { href: "/app/settings", label: "Settings", icon: "Settings", any: ["settings"] },
      { href: "/app/settings/audit", label: "Audit log", icon: "History", any: ["audit"] },
      { href: "/app/settings/dev", label: "Dev tools", icon: "FlaskConical", any: ["dev_tools"] },
    ],
  },
];
