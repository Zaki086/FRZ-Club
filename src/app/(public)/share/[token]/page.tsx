import type { Metadata } from "next";
import { ShieldX } from "lucide-react";
import { getSharedReport } from "@/server/services/reports";
import { isDomainError } from "@/server/errors";
import { ReportSummary, type ReportData } from "@/components/report-summary";
import { fmtDateTime } from "@/lib/time";

export const metadata: Metadata = { title: "Shared report", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let shared: Awaited<ReturnType<typeof getSharedReport>>;
  try {
    shared = await getSharedReport(token);
  } catch (e) {
    if (isDomainError(e) && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND")) {
      return (
        <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center">
          <ShieldX className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold">Link unavailable</h1>
          <p className="text-muted-foreground" data-testid="share-error">{e.message}</p>
        </div>
      );
    }
    throw e;
  }
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-6">
      <div className="no-print rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
        Read-only report shared by the owner of {shared.club}. This link expires {fmtDateTime(shared.expiresAt)}.
      </div>
      <ReportSummary data={shared.report as unknown as ReportData} clubName={shared.club} />
    </div>
  );
}
