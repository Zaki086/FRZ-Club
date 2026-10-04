import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MenuPreview } from "./menu-preview";

export const metadata: Metadata = { title: "Menu preview" };

/** v5 MN-4: "Preview as member" — the shared MenuView with exactly the data members get. */
export default async function MenuPreviewPage() {
  const actor = await requireUser();
  if (!can(actor, "menu.manage")) forbidden();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Preview as member" />
      <MenuPreview />
    </div>
  );
}
