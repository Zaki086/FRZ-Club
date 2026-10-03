"use client";
import { useApi } from "./api";
import { DataState } from "./states";
import { MemberStatusBadge, type MemberStatus } from "./member-status";
import { useCapabilities } from "./capabilities";

/** QR member card (MB-14). The QR payload is signed by the server. */
export function MemberCard({ memberId }: { memberId: string }) {
  const clubName = useCapabilities()?.clubName ?? "";
  const state = useApi<{ memberCode: string; name: string; photoUrl: string | null; qr: string; status: MemberStatus }>(`/api/members/${memberId}/card`);
  return (
    <DataState state={state}>
      {(c) => (
        <div className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-emerald-800 to-emerald-950 p-4 text-white shadow-lg" data-testid="member-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={c.qr} alt={`Member card QR for ${c.memberCode}`} className="h-24 w-24 shrink-0 rounded-md bg-white p-1 sm:h-28 sm:w-28" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs uppercase tracking-widest text-emerald-200">{clubName}</p>
            <p className="break-words text-xl font-bold">{c.name}</p>
            <p className="font-mono text-sm">{c.memberCode}</p>
            <div className="rounded bg-white/90 px-1 py-0.5">
              <MemberStatusBadge status={c.status} />
            </div>
          </div>
        </div>
      )}
    </DataState>
  );
}
