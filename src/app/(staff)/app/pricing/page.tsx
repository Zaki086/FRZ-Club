import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { PriceBook } from "./price-book";

export const metadata: Metadata = { title: "Price book" };

export default async function PricingPage() {
  const actor = await requireUser();
  if (!can(actor, "pricing.manage")) forbidden();
  return (
    <div>
      <PageHeader title="Price book" subtitle="Base prices, time bands, special dates and promotions. Every change starts now or at a time you choose, is kept in the history, and never changes a bill already made." />
      <PriceBook />
    </div>
  );
}
