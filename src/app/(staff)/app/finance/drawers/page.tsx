import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DrawersList } from "./drawers-list";
import { DrawersOverview } from "./drawers-overview";

export const metadata: Metadata = { title: "Cash drawers" };

export default async function DrawersPage() {
  const actor = await requireUser();
  if (!can(actor, "cash.reconcile") && !can(actor, "dashboard.ops")) forbidden();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Cash drawers" subtitle="Every till with its live cash, the safe and bank deposits, and every drawer session with what it collected, expected and counted." />
      <DrawersOverview />
      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-bold">Sessions</h2>
        <DrawersList />
      </section>
    </div>
  );
}
