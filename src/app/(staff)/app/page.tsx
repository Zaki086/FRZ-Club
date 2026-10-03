import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { ROLE_HOME } from "@/server/auth/sessions";
import { can, type Capability } from "@/server/rbac/permissions";
import { TODO_HOME } from "@/server/services/todo";
import { clock } from "@/lib/clock";
import { istDate } from "@/lib/time";
import { DashboardView } from "./_dashboard/dashboard";
import { TodoPanel } from "./_components/todo-panel";

export const metadata: Metadata = { title: "Dashboard" };

const DASHBOARDS: Capability[] = ["dashboard.full", "dashboard.ops", "dashboard.finance", "dashboard.desk", "dashboard.shop", "dashboard.bar"];

export default async function DashboardPage() {
  const actor = await requireUser(STAFF_ROLES, "/app");
  // Roles without a dashboard (the kitchen) go to their own screen instead of a page they can't load.
  if (!DASHBOARDS.some((c) => can(actor, c))) redirect(ROLE_HOME[actor.role]);
  // The Owner and Manager start here: their approvals lead. (The menu is the way to every other screen.)
  return <DashboardView todo={TODO_HOME[actor.role] === "dashboard" ? <TodoPanel /> : null} today={istDate(clock.now())} />;
}
