import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { PendingRefunds } from "./pending-refunds";

export default async function RefundsPage() {
  const actor = await requireUser();
  if (!(["bookings.any", "shop.counter", "bar.operate", "invoices"] as const).some((c) => can(actor, c))) forbidden();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Refunds to pay out" subtitle="Refunds that couldn't go back automatically. Pay each one from your drawer and record how." />
      <PendingRefunds />
    </div>
  );
}
