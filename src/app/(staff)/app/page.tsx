import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { ROLE_HOME } from "@/server/auth/sessions";
import { can, type Capability } from "@/server/rbac/permissions";
import { TODO_HOME } from "@/server/services/todo";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { DashboardView } from "./_dashboard/dashboard";
import { ApprovalsPanel } from "./_dashboard/approvals-panel";
import { FrontDeskDashboard } from "./_dashboard/front-desk";
import { ManagerToday } from "./_dashboard/manager-today";
import { OwnerCash } from "./_dashboard/owner-cash";
import { TodoPanel } from "./_components/todo-panel";

export const metadata: Metadata = { title: "Dashboard" };

const DASHBOARDS: Capability[] = ["dashboard.full", "dashboard.ops", "dashboard.finance", "dashboard.desk", "dashboard.shop", "dashboard.bar"];

/**
 * v4 RN-5 — each role's dashboard:
 *  - Owner: "Needs your approval" (RN-4) at the top, the cash summary, the Owner's other to-dos, then the full dashboard.
 *  - Manager: "Needs your approval" at the top, then today's operations.
 *  - Front desk: drawer, arrivals, check-in risks, refunds to pay out, renewals, messages, overdue leads.
 *  - Accountant, shop and bar keep their v3 dashboards.
 */
export default async function DashboardPage() {
  const actor = await requireUser(STAFF_ROLES, "/app");
  // Roles without a dashboard (the kitchen) go to their own screen instead of a page they can't load.
  if (!DASHBOARDS.some((c) => can(actor, c))) redirect(ROLE_HOME[actor.role]);
  const today = istDate(clock.now());
  if (actor.role === "MANAGER") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Dashboard" />
        <ApprovalsPanel />
        <TodoPanel />
        <ManagerToday />
      </div>
    );
  }
  if (actor.role === "FRONT_DESK") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Dashboard" />
        <FrontDeskDashboard />
      </div>
    );
  }
  const owner = actor.role === "OWNER";
  return (
    <DashboardView
      today={today}
      todo={
        owner ? (
          <div className="flex flex-col gap-4">
            <ApprovalsPanel />
            <OwnerCash />
            <TodoPanel />
          </div>
        ) : TODO_HOME[actor.role] === "dashboard" ? (
          <TodoPanel />
        ) : null
      }
    />
  );
}
