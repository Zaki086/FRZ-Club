import Link from "next/link";
import { currentActor } from "@/server/auth/current";
import { getSettings } from "@/server/services/settings";
import { PublicNav } from "./public-nav";

export const dynamic = "force-dynamic";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const actor = await currentActor();
  const club = (await getSettings()).club;
  const clubName = club.name || "Club";
  const account =
    actor.kind === "USER"
      ? { href: actor.role === "MEMBER" ? "/portal" : "/app", label: actor.role === "MEMBER" ? "My account" : "Staff app" }
      : { href: "/login", label: "Member login" };
  return (
    <div className="flex min-h-screen flex-col">
      <PublicNav account={account} clubName={clubName} />
      <main className="flex-1">{children}</main>
      <footer className="no-print border-t bg-slate-900 text-slate-300">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-sm sm:grid-cols-3">
          <div>
            <p className="font-semibold text-white">{clubName}</p>
            {club.address ? <p>{club.address}</p> : null}
            {club.phone ? <p>{club.phone}</p> : null}
            {club.email ? <p>{club.email}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <Link href="/plans" className="hover:text-white">Plans &amp; prices</Link>
            <Link href="/availability" className="hover:text-white">This week&apos;s availability</Link>
            <Link href="/shop" className="hover:text-white">Shop</Link>
          </div>
          <div className="flex flex-col gap-1">
            <Link href="/trial" className="hover:text-white">Book a trial</Link>
            <Link href="/enquire" className="hover:text-white">Enquire</Link>
            <Link href="/login" className="hover:text-white">Log in</Link>
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
