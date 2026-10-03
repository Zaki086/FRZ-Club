import { requireUser } from "@/server/auth/current";
import { MyTabs } from "./my-tabs";

export default async function PortalTabPage() {
  await requireUser(["MEMBER"]);
  return <MyTabs />;
}
