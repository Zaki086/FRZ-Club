import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { currentActor } from "@/server/auth/current";
import { SESSION_COOKIE } from "@/server/auth/sessions";
import { isDomainError } from "@/server/errors";
import { recordTableScan } from "@/server/services/member-orders";

// v5 MO-1 (ORDER): the QR on a bar table opens /t/<TBL1 token>. A member who is logged in has the table remembered on
// this login for 3 hours and lands on Bar & Café; anyone else logs in first and comes back here.
export const metadata: Metadata = { title: "Order at your table", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

function Problem({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center" data-testid="table-scan-error">
      <ShieldX className="h-10 w-10 text-destructive" />
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

export default async function TableScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const actor = await currentActor();
  if (actor.kind !== "USER") redirect(`/login?returnTo=${encodeURIComponent(`/t/${token}`)}`);
  let table: number;
  try {
    const r = await recordTableScan(actor, (await cookies()).get(SESSION_COOKIE)?.value, token);
    table = r.table.number;
  } catch (e) {
    if (isDomainError(e, "LINK_INVALID")) {
      return <Problem title="This table code is not valid" text={e.message} action={<Button asChild variant="outline"><Link href="/portal/bar">Open Bar &amp; Café</Link></Button>} />;
    }
    if (isDomainError(e, "FORBIDDEN")) return <Problem title="For members" text={e.message} action={<Button asChild variant="outline"><Link href="/app/bar">Bar screen</Link></Button>} />;
    if (isDomainError(e, "UNAUTHENTICATED")) redirect(`/login?returnTo=${encodeURIComponent(`/t/${token}`)}&ended=1`);
    throw e;
  }
  redirect(`/portal/bar?table=${table}`);
}
