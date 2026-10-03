import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DeskSearch } from "./desk-search";
import { DeskToday } from "./desk-today";

export default async function DeskPage() {
  const actor = await requireUser();
  if (!can(actor, "checkin")) forbidden();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Today at the desk" subtitle="Who is arriving, what is still to collect — then scan a member card or search below." />
      <DeskToday />
      <DeskSearch />
    </div>
  );
}
