import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MessagesList } from "./messages-list";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage() {
  const actor = await requireUser();
  if (!can(actor, "notifications.log")) forbidden();
  return (
    <div>
      <PageHeader title="Messages" subtitle="Every notification to members, per channel. WhatsApp messages to send by hand are at the top: open, send from the club phone, mark sent." />
      <MessagesList canSend={can(actor, "messages.send")} />
    </div>
  );
}
