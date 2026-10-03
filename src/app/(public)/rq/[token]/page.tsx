import type { Metadata } from "next";
import { CheckCircle2, ShieldX } from "lucide-react";
import { qrDataUrl } from "@/lib/qr";
import { formatINR } from "@/lib/money";
import { fmtDate, fmtDateTime, istDate } from "@/lib/time";
import { isDomainError } from "@/server/errors";
import { publicRefundByToken } from "@/server/services/refunds";
import { getSettings } from "@/server/services/settings";

export const metadata: Metadata = { title: "Refund to collect", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * v4 §5.3 `/rq/<token>`: the refund collection QR (RF-8) for the member's phone — from the WhatsApp "Show QR" button
 * or the portal. Read-only, no login, nothing personal beyond the first name; the desk scans the QR to pay it out.
 */
export default async function RefundQrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let r: Awaited<ReturnType<typeof publicRefundByToken>>;
  try {
    r = await publicRefundByToken(token);
  } catch (e) {
    if (isDomainError(e)) {
      return (
        <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center">
          <ShieldX className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold">Link unavailable</h1>
          <p className="text-muted-foreground" data-testid="rq-error">{e.message}</p>
        </div>
      );
    }
    throw e;
  }
  const s = await getSettings();
  const qr = r.state === "READY" ? await qrDataUrl(r.token) : null;
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-10 text-center" data-testid="rq-page">
      <p className="eyebrow text-primary">{s.club.name || "Club"}</p>
      <h1 className="font-display text-3xl font-bold">{r.firstName ? `Hi ${r.firstName}` : "Your refund"}</h1>
      {r.state === "READY" ? (
        <>
          <p className="text-lg">
            <span className="font-bold" data-testid="rq-amount">{formatINR(r.amount)}</span> is ready to collect at the front desk.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
          <img src={qr!} alt={`Refund QR for ${r.code}`} width={240} height={240} className="rounded-2xl border bg-white p-2" />
          <p className="font-mono text-xl font-bold" data-testid="rq-code">{r.code}</p>
          <p className="text-sm text-muted-foreground">
            Show this QR (or your member card) at the front desk, open {s.opening_hours.open}–{s.opening_hours.close}.
            {r.readyAt ? ` Ready since ${fmtDate(istDate(new Date(r.readyAt)))}.` : ""} It does not expire.
          </p>
        </>
      ) : r.state === "COLLECTED" ? (
        <div className="flex flex-col items-center gap-2" data-testid="rq-collected">
          <CheckCircle2 className="h-10 w-10 text-success-text" />
          <p className="text-lg">Refund <span className="font-mono font-bold">{r.code}</span> of {formatINR(r.amount)} was paid out{r.completedAt ? ` on ${fmtDateTime(new Date(r.completedAt))}` : ""}.</p>
        </div>
      ) : (
        <p className="text-lg">Refund <span className="font-mono font-bold">{r.code}</span> is not waiting at the desk. Please ask at the front desk.</p>
      )}
    </div>
  );
}
