import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MyDrawer } from "./my-drawer";

export default async function DrawerPage() {
  const actor = await requireUser();
  if (!(["checkin", "shop.counter", "bar.operate", "invoices"] as const).some((c) => can(actor, c))) forbidden();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My cash drawer" subtitle="Open it with the starting float before taking payments; close it with the counted cash at the end of your shift." />
      <MyDrawer />
    </div>
  );
}
