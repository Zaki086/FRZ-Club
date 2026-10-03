import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { DevTools } from "./dev-tools";

export const metadata: Metadata = { title: "Dev tools" };

export default async function DevToolsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const actor = await requireUser();
  if (!can(actor, "dev_tools")) forbidden();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Dev tools" subtitle="Time travel and scheduled jobs on demand (E-25), so expiry reminders, no-shows and holds can be shown live." />
      <DevTools />
    </div>
  );
}
