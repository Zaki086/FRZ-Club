"use client";
// v6 §3 leads board: drag & drop between columns (mouse, touch and keyboard — Space to lift, arrows to move, Space to
// drop) and a "Move to…" menu on every card (LD-2), by the rules in lib/lead-moves.ts; the server enforces them.
// LD-1: the card moves at once and snaps back with the server's message if the move is refused. LD-3: the column
// counts follow the cards; overdue styling, filters, assignee and saved views are the list's own and keep working.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, pointerWithin, TouchSensor, useDroppable, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { ArrowRightLeft, Lock } from "lucide-react";
import { api, ApiError } from "@/components/api";
import { RejectionBanner } from "@/components/states";
import { SelectBox, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { convertLeadUrl, LEAD_COLUMN_TITLE, LEAD_COLUMNS, leadMove, WON_IS_FINAL, type LeadColumn, type LeadMoveKind } from "@/lib/lead-moves";
import { QuoteBuilder } from "./[id]/lead-detail";

export type BoardLead = {
  id: string; code: string; name: string; phone: string | null; email: string | null; status: LeadColumn; source: string; interest: string;
  assignee: string | null; next_follow_up_at: string; overdue: boolean; lost_reason: string | null; has_quote: boolean; converting: boolean;
};

type Err = { code?: string; message: string };
type Via = "drag" | "menu";
/** A move waiting for a dialog: the quote builder, the Lost / Reopen reason, Convert to member, or the quick note after Contacted. */
type Pending = { lead: BoardLead; from: LeadColumn; to: LeadColumn; kind: LeadMoveKind | "note"; via: Via; done?: boolean };

const toErr = (e: unknown): Err => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

/** "Follow up — overdue 2 days" / "Follow up tomorrow". */
export function FollowUp({ l }: { l: Pick<BoardLead, "status" | "lost_reason" | "overdue" | "next_follow_up_at"> }) {
  if (l.status === "WON" || l.status === "LOST") return l.status === "LOST" && l.lost_reason ? <span className="text-xs text-muted-foreground">{l.lost_reason}</span> : null;
  return (
    <span className={cn("text-xs font-semibold", l.overdue ? "text-destructive" : "text-muted-foreground")}>
      Follow up{l.overdue ? " — overdue " : " "}
      <RelTime when={l.next_follow_up_at} />
    </span>
  );
}

const colId = (s: LeadColumn) => `col-${s}`;

/** Pointer: the column under the pointer (nothing outside the board). Keyboard: the nearest column/card. */
const detect: CollisionDetection = (args) => (args.pointerCoordinates ? pointerWithin(args) : closestCorners(args));

export function LeadsDndBoard({ rows, canReopen, canConvert }: { rows: BoardLead[]; canReopen: boolean; canConvert: boolean }) {
  const router = useRouter();
  const reload = useListReload();
  // LD-1 optimistic moves: shown in `to` while the server still says `from`; dropped on rollback or once the list catches up.
  const [moved, setMoved] = useState<Record<string, { from: LeadColumn; to: LeadColumn }>>({});
  const [prevRows, setPrevRows] = useState(rows);
  if (rows !== prevRows) {
    setPrevRows(rows);
    setMoved((m) => Object.fromEntries(Object.entries(m).filter(([id, o]) => rows.find((r) => r.id === id)?.status === o.from)));
  }
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState<Err | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<LeadColumn | null>(null);
  const justDragged = useRef(false);

  const shown = (l: BoardLead): LeadColumn => (moved[l.id] && l.status === moved[l.id].from ? moved[l.id].to : l.status);
  const leads = rows.map((l) => ({ ...l, status: shown(l) }));
  const byId = (id: string) => leads.find((l) => l.id === id);
  const check = (l: BoardLead, to: LeadColumn) => leadMove(l.status, to, { hasQuote: l.has_quote, canReopen, canConvert });

  const place = (id: string, from: LeadColumn, to: LeadColumn) => setMoved((m) => ({ ...m, [id]: { from, to } }));
  const rollback = (id: string) => setMoved((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)));

  /** The server move (POST /move): the card is already in `to`; refused → back with the server's message. */
  async function commit(l: BoardLead, from: LeadColumn, to: LeadColumn, via: Via, extra: { reason?: string } = {}) {
    place(l.id, from, to);
    setBusy((b) => [...b, l.id]);
    try {
      await api(`/api/crm/leads/${l.id}/move`, { body: { to, via, ...extra } });
      void reload();
      return true;
    } catch (e) {
      rollback(l.id);
      const err = toErr(e);
      setError({ code: err.code, message: `${l.name} (${l.code}) stayed in ${LEAD_COLUMN_TITLE[from]}: ${err.message}` });
      return false;
    } finally {
      setBusy((b) => b.filter((x) => x !== l.id));
    }
  }

  /** One entry point for a drop and a "Move to…" choice (LD-2: same rules). */
  async function start(l: BoardLead, to: LeadColumn, via: Via) {
    setError(null);
    if (l.status === to) return;
    const rule = check(l, to);
    if (!rule.ok) {
      setError({ code: "LEAD_MOVE_NOT_ALLOWED", message: `${l.name}: ${rule.why}` });
      return;
    }
    const from = l.status;
    switch (rule.kind) {
      case "contact":
        // Moves at once; then an optional quick note (logged as an activity).
        if (await commit(l, from, to, via)) setPending({ lead: l, from, to, kind: "note", via });
        return;
      case "quote":
        await commit(l, from, to, via);
        return;
      case "quote-builder":
      case "lost":
      case "reopen":
        // Shown in the new column while the dialog is open; Cancel snaps it back.
        place(l.id, from, to);
        setPending({ lead: l, from, to, kind: rule.kind, via });
        return;
      case "convert":
        // Stays where it is: the lead turns WON only when the membership is paid (CR-7) — "Converting…" until then.
        setPending({ lead: l, from, to, kind: "convert", via });
        return;
    }
  }

  function closePending() {
    if (pending && !pending.done && (pending.kind === "quote-builder" || pending.kind === "lost" || pending.kind === "reopen")) rollback(pending.lead.id);
    setPending(null);
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );
  const active = activeId ? byId(activeId) : undefined;
  /** While dragging: may the active card go to this column? (Its own column stays a target: dropping there does nothing.) */
  const accepts = (s: LeadColumn) => !active || active.status === s || check(active, s).ok;

  const columnOf = (id: string | number | undefined, data?: Record<string, unknown>) =>
    (data?.column as LeadColumn | undefined) ?? (typeof id === "string" && id.startsWith("col-") ? (id.slice(4) as LeadColumn) : undefined);

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up ${byId(String(a.id))?.name ?? "lead"}. Use the arrow keys to choose a column, Space to drop, Escape to cancel.`,
    onDragOver: ({ over }) => {
      const c = over ? columnOf(over.id, over.data.current) : undefined;
      return c ? `Over ${LEAD_COLUMN_TITLE[c]}.` : "Not over a column.";
    },
    onDragEnd: ({ over }) => {
      const c = over ? columnOf(over.id, over.data.current) : undefined;
      return c ? `Dropped on ${LEAD_COLUMN_TITLE[c]}.` : "Dropped outside the columns; nothing changed.";
    },
    onDragCancel: () => "Move cancelled; the lead stays where it was.",
  };

  return (
    <div className="flex flex-col gap-2">
      <RejectionBanner error={error} />
      <DndContext
        id="leads-board"
        sensors={sensors}
        collisionDetection={detect}
        accessibility={{ announcements, screenReaderInstructions: { draggable: "To move this lead, press Space, use the arrow keys to choose a column, and press Space again. Escape cancels." } }}
        onDragStart={(e: DragStartEvent) => { setError(null); setActiveId(String(e.active.id)); setOverCol(null); }}
        // The column under the card: the column itself, or the column of the card it is over (the keyboard sensor
        // moves between cards), so the highlight shows wherever the drop would land.
        onDragOver={(e: DragOverEvent) => setOverCol(e.over ? columnOf(e.over.id, e.over.data.current) ?? null : null)}
        onDragCancel={() => { setActiveId(null); setOverCol(null); }}
        onDragEnd={(e: DragEndEvent) => {
          setActiveId(null);
          setOverCol(null);
          justDragged.current = true;
          setTimeout(() => { justDragged.current = false; }, 0);
          const lead = byId(String(e.active.id));
          const to = e.over ? columnOf(e.over.id, e.over.data.current) : undefined;
          if (lead && to && to !== lead.status) void start(lead, to, "drag");
        }}
      >
        <div
          className="grid gap-3 md:grid-cols-3 xl:grid-cols-5"
          // A click that ends a drag must not open the lead.
          onClickCapture={(e) => { if (justDragged.current) { e.preventDefault(); e.stopPropagation(); } }}
        >
          {LEAD_COLUMNS.map((s) => {
            const col = leads.filter((l) => l.status === s);
            return (
              <Column key={s} status={s} count={col.length} dragging={!!active} over={!!active && overCol === s} accepts={accepts(s)} why={active && !accepts(s) ? check(active, s) : null}>
                <SortableContext id={s} items={col.map((l) => l.id)} strategy={() => null}>
                  {col.map((l) => (
                    <LeadCard
                      key={l.id}
                      lead={l}
                      busy={busy.includes(l.id)}
                      droppable={accepts(s)}
                      faded={activeId === l.id}
                      menu={<MoveMenu lead={l} check={(to) => check(l, to)} onPick={(to) => void start(l, to, "menu")} />}
                    />
                  ))}
                </SortableContext>
              </Column>
            );
          })}
        </div>
        <DragOverlay>{active ? <CardBody lead={active} overlay /> : null}</DragOverlay>
      </DndContext>

      {pending ? (
        <MoveDialog
          pending={pending}
          onCancel={closePending}
          onReason={async (reason) => {
            const p = pending;
            setPending(null);
            await commit(p.lead, p.from, p.to, p.via, { reason });
          }}
          onQuoted={() => { setPending({ ...pending, done: true }); void reload(); }}
          onConvert={() => { setPending(null); router.push(convertLeadUrl(pending.lead)); }}
          onNote={async (note) => {
            await api(`/api/crm/leads/${pending.lead.id}/activity`, { body: { type: "NOTE", note } });
            setPending(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

function Column({ status, count, dragging, over, accepts, why, children }: { status: LeadColumn; count: number; dragging: boolean; over: boolean; accepts: boolean; why: { ok: false; why: string } | { ok: true } | null; children: ReactNode }) {
  const { setNodeRef, isOver: overSelf } = useDroppable({ id: colId(status), data: { column: status }, disabled: !accepts });
  const isOver = overSelf || over;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-28 flex-col gap-2 rounded-2xl bg-secondary/70 p-2 transition-colors",
        dragging && accepts && "ring-1 ring-primary/30",
        isOver && accepts && "bg-primary/10 ring-2 ring-primary",
        dragging && !accepts && "opacity-50",
      )}
      title={why && !why.ok ? why.why : undefined}
      data-testid={`lead-column-${status}`}
      data-over={isOver && accepts ? "true" : undefined}
      aria-label={`${LEAD_COLUMN_TITLE[status]} column`}
      role="region"
    >
      <p className="flex items-center justify-between px-1 text-sm font-bold">
        {LEAD_COLUMN_TITLE[status]} <span className="rounded-full bg-card px-2 text-xs tabular" data-testid={`lead-count-${status}`}>{count}</span>
      </p>
      {count === 0 ? <p className="px-1 py-4 text-center text-xs text-muted-foreground">No leads</p> : null}
      {children}
    </div>
  );
}

function CardBody({ lead: l, overlay }: { lead: BoardLead; overlay?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-2.5 text-sm shadow-soft", l.overdue && "border-destructive/50", overlay && "rotate-1 shadow-lift ring-2 ring-primary")}>
      <span className="flex items-center justify-between gap-2">
        {overlay ? <span className="font-semibold">{l.name}</span> : (
          <Link href={`/app/crm/${l.id}`} className="font-semibold hover:text-primary hover:underline" draggable={false} data-testid="lead-card-link">{l.name}</Link>
        )}
        <span className="flex items-center gap-1">
          {l.converting ? <Badge tone="amber" data-testid="lead-converting">Converting…</Badge> : null}
          {l.overdue ? <Badge tone="red">Overdue</Badge> : null}
          {l.status === "WON" ? <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Won is final" /> : null}
        </span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">{l.code} · {l.source.replace(/_/g, " ").toLowerCase()}</span>
      {l.interest ? <span className="text-xs">{l.interest}</span> : null}
      <span className="text-xs text-muted-foreground">{l.assignee ? `→ ${l.assignee}` : "Unassigned"}</span>
      <FollowUp l={l} />
    </div>
  );
}

function LeadCard({ lead: l, busy, droppable, faded, menu }: { lead: BoardLead; busy: boolean; droppable: boolean; faded: boolean; menu: ReactNode }) {
  const won = l.status === "WON";
  const { setNodeRef, setActivatorNodeRef, attributes, listeners } = useSortable({
    id: l.id,
    data: { column: l.status },
    // Out of Won is not allowed: a won card doesn't lift (the tooltip says why).
    disabled: { draggable: won || busy, droppable: !droppable },
  });
  return (
    // v5 §3.4: while bulk selection is on, each card has its checkbox beside it.
    <div className="flex items-start gap-1.5">
      <span className="pt-3 empty:hidden"><SelectBox id={l.id} label={l.name} /></span>
      <div
        ref={(n) => { setNodeRef(n); setActivatorNodeRef(n); }}
        {...attributes}
        {...listeners}
        aria-roledescription="draggable lead"
        aria-label={`${l.name}, ${LEAD_COLUMN_TITLE[l.status]}${won ? " — won is final" : ""}`}
        aria-disabled={won || busy}
        title={won ? WON_IS_FINAL : undefined}
        className={cn(
          "relative min-w-0 flex-1 touch-manipulation rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
          won ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
          faded && "opacity-40",
          busy && "animate-pulse",
        )}
        data-testid="lead-card"
        data-lead-code={l.code}
        data-status={l.status}
      >
        <CardBody lead={l} />
        <div className="absolute bottom-1.5 right-1.5">{menu}</div>
      </div>
    </div>
  );
}

/** LD-2: every card's "Move to…" menu, with the same rules (a refused column says why). */
function MoveMenu({ lead: l, check, onPick }: { lead: BoardLead; check: (to: LeadColumn) => ReturnType<typeof leadMove>; onPick: (to: LeadColumn) => void }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={`Move ${l.name} to…`}
          data-testid="lead-move-menu"
          onKeyDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <ArrowRightLeft className="h-3 w-3" /> Move to…
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={4} className="z-50 w-64 rounded-2xl border bg-popover p-1.5 shadow-lift" aria-label={`Move ${l.name} to`}>
          {LEAD_COLUMNS.filter((s) => s !== l.status).map((s) => {
            const r = check(s);
            return (
              <Menu.Item
                key={s}
                disabled={!r.ok}
                onSelect={() => onPick(s)}
                className="flex cursor-pointer flex-col rounded-lg px-2 py-1.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-secondary data-[disabled]:opacity-60"
                data-testid={`move-to-${s}`}
              >
                <span className="font-semibold">{LEAD_COLUMN_TITLE[s]}</span>
                {!r.ok ? <span className="text-xs text-muted-foreground">{r.why}</span> : null}
              </Menu.Item>
            );
          })}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MoveDialog({ pending: p, onCancel, onReason, onQuoted, onConvert, onNote }: {
  pending: Pending;
  onCancel: () => void;
  onReason: (reason: string) => Promise<void>;
  onQuoted: () => void;
  onConvert: () => void;
  onNote: (note: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const l = p.lead;
  const submit = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(toErr(err));
    } finally {
      setBusy(false);
    }
  };
  const title =
    p.kind === "quote-builder" ? `Quote for ${l.name}`
    : p.kind === "lost" ? `Mark ${l.name} as lost`
    : p.kind === "reopen" ? `Reopen ${l.name} → ${LEAD_COLUMN_TITLE[p.to]}`
    : p.kind === "convert" ? `Convert ${l.name} to a member`
    : `${l.name} → Contacted`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent title={title} wide={p.kind === "quote-builder"}>
        <div data-testid={`lead-move-dialog-${p.kind}`}>
          {p.kind === "quote-builder" ? (
            <div className="flex flex-col gap-3">
              <QuoteBuilder leadId={l.id} hasEmail={!!l.email} onDone={onQuoted} />
              {p.done ? <Button variant="outline" onClick={onCancel}>Done</Button> : null}
            </div>
          ) : p.kind === "lost" || p.kind === "reopen" ? (
            <form className="flex flex-col gap-3" onSubmit={submit(() => onReason(text.trim()))}>
              <Field label="Reason (required)">
                <Input value={text} onChange={(e) => setText(e.target.value)} required minLength={3} maxLength={300} autoFocus />
              </Field>
              <RejectionBanner error={error} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button type="submit" variant={p.kind === "lost" ? "destructive" : "default"} disabled={busy || text.trim().length < 3}>{p.kind === "lost" ? "Mark lost" : "Reopen"}</Button>
              </div>
            </form>
          ) : p.kind === "convert" ? (
            <div className="flex flex-col gap-3 text-sm">
              <p>The New member form opens with their details. The lead moves to Won when the membership is paid; until then it shows “Converting…”.</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button type="button" onClick={onConvert} data-testid="convert-lead">Convert to member</Button>
              </div>
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={submit(() => onNote(text.trim()))}>
              <Field label="Quick note (optional)">
                <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} autoFocus />
              </Field>
              <RejectionBanner error={error} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onCancel}>Skip</Button>
                <Button type="submit" disabled={busy || text.trim().length < 2}>Save note</Button>
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
