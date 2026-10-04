import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DataRequests } from "./data-requests";

export const metadata: Metadata = { title: "Data requests" };

export default async function PrivacyPage() {
  const actor = await requireUser();
  if (!can(actor, "privacy.manage")) forbidden();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Data requests" />
      <DataRequests />
    </div>
  );
}
