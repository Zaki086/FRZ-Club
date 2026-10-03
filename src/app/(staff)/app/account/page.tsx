import type { Metadata } from "next";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { PageHeader } from "@/components/page";
import { AccountPanel } from "@/components/account-panel";

export const metadata: Metadata = { title: "My account" };

export default async function StaffAccountPage() {
  await requireUser(STAFF_ROLES, "/app/account");
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My account" />
      <AccountPanel />
    </div>
  );
}
