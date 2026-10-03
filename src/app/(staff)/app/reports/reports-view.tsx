"use client";
import { useState } from "react";
import { Copy, Download, Link2, Printer } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm";
import { ReportSummary, type ReportData } from "@/components/report-summary";
import { fmtDateTime } from "@/lib/time";
import { PeriodPicker } from "../_dashboard/period-picker";
import { periodQuery, periodReady, type PeriodState } from "../_dashboard/types";

type Link = { id: string; token: string; reportParams: { period: string; from?: string; to?: string }; expiresAt: string; revokedAt: string | null; createdAt: string; active: boolean };

export function ReportsView({ today, clubName, perms }: { today: string; clubName: string; perms: { ledger: boolean; gst: boolean; share: boolean } }) {
  const [period, setPeriod] = useState<PeriodState>({ period: "MONTH", from: today, to: today });
  const q = periodQuery(period);
  const report = useApi<ReportData>(periodReady(period) ? `/api/reports/dashboard?${q}` : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports & sharing</h1>
          <p className="text-sm text-muted-foreground">Print or export the numbers, or share a read-only link that expires.</p>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      <div className="no-print flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </Button>
        <Button asChild variant="outline">
          <a href={`/api/reports/csv?report=dashboard&${q}`}>
            <Download className="h-4 w-4" /> Summary CSV
          </a>
        </Button>
        {perms.ledger ? (
          <Button asChild variant="outline">
            <a href={`/api/reports/csv?report=ledger&${q}`}>
              <Download className="h-4 w-4" /> Ledger CSV
            </a>
          </Button>
        ) : null}
        {perms.gst ? (
          <Button asChild variant="outline">
            <a href={`/api/reports/csv?report=gst&${q}`}>
              <Download className="h-4 w-4" /> GST CSV
            </a>
          </Button>
        ) : null}
      </div>
      <DataState state={report}>{(d) => <ReportSummary data={d} clubName={clubName} />}</DataState>
      {perms.share ? <ShareLinks period={period} /> : null}
    </div>
  );
}

function ShareLinks({ period }: { period: PeriodState }) {
  const links = useApi<Link[]>("/api/reports/share-links");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const absolute = (token: string) => `${typeof window !== "undefined" ? window.location.origin : ""}/share/${token}`;
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(absolute(token));
      setCopied(token);
    } catch {
      setCopied(null);
    }
  };
  return (
    <Card className="no-print">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" /> Read-only share links
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Expires after (days)">
            <Input className="w-28" type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Button
            disabled={busy || !periodReady(period)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ url: string }>("/api/reports/share-links", {
                  body: { period: period.period, ...(period.period === "CUSTOM" ? { from: period.from, to: period.to } : {}), days: Number(days) || undefined },
                });
                setCreated(r.url.split("/").pop() ?? null);
                await links.reload();
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Create link for this period
          </Button>
        </div>
        <RejectionBanner error={error} />
        {created ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-success/40 bg-success/10 p-2 text-sm">
            <code className="break-all">{absolute(created)}</code>
            <Button size="sm" variant="outline" onClick={() => copy(created)}>
              <Copy className="h-4 w-4" /> {copied === created ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : null}
        <DataState state={links} isEmpty={(d) => d.length === 0} empty={{ title: "No share links yet" }}>
          {(rows) => (
            <Table>
              <THead>
                <TR>
                  <TH>Created</TH>
                  <TH>Period</TH>
                  <TH>Expires</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((l) => (
                  <TR key={l.id}>
                    <TD className="text-xs">{fmtDateTime(l.createdAt)}</TD>
                    <TD className="text-xs">
                      {l.reportParams.period}
                      {l.reportParams.from ? ` ${l.reportParams.from} → ${l.reportParams.to}` : ""}
                    </TD>
                    <TD className="text-xs">{fmtDateTime(l.expiresAt)}</TD>
                    <TD>{l.revokedAt ? <Badge tone="red">Revoked</Badge> : l.active ? <Badge tone="green">Active</Badge> : <Badge tone="neutral">Expired</Badge>}</TD>
                    <TD className="flex justify-end gap-1">
                      {l.active ? (
                        <>
                          <Button size="sm" variant="outline" onClick={() => copy(l.token)}>
                            <Copy className="h-4 w-4" /> {copied === l.token ? "Copied" : "Copy"}
                          </Button>
                          <ConfirmButton
                            trigger="Revoke"
                            title="Revoke this share link?"
                            description="Anyone holding the link will no longer be able to open it."
                            confirmLabel="Revoke"
                            onConfirm={async () => {
                              await api(`/api/reports/share-links/${l.id}`, { body: {} });
                              await links.reload();
                            }}
                          />
                        </>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}
