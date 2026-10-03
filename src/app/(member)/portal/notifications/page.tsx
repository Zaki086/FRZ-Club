import { NotificationsList } from "@/components/notifications-list";

export default function MemberNotificationsPage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">Notifications</h1>
      <NotificationsList />
    </div>
  );
}
