import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { WhatsAppLogView } from "./whatsapp-log";

export const metadata: Metadata = { title: "WhatsApp messages" };

export default async function WhatsAppLogPage() {
  const actor = await requireUser();
  if (!can(actor, "messages.log")) forbidden();
  return (
    <div>
      <PageHeader title="WhatsApp messages" />
      <p className="mb-3 text-sm"><Link className="text-primary hover:underline" href="/app/settings/messages">← Message log</Link></p>
      <WhatsAppLogView />
    </div>
  );
}
