import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { AttendanceTabs } from "../_components/attendance-bits";
import { AttendanceLog } from "./attendance-log";

export const metadata: Metadata = { title: "Attendance" };

export default async function AttendancePage() {
  const actor = await requireUser();
  if (!can(actor, "staff.directory")) forbidden();
  return (
    <div>
      <PageHeader title="Attendance" subtitle="Every clock-in against the roster: late, early, overtime and missing clock-outs." />
      <AttendanceTabs active="log" />
      <AttendanceLog canCorrect={can(actor, "attendance.correct")} selfEmployeeId={actor.employeeId} />
    </div>
  );
}
