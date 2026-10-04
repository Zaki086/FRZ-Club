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
      <PageHeader title="Check-in risk" />
      <RiskList messaging={{ compose: can(actor, "messages.compose"), bulk: can(actor, "messages.bulk"), editText: can(actor, "messages.templates.view") }} />
    </div>
  );
}
