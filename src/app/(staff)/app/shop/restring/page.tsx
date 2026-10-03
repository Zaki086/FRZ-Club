import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { RestringQueue } from "./restring-queue";

export default async function RestringPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.view")) forbidden();
  return (
    <div>
      <PageHeader title="Restring queue" subtitle="Racket restringing tickets (E-10). The customer is notified automatically when a ticket is marked READY." />
      <RestringQueue canAdvance={can(actor, "shop.fulfil")} />
    </div>
  );
}
