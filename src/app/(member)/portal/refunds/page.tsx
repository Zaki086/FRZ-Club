import type { Metadata } from "next";
import { Suspense } from "react";
import { requireUser } from "@/server/auth/current";
import { MyRefundsView } from "./my-refunds";

export const metadata: Metadata = { title: "My refunds" };

export default async function MyRefundsPage() {
  await requireUser(["MEMBER"]);
  return (
    <Suspense>
      <MyRefundsView />
    </Suspense>
  );
}
