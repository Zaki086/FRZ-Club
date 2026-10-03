import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MessageLogView } from "./message-log";

export default async function MessagesPage() {
  const actor = await requireUser();
  if (!can(actor, "messages.log")) forbidden();
  return (
    <div>
      <PageHeader title="Message log" subtitle="Every email the app delivered (or failed to) and every WhatsApp message staff opened. WhatsApp shows “opened”: the app can't see whether it was sent." />
      <MessageLogView />
    </div>
  );
}
