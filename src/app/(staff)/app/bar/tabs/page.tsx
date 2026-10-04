import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { TabsList } from "./tabs-list";

export const metadata: Metadata = { title: "Bar tabs" };

export default async function BarTabsPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.operate") && !can(actor, "bar.report")) forbidden();
  return (
    <div>
      <PageHeader
        title="Bar tabs"
        actions={<Button asChild variant="outline"><Link href="/app/bar">Tables</Link></Button>}
      />
      <TabsList perms={{ operate: can(actor, "bar.operate"), carry: can(actor, "bar.close_day") }} />
    </div>
  );
}
