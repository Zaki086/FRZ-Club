import type { Metadata } from "next";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { can, type Capability } from "@/server/rbac/permissions";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { DashboardView } from "./_dashboard/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

const LINKS: Array<{ href: string; label: string; cap: Capability }> = [
  { href: "/app/desk", label: "Front desk", cap: "checkin" },
  { href: "/app/courts", label: "Court command centre", cap: "courts.view" },
  { href: "/app/shop", label: "Counter POS", cap: "shop.counter" },
  { href: "/app/shop/orders", label: "Online orders", cap: "shop.fulfil" },
  { href: "/app/bar", label: "Bar tables", cap: "bar.operate" },
  { href: "/app/bar/kds", label: "Kitchen display", cap: "bar.kds" },
  { href: "/app/crm", label: "Leads", cap: "crm" },
  { href: "/app/finance/invoices", label: "Invoices", cap: "invoices" },
  { href: "/app/finance/payroll", label: "Payroll", cap: "payroll" },
  { href: "/app/reports", label: "Reports & sharing", cap: "dashboard.finance" },
  { href: "/app/staff/me", label: "My shifts", cap: "staff.self" },
];

export default async function DashboardPage() {
  const actor = await requireUser(STAFF_ROLES, "/app");
  const quickLinks = LINKS.filter((l) => can(actor, l.cap)).map(({ href, label }) => ({ href, label }));
  return <DashboardView quickLinks={quickLinks} today={istDate(clock.now())} />;
}
