"use client";
// Role panels: "Waiting for you" at the top of a role's home page. Every number comes from /api/me/todo
// (services/todo.ts) and clicks through to the list that holds those records.
import Link from "next/link";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Money } from "@/components/money";

type Todo = { home: string | null; items: Array<{ key: string; label: string; count: number; amount?: number; href: string; hint?: string }> };

export function TodoPanel() {
  const state = useApi<Todo>("/api/me/todo", { pollMs: 60_000 });
  return (
    <DataState state={state}>
      {(t) =>
        t.items.length ? (
          <section className="mb-4 flex flex-col gap-2" data-testid="todo-panel" aria-label="Waiting for you">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Waiting for you</h2>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
              {t.items.map((i) => (
                <Link
                  key={i.key}
                  href={i.href}
                  data-testid={`todo-${i.key}`}
                  className={`rounded-md border p-2 hover:bg-muted ${i.count ? "border-warning/50 bg-warning/15" : "text-muted-foreground"}`}
                >
                  {i.label}
                  <br />
                  <span className="text-lg font-bold text-foreground">{i.count}</span>
                  {i.count && i.amount ? (
                    <span className="ml-1 text-xs">
                      (<Money paise={i.amount} />)
                    </span>
                  ) : null}
                  {i.hint ? <span className="block text-[11px] text-muted-foreground">{i.hint}</span> : null}
                </Link>
              ))}
            </div>
          </section>
        ) : null
      }
    </DataState>
  );
}
