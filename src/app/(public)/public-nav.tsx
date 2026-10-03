"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, ShoppingBag, X } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Logo } from "@/components/logo";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/facilities", label: "Facilities" },
  { href: "/plans", label: "Plans & prices" },
  { href: "/availability", label: "Availability" },
  { href: "/shop", label: "Shop" },
  { href: "/trial", label: "Book a trial" },
  { href: "/enquire", label: "Enquire" },
];

export function PublicNav({ account, clubName }: { account: { href: string; label: string }; clubName: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="no-print sticky top-0 z-30 bg-ink/95 text-ink-foreground shadow-lift backdrop-blur">
      <div className="container-x flex h-16 items-center justify-between gap-4">
        <Link href="/" className="min-w-0" aria-label={`${clubName} home`}>
          <Logo name={clubName} light />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-full px-3 py-2 text-sm font-medium text-ink-foreground/80 hover:text-ink-foreground",
                (l.href === "/" ? path === "/" : path.startsWith(l.href)) && "font-bold !text-accent",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/shop/cart" className="grid h-10 w-10 place-items-center rounded-full hover:bg-ink-foreground/10" aria-label="Cart">
            <ShoppingBag className="h-5 w-5" />
          </Link>
          <Link href={account.href} className="hidden h-10 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-foreground hover:brightness-95 sm:inline-flex">
            {account.label}
          </Link>
          <button className="grid h-10 w-10 place-items-center rounded-full hover:bg-ink-foreground/10 md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open ? (
        <nav className="flex flex-col border-t border-ink-foreground/15 px-4 py-2 md:hidden">
          {[...LINKS, account].map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="py-2.5 text-sm font-medium">
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
