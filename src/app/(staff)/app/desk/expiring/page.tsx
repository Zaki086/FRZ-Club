import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ExpiringAndDues } from "./expiring-and-dues";
import { RenewalsList } from "./renewals-list";

export const metadata: Metadata = { title: "Renewals & dues" };

export default async function ExpiringPage() {
  const actor = await requireUser();
  if (!can(actor, "members.view")) forbidden();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Renewals & dues" subtitle="Members to renew or with money due: who was told, how, and when. Send the WhatsApp in one click or renew now." />
      <RenewalsList canSend={can(actor, "messages.send")} canRenew={can(actor, "members.manage")} />
      <details className="rounded-2xl border bg-card p-4">
        <summary className="cursor-pointer font-semibold">All unpaid bills, including walk-in guests</summary>
        <div className="mt-3"><ExpiringAndDues /></div>
      </details>
    </div>
  );
}
