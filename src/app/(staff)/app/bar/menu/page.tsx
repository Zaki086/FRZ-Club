import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MenuManager } from "./menu-manager";

export const metadata: Metadata = { title: "Menu" };

/** v5 §1.1: the bar & café menu builder — Bar staff (menu item "Menu"), Manager and Owner (direct link). */
export default async function MenuPage() {
  const actor = await requireUser();
  if (!can(actor, "menu.manage")) forbidden();
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Menu"
        subtitle="Categories, items, photos and prices for the bar & café. A new price applies to new orders at once; items already on a tab keep their price."
      />
      <MenuManager canPrice={can(actor, "menu.price")} />
    </div>
  );
}
