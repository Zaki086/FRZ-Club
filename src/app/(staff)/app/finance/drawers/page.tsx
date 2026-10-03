import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DrawersList } from "./drawers-list";

export const metadata: Metadata = { title: "All cash drawers" };

export default async function DrawersPage() {
  const actor = await requireUser();
  if (!can(actor, "cash.reconcile") && !can(actor, "dashboard.ops")) forbidden();
  return (
    <div>
      <PageHeader title="Cash drawers" subtitle="Every drawer session: what it collected by method, the cash expected and counted, and the variance." />
      <DrawersList />
    </div>
  );
}
