import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { SettingsTabs } from "./_components/settings-tabs";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const actor = await requireUser();
  if (!can(actor, "settings")) forbidden();
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Settings" subtitle="Every business number lives here or in the plans — edits are validated and audited, and never change existing bills." />
      <SettingsTabs selfUserId={actor.userId} />
    </div>
  );
}
