import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { BackupsView } from "./backups-view";

export const metadata: Metadata = { title: "Backups" };

export default async function BackupsPage() {
  const actor = await requireUser();
  if (!can(actor, "settings")) forbidden();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Backups" subtitle="A full database backup runs every night at 02:30 and is kept for 14 days. Download one now and then and keep it somewhere else too." />
      <BackupsView />
    </div>
  );
}
