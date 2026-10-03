import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { isSetupComplete } from "@/server/services/setup";
import { getSettings } from "@/server/services/settings";
import { clubInitials } from "@/lib/codes";
import { can } from "@/server/rbac/permissions";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton } from "@/components/logout-button";
import { Badge } from "@/components/ui/badge";
import { STAFF_NAV } from "./_nav";
import { Sidebar } from "./_components/sidebar";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser(STAFF_ROLES, "/app");
  // First run (completion pass §4): nothing works until the Owner has set the club up.
  if (!(await isSetupComplete())) {
    if (actor.role === "OWNER") redirect("/setup");
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-xl font-bold">The club is being set up</h1>
        <p className="text-sm text-muted-foreground">The Owner is finishing the first-run setup. Please try again once they are done.</p>
        <LogoutButton />
      </div>
    );
  }
  const clubName = (await getSettings()).club.name || "Club";
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
          <span className="rounded bg-primary px-1.5 py-0.5 text-sm text-white">{clubInitials(clubName)}</span>
          <span className="hidden sm:inline">{clubName} · Staff</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link href="/app/account" className="hidden text-sm hover:underline sm:inline">{actor.name}</Link>
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
