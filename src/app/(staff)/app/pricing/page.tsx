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
      <PageHeader title="Price book" />
      <PriceBook />
    </div>
  );
}
