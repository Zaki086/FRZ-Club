import type { Metadata } from "next";
import { Suspense } from "react";
import { requireUser } from "@/server/auth/current";
import { BarCafe } from "./bar-cafe";

export const metadata: Metadata = { title: "Bar & Café" };

// v5 §1.2 (ORDER): the member portal's "Bar & Café" — the menu with the member's prices, a cart, and "My tab".
export default async function PortalBarPage() {
  await requireUser(["MEMBER"]);
  return (
    <Suspense>
      <BarCafe />
    </Suspense>
  );
}
