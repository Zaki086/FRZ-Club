"use client";
import Link from "next/link";
import { fmtDateTime } from "@/lib/time";
import { api, useApi } from "./api";
import { DataState } from "./states";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { cn } from "./ui/cn";

type N = { id: string; type: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };

export function NotificationsList() {
  const state = useApi<{ items: N[]; unread: number }>("/api/notifications?limit=100", { pollMs: 15000 });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await api("/api/notifications", { body: { ids: "all" } });
            await state.reload();
          }}
        >
          Mark all read
        </Button>
      </div>
      <DataState
        state={state}
        isEmpty={(d) => d.items.length === 0}
        empty={{ title: "No notifications yet" }}
      >
        {(d) => (
          <Card className="divide-y">
            {d.items.map((n) => (
              <div key={n.id} className={cn("flex flex-col gap-0.5 p-3", !n.readAt && "bg-accent/50")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{n.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{fmtDateTime(n.createdAt)}</span>
                </div>
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{n.body}</p>
                {n.link ? (
                  <Link className="text-sm text-primary underline" href={n.link}>
                    Open
                  </Link>
                ) : null}
              </div>
            ))}
          </Card>
        )}
      </DataState>
    </div>
  );
}
