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
];

export function PortalNav() {
  const path = usePathname();
  return (
    <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 pb-2">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={cn(
            "whitespace-nowrap rounded-full px-3 py-1 text-sm hover:bg-muted",
            (l.href === "/portal" ? path === "/portal" : path.startsWith(l.href)) && "bg-primary text-white hover:bg-primary",
          )}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
