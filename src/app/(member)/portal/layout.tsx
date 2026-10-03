import Link from "next/link";
import { requireUser } from "@/server/auth/current";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton } from "@/components/logout-button";
import { PortalNav } from "./portal-nav";

export const dynamic = "force-dynamic";

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireUser(["MEMBER"], "/portal");
  return (
    <div className="flex min-h-screen flex-col">
      <header className="no-print sticky top-0 z-30 border-b bg-card">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4">
          <Link href="/portal" className="flex items-center gap-2 font-bold">
            <span className="rounded bg-primary px-1.5 py-0.5 text-sm text-white">CC</span>
            <span className="hidden sm:inline">My Club</span>
          </Link>
          <div className="flex items-center gap-1">
            <span className="hidden text-sm sm:inline">{actor.name}</span>
            <NotificationBell href="/portal/notifications" />
            <LogoutButton />
          </div>
        </div>
        <PortalNav />
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">{children}</main>
    </div>
  );
}
