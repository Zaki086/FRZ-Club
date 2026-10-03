import Link from "next/link";
import { SessionGuard } from "@/components/session-guard";
import { redirect } from "next/navigation";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { isSetupComplete } from "@/server/services/setup";
import { getSettings } from "@/server/services/settings";
import { ROLE_HOME } from "@/server/auth/sessions";
import { NotificationBell } from "@/components/notification-bell";
import { DrawerBadge } from "@/components/drawer-badge";
import { LogoutButton } from "@/components/logout-button";
import { LogoMark } from "@/components/logo";
import { navFor } from "./_nav";
import { Sidebar } from "./_components/sidebar";

export const dynamic = "force-dynamic";

/**
 * v4 CD-1: whoever has a cash drawer open sees its live balance in the header (the badge shows nothing while they have
 * none open): front desk, shop, bar and accountant every day, and an Owner or Manager who took cash at a counter.
 */
const DRAWER_ROLES = ["FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "MANAGER", "OWNER"];

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
  // Each role's own menu (v4 §1.1 for the Owner, Manager and Front desk); the server still checks every page (RN-1)
  // and every action.
  const groups = navFor(actor, { devTools: process.env.NODE_ENV !== "production" }).map((g) => ({
    label: g.label,
    items: g.items.map(({ href, label, icon }) => ({ href, label, icon })),
  }));
  return (
    <div className="flex h-screen flex-col">
      <header className="no-print flex h-16 shrink-0 items-center justify-between gap-2 bg-ink px-4 text-ink-foreground">
        <Link href={ROLE_HOME[actor.role]} className="flex min-w-0 items-center gap-2.5" aria-label={`${clubName} · Staff`}>
          <LogoMark name={clubName} />
          <span className="hidden min-w-0 truncate font-display text-xl font-bold uppercase sm:inline">
            {clubName} <span className="font-sans text-[0.65rem] tracking-[0.25em] text-ink-foreground/70">· Staff</span>
          </span>
        </Link>
        <div className="flex items-center gap-2">
          {DRAWER_ROLES.includes(actor.role) ? (
            <span className="rounded-full bg-card">
              <DrawerBadge />
            </span>
          ) : null}
          <Link href="/app/account" className="hidden text-sm font-semibold hover:underline sm:inline">{actor.name}</Link>
          <span className="hidden rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold text-accent-foreground sm:inline">{actor.role.replace("_", " ")}</span>
          <NotificationBell href="/app/notifications" />
          <LogoutButton />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar groups={groups} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
        <SessionGuard />
      </div>
    </div>
  );
}
