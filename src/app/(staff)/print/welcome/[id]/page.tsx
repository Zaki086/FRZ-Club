import type { Metadata } from "next";
import QRCode from "qrcode";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { welcomeSlip } from "@/server/services/membership";
import { getSettings } from "@/server/services/settings";
import { fmtDateTime } from "@/lib/time";
import { PrintNow } from "../../bill/[id]/print-now";
import { absoluteUrl } from "@/lib/url";

export const metadata: Metadata = { title: "Welcome slip" };
export const dynamic = "force-dynamic";

/** v3 WK-5: an 80 mm welcome slip — member code, username, portal address and a QR of the one-time link. */
export default async function WelcomeSlip({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const actor = await requireUser(STAFF_ROLES);
  const { id } = await params;
  const { t } = await searchParams;
  const slip = await welcomeSlip(actor, id, t);
  const s = await getSettings();
  const portal = absoluteUrl("/portal"); // URL-1
  const qr = slip.link ? await QRCode.toDataURL(absoluteUrl(slip.link), { margin: 1, width: 240 }) : null;
  return (
    <div className="receipt mx-auto font-mono text-[12px] leading-snug text-black">
      <style>{`@page { size: 80mm auto; margin: 0 } .receipt { width: 72mm; padding: 4mm 0 } @media screen { .receipt { margin-top: 1rem; padding: 4mm; border: 1px dashed #999 } }`}</style>
      <div className="text-center">
        <p className="text-[14px] font-bold">{s.club.name || "Club"}</p>
        <p className="mt-1 font-bold">WELCOME, {slip.name.toUpperCase()}</p>
      </div>
      <p className="mt-2">Member code: <b>{slip.memberCode}</b></p>
      <p>Username: <b>{slip.username}</b></p>
      <p>Portal: {portal}</p>
      {qr && slip.linkExpiresAt ? (
        <div className="mt-2 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
          <img src={qr} alt="QR code to set your password" width={200} height={200} className="mx-auto" />
          <p>Scan to set your password.</p>
          <p>Works once, until {fmtDateTime(slip.linkExpiresAt)}.</p>
          <PrintNow />
        </div>
      ) : (
        <p className="mt-2">Ask the front desk for a link to set your password.</p>
      )}
    </div>
  );
}
