import { PageHeader } from "@/components/page";
import { NotificationsList } from "@/components/notifications-list";

export default function StaffNotificationsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Notifications" subtitle="Alerts for your role: bookings, low stock, leads, leave and more." />
      <NotificationsList />
    </div>
  );
}
