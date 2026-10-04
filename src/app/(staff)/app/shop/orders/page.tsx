import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { OrdersBoard } from "./orders-board";

export default async function ShopOrdersPage() {
  const actor = await requireUser();
  if (!can(actor, "shop.fulfil")) forbidden();
  return (
    <div>
      <PageHeader title="Online orders" />
      <OrdersBoard canMessage={can(actor, "messages.compose")} />
    </div>
  );
}
