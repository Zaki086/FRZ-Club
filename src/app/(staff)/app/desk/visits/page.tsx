import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { VisitsList } from "./visits-list";

export const metadata: Metadata = { title: "Check-ins" };

export default async function VisitsPage() {
  const actor = await requireUser();
  if (!can(actor, "checkin")) forbidden();
  return (
    <div>
      <PageHeader
        title="Check-ins"
        actions={<Button asChild variant="outline"><Link href="/app/desk">Desk</Link></Button>}
      />
      <VisitsList />
    </div>
  );
}
