import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current";
import { MyPaymentsView } from "./my-payments";

export const metadata: Metadata = { title: "My payments" };

export default async function MyPaymentsPage() {
  await requireUser(["MEMBER"]);
  return <MyPaymentsView />;
}
