import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { MyDrawer } from "./my-drawer";

export default async function DrawerPage() {
  const actor = await requireUser();
  if (!(["checkin", "shop.counter", "bar.operate", "invoices"] as const).some((c) => can(actor, c))) forbidden();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="My cash drawer" subtitle="Open your till with the counted float; every cash payment and refund moves it at once; pay in, pay out or drop to the safe; close with a blind count." />
      <MyDrawer defaultArea={actor.role === "SHOP_STAFF" ? "SHOP" : actor.role === "BAR_STAFF" ? "BAR" : actor.role === "ACCOUNTANT" ? "OFFICE" : "DESK"} />
    </div>
  );
}
