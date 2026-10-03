import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MenuManager } from "./menu-manager";

export const metadata: Metadata = { title: "Menu" };

export default async function MenuPage() {
  const actor = await requireUser();
  if (!can(actor, "bar.close_day")) forbidden();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Bar & café menu" subtitle="Add items and change prices. A price change applies to new orders only; existing tabs keep their prices." />
      <MenuManager />
    </div>
  );
}
