import type { Metadata } from "next";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { PageHeader } from "@/components/page";
import { NotificationsList } from "@/components/notifications-list";

export const metadata: Metadata = { title: "Notifications" };

/** v4 §1.2: the full page of the header bell — this person's own staff notifications (every role reaches it from the bell). */
export default async function StaffNotificationsPage() {
  await requireUser(STAFF_ROLES, "/app/notifications");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" />
      <NotificationsList />
    </div>
  );
}
