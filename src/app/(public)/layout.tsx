import Link from "next/link";
import { currentActor } from "@/server/auth/current";
import { getSettings } from "@/server/services/settings";
import { PublicNav } from "./public-nav";
import { formatPhone } from "@/lib/validation/contact";

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
      <footer className="no-print bg-ink text-ink-foreground/80">
        <div className="container-x grid gap-8 py-12 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <p className="font-display text-2xl font-bold uppercase text-ink-foreground">{clubName}</p>
            {club.address ? <p>{club.address}</p> : null}
            {club.phone ? <p>{formatPhone(club.phone)}</p> : null}
            {club.email ? <p>{club.email}</p> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="eyebrow mb-1 text-accent">Play</p>
            <Link href="/plans" className="hover:text-ink-foreground">Plans &amp; prices</Link>
            <Link href="/availability" className="hover:text-ink-foreground">This week&apos;s availability</Link>
            <Link href="/shop" className="hover:text-ink-foreground">Shop</Link>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="eyebrow mb-1 text-accent">Join</p>
            <Link href="/trial" className="hover:text-ink-foreground">Book a trial</Link>
            <Link href="/enquire" className="hover:text-ink-foreground">Enquire</Link>
            <Link href="/login" className="hover:text-ink-foreground">Log in</Link>
            <Link href="/privacy" className="hover:text-ink-foreground">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
