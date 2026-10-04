"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { QrCode, CalendarPlus, UserPlus } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataState, RejectionBanner } from "@/components/states";
import { MemberStatusBadge, type MemberStatus } from "@/components/member-status";
import { QrScanner } from "@/components/qr-scanner";

type Row = { id: string; memberCode: string; name: string; phone: string; photoUrl: string | null; status: MemberStatus };

export function DeskSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [scan, setScan] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const term = q.trim();
  const state = useApi<Row[]>(term.length >= 2 && !term.startsWith("CC1.") ? `/api/members?q=${encodeURIComponent(term)}` : null);
  const openCard = useCallback(
    async (payload: string) => {
      setError(null);
      setScan(false);
      try {
        const r = await api<{ memberId: string }>("/api/members/lookup-card", { body: { payload } });
        router.push(`/app/members/${r.memberId}`);
      } catch (e) {
        setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
      }
    },
    [router],
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Input
          className="h-14 flex-1 text-lg"
          placeholder="Name, phone, CC-000123 — or scan a card"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (term.startsWith("CC1.")) void openCard(term);
            else if (state.data?.[0]) router.push(`/app/members/${state.data[0].id}`);
          }}
          data-testid="desk-search"
        />
        <Button size="xl" variant="outline" onClick={() => setScan(true)}>
          <QrCode className="h-5 w-5" /> Scan card
        </Button>
        <Button size="xl" variant="outline" asChild>
          <Link href="/app/courts"><CalendarPlus className="h-5 w-5" /> Walk-in booking</Link>
        </Button>
        <Button size="xl" asChild>
          <Link href="/app/members/new"><UserPlus className="h-5 w-5" /> New member</Link>
        </Button>
      </div>
      <RejectionBanner error={error} />
      {scan ? <QrScanner onScan={openCard} onClose={() => setScan(false)} /> : null}
      {term.length >= 2 && !term.startsWith("CC1.") ? (
        <Card>
          <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: `No member matches “${term}”` }}>
            {(rows) => (
              <div className="divide-y">
                {rows.map((m) => (
                  <Link key={m.id} href={`/app/members/${m.id}`} className="flex items-center gap-3 p-3 hover:bg-muted">
                    {m.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.photoUrl} alt="" className="h-12 w-12 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted font-bold">{m.name.charAt(0)}</div>
                    )}
                    <div className="flex-1">
                      <p className="font-semibold">{m.name}</p>
                      <p className="text-sm text-muted-foreground">{m.memberCode} · {m.phone}</p>
                    </div>
                    <MemberStatusBadge status={m.status} />
                  </Link>
                ))}
              </div>
            )}
          </DataState>
        </Card>
      ) : null}
    </div>
  );
}
