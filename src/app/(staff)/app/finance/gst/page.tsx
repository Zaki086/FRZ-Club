import Link from "next/link";
import { forbidden } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { getCapabilities } from "@/server/services/capabilities";
import { PageHeader } from "@/components/page";
import { GstReport } from "./gst-report";

export default async function GstPage() {
  const actor = await requireUser();
  if (!can(actor, "gst")) forbidden();
  const gst = (await getCapabilities()).gst;
  return (
    <div>
      <PageHeader title="GST report" />
      {gst.enabled ? (
        <GstReport />
      ) : (
        <div className="rounded-md border p-4 text-sm" data-testid="gst-off">
          GST is off for this club ({gst.reason}), so no GST is charged and there is nothing to report.{" "}
          {can(actor, "settings") ? <Link className="text-primary underline" href="/app/settings">Enter the GSTIN in Settings → Club details</Link> : null}
        </div>
      )}
    </div>
  );
}
