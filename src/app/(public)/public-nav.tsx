"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, ShoppingBag, X } from "lucide-react";
import { cn } from "@/components/ui/cn";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/facilities", label: "Facilities" },
  { href: "/plans", label: "Plans & prices" },
  { href: "/availability", label: "Availability" },
  { href: "/shop", label: "Shop" },
  { href: "/trial", label: "Book a trial" },
  { href: "/enquire", label: "Enquire" },
];

export function PublicNav({ account }: { account: { href: string; label: string } }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <header className="no-print sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <span className="rounded bg-primary px-1.5 py-0.5 text-sm text-white">CC</span>
          The Champions Club
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm hover:bg-muted",
                (l.href === "/" ? path === "/" : path.startsWith(l.href)) && "font-semibold text-primary",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/shop/cart" className="rounded-md p-2 hover:bg-muted" aria-label="Cart">
            <ShoppingBag className="h-5 w-5" />
          </Link>
          <Link href={account.href} className="hidden rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white sm:inline">
            {account.label}
          </Link>
          <button className="rounded-md p-2 md:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open ? (
        <nav className="flex flex-col border-t px-4 py-2 md:hidden">
          {[...LINKS, account].map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="py-2 text-sm">
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
