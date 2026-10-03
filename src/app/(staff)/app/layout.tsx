import Link from "next/link";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton } from "@/components/logout-button";
import { Badge } from "@/components/ui/badge";
import { STAFF_NAV } from "./_nav";
import { Sidebar } from "./_components/sidebar";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser(STAFF_ROLES, "/app");
  const groups = STAFF_NAV.map((g) => ({
    label: g.label,
    items: g.items
      .filter((i) => i.any.some((c) => can(actor, c)))
      .filter((i) => i.href !== "/app/settings/dev" || process.env.NODE_ENV !== "production")
      .map(({ href, label, icon }) => ({ href, label, icon })),
  })).filter((g) => g.items.length);
  return (
    <div className="flex h-screen flex-col">
      <header className="no-print flex h-14 shrink-0 items-center justify-between border-b bg-card px-4">
        <Link href="/app" className="flex items-center gap-2 font-bold">
          <span className="rounded bg-primary px-1.5 py-0.5 text-sm text-white">CC</span>
          <span className="hidden sm:inline">Champions Club · Staff</span>
        </Link>
        <div className="flex items-center gap-2">
          <span className="hidden text-sm sm:inline">{actor.name}</span>
          <Badge tone="dark">{actor.role.replace("_", " ")}</Badge>
          <NotificationBell href="/app/notifications" />
          <LogoutButton />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar groups={groups} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
