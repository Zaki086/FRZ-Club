import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { NewMemberForm } from "./new-member-form";

export default async function NewMemberPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireUser();
  if (!can(actor, "members.manage")) forbidden();
  const sp = await searchParams;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="New member" />
      <NewMemberForm prefill={{ name: sp.name ?? "", phone: sp.phone ?? "", email: sp.email ?? "", leadId: sp.leadId ?? "" }} />
    </div>
  );
}
