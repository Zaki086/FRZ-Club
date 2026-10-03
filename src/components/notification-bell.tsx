"use client";
import Link from "next/link";
import { Bell } from "lucide-react";
import { useApi } from "./api";

export function NotificationBell({ href }: { href: string }) {
  const { data } = useApi<{ unread: number }>("/api/notifications?unread=1&limit=1", { pollMs: 15000 });
  const n = data?.unread ?? 0;
  return (
    <Link href={href} className="relative rounded-md p-2 hover:bg-muted" aria-label={`Notifications (${n} unread)`}>
      <Bell className="h-5 w-5" />
      {n > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-destructive px-1 text-center text-[11px] font-bold text-white">
          {n > 99 ? "99+" : n}
        </span>
      ) : null}
    </Link>
  );
}
