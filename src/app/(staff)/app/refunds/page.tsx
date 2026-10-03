import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/services/settings";
import { PageHeader } from "@/components/page";
import { RefundsQueue } from "./refunds-queue";

export const metadata: Metadata = { title: "Refunds" };

export default async function RefundsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireUser();
  if (!(["refunds.request", "refunds.approve", "invoices"] as const).some((c) => can(actor, c))) forbidden();
  // v4 §3.5: "Ready to pay out" is the tab the page opens on.
  if (!Object.keys(await searchParams).length) redirect("/app/refunds?status=APPROVED&sort=oldest");
  const s = await getSettings();
  return (
    <div>
      <PageHeader title="Refunds" subtitle="Every refund from request to pay-out. Approve what is waiting; pay out what members come to collect — check who they are first." />
      <RefundsQueue
        userId={actor.userId}
        canApprove={can(actor, "refunds.approve")}
        isOwner={actor.role === "OWNER"}
        managerLimit={s.refund_manager_limit}
      />
    </div>
  );
}
