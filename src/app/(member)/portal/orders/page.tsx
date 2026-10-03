import { requireUser } from "@/server/auth/current";
import { MyOrders } from "./my-orders";

export default async function PortalOrdersPage() {
  await requireUser(["MEMBER"]);
  return <MyOrders />;
}
