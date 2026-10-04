import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { AttendanceTabs } from "../../_components/attendance-bits";
import { AttendanceSummary } from "./attendance-summary";

export const metadata: Metadata = { title: "Attendance summary" };

export default async function AttendanceSummaryPage() {
  const actor = await requireUser();
  if (!can(actor, "staff.directory")) forbidden();
  return (
    <div>
      <PageHeader title="Attendance" />
      <AttendanceTabs active="summary" />
      <AttendanceSummary />
    </div>
  );
}
