import type { Metadata } from "next";
import Link from "next/link";
import { NotificationSettings } from "@/components/notification-settings";
import { PushOptInCard } from "@/components/push-opt-in";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { PageHeader } from "@/components/page";
import { AccountPanel } from "@/components/account-panel";

export const metadata: Metadata = { title: "My account" };

export default async function StaffAccountPage() {
  await requireUser(STAFF_ROLES, "/app/account");
  return (
    <div className="mx-auto max-w-2xl">
      {/* v4: the Manager's menu has no "My shifts & leave" entry — clock-in, shifts and leave stay one click away here. */}
      <PageHeader title="My account" actions={<Link className="text-sm font-semibold text-primary underline" href="/app/staff/me">My shifts, clock-in &amp; leave</Link>} />
      <div className="flex flex-col gap-4"><AccountPanel /><PushOptInCard audience="staff" /><NotificationSettings /></div>
    </div>
  );
}
