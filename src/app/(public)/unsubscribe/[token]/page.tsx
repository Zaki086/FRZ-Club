import type { Metadata } from "next";
import { MailX, ShieldX } from "lucide-react";
import { isDomainError } from "@/server/errors";
import { applyUnsubscribe, type UnsubscribeResult } from "@/server/services/messages/unsubscribe";
import { Resubscribe } from "./resubscribe";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * v5 §3.2 `/unsubscribe/<token>`: the one-click link at the bottom of every announcement email. Opening it stops
 * announcement emails to this person (booking, payment and refund emails still come). No login; nothing personal
 * shown beyond the first name; "Subscribe again" undoes it.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let r: UnsubscribeResult;
  try {
    r = await applyUnsubscribe(token);
  } catch (e) {
    if (isDomainError(e)) {
      return (
        <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center">
          <ShieldX className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold">Link unavailable</h1>
          <p className="text-muted-foreground" data-testid="unsubscribe-error">{e.message}</p>
        </div>
      );
    }
    throw e;
  }
  const club = r.clubName || "the club";
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-14 text-center" data-testid="unsubscribe-page">
      <MailX className="h-10 w-10 text-primary" />
      <h1 className="font-display text-3xl font-bold">{r.firstName ? `Done, ${r.firstName}` : "Done"}</h1>
      <p className="text-lg">You won&apos;t get announcement emails from {club} any more.</p>
      <p className="text-sm text-muted-foreground">
        Emails about your own bookings, payments, refunds and membership still come, so you don&apos;t miss anything you need.
      </p>
      <Resubscribe token={token} club={club} />
    </div>
  );
}
