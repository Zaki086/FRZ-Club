"use client";
// Pick booking players: search members (debounced) or add a walk-in guest by name. The server validates everything.
import { useEffect, useState } from "react";
import { Star, Trash2, UserPlus } from "lucide-react";
import { useApi } from "@/components/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/contact-inputs";
import { TierBadge } from "@/components/badges";
import { cn } from "@/components/ui/cn";
import type { MemberHit, PickedPlayer } from "./types";

export function PlayerPicker({
  players,
  onChange,
  max,
  primaryIndex,
  onPrimary,
  lockedKeys = [],
}: {
  players: PickedPlayer[];
  onChange: (p: PickedPlayer[]) => void;
  max: number;
  primaryIndex?: number;
  onPrimary?: (i: number) => void;
  lockedKeys?: string[];
}) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useApi<MemberHit[]>(term.length >= 2 ? `/api/members?q=${encodeURIComponent(term)}` : null);
  const full = players.length >= max;

  const add = (p: PickedPlayer) => {
    if (players.some((x) => x.key === p.key) || full) return;
    onChange([...players, p]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y rounded-md border">
        {players.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No players yet — search a member or add a walk-in guest.</p> : null}
        {players.map((p, i) => (
          <div key={p.key} className="flex items-center gap-2 p-2 text-sm">
            {onPrimary ? (
              <button
                type="button"
                onClick={() => onPrimary(i)}
                className={cn("rounded p-1", primaryIndex === i ? "text-gold" : "text-muted-foreground hover:text-foreground")}
                aria-label={primaryIndex === i ? "Paying player" : "Make paying player"}
                title={primaryIndex === i ? "Paying player" : "Make paying player"}
              >
                <Star className="h-4 w-4" fill={primaryIndex === i ? "currentColor" : "none"} />
              </button>
            ) : null}
            <div className="flex-1">
              <p className="font-medium">{p.name}</p>
              {p.detail ? <p className="text-xs text-muted-foreground">{p.detail}</p> : null}
            </div>
            {primaryIndex === i ? <span className="text-xs font-semibold text-warning-text">pays</span> : null}
            {!lockedKeys.includes(p.key) ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${p.name}`}
                onClick={() => {
                  const next = players.filter((_, j) => j !== i);
                  onChange(next);
                  if (onPrimary && primaryIndex !== undefined) onPrimary(primaryIndex === i ? 0 : primaryIndex > i ? primaryIndex - 1 : primaryIndex);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {players.length}/{max} players{full ? " — court is full" : ""}
      </p>
      {!full ? (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Input placeholder="Search member: name, phone, CC-000123" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search member" />
            {term.length >= 2 ? (
              <div className="max-h-40 overflow-y-auto rounded-md border">
                {hits.loading ? <p className="p-2 text-xs text-muted-foreground">Searching…</p> : null}
                {hits.error ? <p className="p-2 text-xs text-destructive">{hits.error.message}</p> : null}
                {hits.data?.length === 0 ? <p className="p-2 text-xs text-muted-foreground">No member matches.</p> : null}
                {hits.data?.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className="flex w-full items-center justify-between gap-2 p-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                    disabled={players.some((x) => x.key === `m:${m.id}`)}
                    onClick={() => {
                      add({ key: `m:${m.id}`, name: m.name, detail: `${m.memberCode} · ${m.status.status === "ACTIVE" ? m.status.tier : "walk-in rates"}`, input: { memberId: m.id } });
                      setQ("");
                    }}
                  >
                    <span>
                      {m.name} <span className="font-mono text-xs text-muted-foreground">{m.memberCode}</span>
                    </span>
                    <TierBadge tier={m.status.status === "ACTIVE" ? m.status.tier : "WALK_IN"} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <form
            className="flex items-start gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const name = guestName.trim();
              if (name.length < 2) return;
              const phone = guestPhone.trim();
              add({
                key: `g:${name.toLowerCase()}:${phone}:${players.length}`,
                name,
                detail: phone ? `Walk-in guest · ${phone}` : "Walk-in guest",
                input: { guest: phone ? { name, phone } : { name } },
              });
              setGuestName("");
              setGuestPhone("");
            }}
          >
            <Input placeholder="Guest name" value={guestName} onChange={(e) => setGuestName(e.target.value)} aria-label="Guest name" />
            <PhoneInput wrapperClassName="w-44 shrink-0" placeholder="Phone" name="guestPhone" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} aria-label="Guest phone" />
            <Button type="submit" variant="outline" aria-label="Add guest">
              <UserPlus className="h-4 w-4" />
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
