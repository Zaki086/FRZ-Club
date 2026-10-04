import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { LedgerExplorer } from "./ledger-explorer";

export default async function LedgerPage() {
  const actor = await requireUser();
  if (!can(actor, "finance.reports")) forbidden();
  return (
    <div>
      <PageHeader title="Ledger" />
      <LedgerExplorer />
    </div>
  );
}
