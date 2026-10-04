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
  // Links may carry a filter (`/app/messages?channel=…`): match on the path only.
  const bare = (href: string) => href.split("?")[0];
  const active = (link: string) => {
    const href = bare(link);
    return href === "/app" ? path === "/app" : path === href || (path.startsWith(href + "/") && !groups.some((g) => g.items.some((i) => bare(i.href) !== href && bare(i.href).startsWith(href + "/") && path.startsWith(bare(i.href)))));
  };
  const nav = (
    <nav className="flex flex-col gap-4 p-3">
      {groups.map((g) => (
        <div key={g.label || "menu"}>
          {g.label ? <p className="eyebrow px-2 pb-1 text-[10px] text-sidebar-foreground/60">{g.label}</p> : null}
          <div className="flex flex-col gap-0.5">
            {g.items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent",
                  active(i.href) && "bg-sidebar-primary font-bold text-sidebar-primary-foreground hover:bg-sidebar-primary",
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
        className="fixed bottom-4 left-4 z-40 rounded-full bg-accent p-3 text-accent-foreground shadow-lift lg:hidden no-print"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <aside className="no-print hidden w-64 shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar lg:block">{nav}</aside>
      {open ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="w-72 overflow-y-auto bg-sidebar">
            <div className="flex justify-end p-2">
              <button onClick={() => setOpen(false)} className="p-2 text-sidebar-foreground" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
          </div>
          <div className="flex-1 bg-ink/50" onClick={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  );
}
