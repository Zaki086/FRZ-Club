import Link from "next/link";
import { SessionGuard } from "@/components/session-guard";
import { requireUser } from "@/server/auth/current";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton } from "@/components/logout-button";
import { LogoMark } from "@/components/logo";
import { getSettings } from "@/server/services/settings";
import { PortalNav } from "./portal-nav";

export const dynamic = "force-dynamic";

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser(["MEMBER"], "/portal");
  const clubName = (await getSettings()).club.name || "Club";
  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print sticky top-0 z-30 bg-ink text-ink-foreground">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-2 px-4">
          <Link href="/portal" className="flex min-w-0 items-center gap-2.5" aria-label={`${clubName} member portal`}>
            <LogoMark name={clubName} />
            <span className="hidden min-w-0 truncate font-display text-xl font-bold uppercase sm:inline">{clubName}</span>
          </Link>
          <div className="flex items-center gap-1">
            <span className="hidden text-sm font-semibold sm:inline">{actor.name}</span>
            <NotificationBell href="/portal/notifications" />
            <LogoutButton />
          </div>
        </div>
        <PortalNav />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <SessionGuard />
    </div>
  );
}
