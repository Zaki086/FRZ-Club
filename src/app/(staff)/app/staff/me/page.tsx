import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MySelfService } from "./my-self-service";

export default async function MyStaffPage() {
  const actor = await requireUser();
  if (!can(actor, "staff.self")) forbidden();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="My shifts & leave" />
      <MySelfService />
    </div>
  );
}
