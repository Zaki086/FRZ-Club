import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DeskSearch } from "./desk-search";

export default async function DeskPage() {
  const actor = await requireUser();
  if (!can(actor, "checkin")) forbidden();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Front desk" subtitle="Scan a member card or search by name, phone or code. Press Enter to open the first match." />
      <DeskSearch />
    </div>
  );
}
