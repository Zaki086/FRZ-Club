import { NotificationsList } from "@/components/notifications-list";
import { NotificationSettings } from "@/components/notification-settings";
import { WhatsAppConsentCard } from "@/components/whatsapp-consent-card";

export default function MemberNotificationsPage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-bold">Notifications</h1>
      <NotificationSettings />
      <WhatsAppConsentCard />
      <NotificationsList />
    </div>
  );
}
