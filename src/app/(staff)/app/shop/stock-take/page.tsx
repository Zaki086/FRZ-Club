import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { StockTakeSheet } from "./stock-take-sheet";

export const metadata: Metadata = { title: "Stock take" };

export default async function StockTakePage() {
  const actor = await requireUser();
  if (!can(actor, "shop.stock")) forbidden();
  return (
    <div>
      <PageHeader title="Stock take" subtitle="Count what is on the shelf. Leave a row empty to skip it; differences are posted as stock adjustments." />
      <StockTakeSheet />
    </div>
  );
}
