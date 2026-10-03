"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import * as Icons from "lucide-react";
import { Menu, X } from "lucide-react";
import { cn } from "@/components/ui/cn";

type Item = { href: string; label: string; icon: string };
type Group = { label: string; items: Item[] };

function Icon({ name }: { name: string }) {
  const C = (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name] ?? Icons.Circle;
  return <C className="h-4 w-4 shrink-0" />;
}

export function Sidebar({ groups }: { groups: Group[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) =>
    href === "/app" ? path === "/app" : path === href || (path.startsWith(href + "/") && !groups.some((g) => g.items.some((i) => i.href !== href && i.href.startsWith(href + "/") && path.startsWith(i.href))));
  const nav = (
    <nav className="flex flex-col gap-4 p-3">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.label}</p>
          <div className="flex flex-col gap-0.5">
            {g.items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 hover:bg-white/10",
                  active(i.href) && "bg-white/15 font-semibold text-white",
                )}
              >
                <Icon name={i.icon} /> {i.label}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
  return (
    <>
      <button
        className="fixed bottom-4 left-4 z-40 rounded-full bg-primary p-3 text-white shadow-lg lg:hidden no-print"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <aside className="no-print hidden w-60 shrink-0 overflow-y-auto bg-slate-900 lg:block">{nav}</aside>
      {open ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="w-72 overflow-y-auto bg-slate-900">
            <div className="flex justify-end p-2">
              <button onClick={() => setOpen(false)} className="p-2 text-white" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
          </div>
          <div className="flex-1 bg-black/40" onClick={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
