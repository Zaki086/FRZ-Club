import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { RiskList } from "./risk-list";

export const metadata: Metadata = { title: "Check-in risk" };

export default async function CheckinRiskPage() {
  const actor = await requireUser();
  if (!can(actor, "checkin")) forbidden();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Check-in risk"
        subtitle="Arrivals today and in the next 2 hours that will hit a problem at the desk — fix each one before they arrive."
      />
      <RiskList />
    </div>
  );
}
