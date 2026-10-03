import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { PageHeader } from "@/components/page";
import { GstReport } from "./gst-report";

export default async function GstPage() {
  const actor = await requireUser();
  if (!can(actor, "gst")) forbidden();
  return (
    <div>
      <PageHeader title="GST report" subtitle="Tax in collections for the period, by rate and category, split CGST/SGST (intra-state) and IGST (inter-state)." />
      <GstReport />
    </div>
  );
}
