import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { ReadyQueue } from "./ready-queue";

export default async function ReadyPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.operate")) forbidden();
  return (
    <div>
      <PageHeader title="Ready to serve" />
      <ReadyQueue />
    </div>
  );
}
