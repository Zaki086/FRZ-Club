"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";

const LINKS = [
  { href: "/portal", label: "Home" },
  { href: "/portal/book", label: "Book a court" },
  { href: "/portal/social", label: "Social play" },
  { href: "/portal/bookings", label: "My bookings" },
  { href: "/portal/orders", label: "Shop orders" },
  { href: "/portal/tab", label: "Bar tab" },
  { href: "/portal/invoices", label: "Invoices" },
  { href: "/portal/membership", label: "Membership" },
  { href: "/portal/family", label: "Family" },
  { href: "/portal/account", label: "My account" },
];

export function PortalNav() {
  const path = usePathname();
  return (
    <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={cn(
            "whitespace-nowrap rounded-t-xl px-3.5 py-2.5 text-sm font-semibold text-ink-foreground/75 hover:text-ink-foreground",
            (l.href === "/portal" ? path === "/portal" : path.startsWith(l.href)) && "bg-background !text-foreground",
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
