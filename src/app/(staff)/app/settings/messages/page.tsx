import Link from "next/link";
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
      <PageHeader
        title="Message log"
        actions={<Link className="text-sm font-semibold text-primary hover:underline" href="/app/settings/messages/whatsapp">WhatsApp messages: template, status timeline, tries →</Link>}
      />
      <MessageLogView />
    </div>
  );
}
