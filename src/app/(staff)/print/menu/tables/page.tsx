import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { tableQrCards } from "@/server/services/menu";
import { LogoMark } from "@/components/logo";
import { PrintButton } from "@/components/print-button";

export const metadata: Metadata = { title: "Table QR cards" };
export const dynamic = "force-dynamic";

/** v5 MN-6: one printable card per bar table; the QR opens the member's "Bar & Café" for that table (signed token). */
export default async function TableCardsPage() {
  const actor = await requireUser(STAFF_ROLES);
  if (!can(actor, "menu.manage")) forbidden();
  const { club, cards } = await tableQrCards(actor);
  const name = club.name || "Bar & café";
  return (
    <div className="qr-cards mx-auto bg-white text-black">
      <style>{`@page { size: A4; margin: 10mm } .qr-cards { width: 190mm; padding: 4mm 0 } .qr-cards .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm } .qr-cards .card { break-inside: avoid; border: 1px dashed #555; border-radius: 4mm; padding: 6mm; text-align: center; height: 128mm } @media screen { .qr-cards { margin-top: 1rem; width: 210mm; padding: 10mm } }`}</style>
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <p className="text-sm">{cards.length} table{cards.length === 1 ? "" : "s"} · cut along the dashed lines. Each QR is signed for its table; a reprint is the same card.</p>
        <PrintButton />
      </div>
      {cards.length ? (
        <div className="grid2">
          {cards.map((c) => (
            <div key={c.id} className="card flex flex-col items-center justify-between" data-testid="table-qr-card">
              <div className="flex items-center gap-2">
                {club.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the club's own logo (settings)
                  <img src={club.logoUrl} alt="" className="h-10 w-10 object-contain" />
                ) : (
                  <LogoMark name={name} />
                )}
                <span className="font-display text-lg font-bold uppercase tracking-wide">{name}</span>
              </div>
              <p className="font-display text-4xl font-bold">Table {c.number}</p>
              {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
              <img src={c.qr} alt={`QR code for table ${c.number}`} width={220} height={220} className="h-[60mm] w-[60mm]" />
              <div className="text-sm">
                <p className="font-semibold">Scan to order from the Bar &amp; Café</p>
                <p>Members: log in, order, and it goes on your tab. Pay at the bar.</p>
                <p className="mt-1 text-[8pt] text-black/60">{c.area} · seats {c.capacity}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center">There are no bar tables yet.</p>
      )}
    </div>
  );
}
