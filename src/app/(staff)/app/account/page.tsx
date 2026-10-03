import type { Metadata } from "next";
import { NotificationSettings } from "@/components/notification-settings";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { PageHeader } from "@/components/page";
import { AccountPanel } from "@/components/account-panel";

export const metadata: Metadata = { title: "My account" };

export default async function StaffAccountPage() {
  await requireUser(STAFF_ROLES, "/app/account");
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My account" />
      <div className="flex flex-col gap-4"><AccountPanel /><NotificationSettings /></div>
    </div>
  );
}
