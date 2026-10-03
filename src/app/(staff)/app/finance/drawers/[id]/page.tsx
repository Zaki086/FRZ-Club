import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DrawerSession } from "./drawer-session";

export const metadata: Metadata = { title: "Drawer session" };

// v4 §2: one drawer session — its movements with running balance, the close and the variance decision (RN-4 detail page).
export default async function DrawerSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "cash.reconcile") && !can(actor, "dashboard.ops") && !can(actor, "staff.self")) forbidden();
  const { id } = await params;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Drawer session" subtitle="Every cash movement with the running balance, the count at close and the variance." />
      <DrawerSession id={id} />
    </div>
  );
}
