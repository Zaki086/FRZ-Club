"use client";
// v3 §4.2: one employee — profile, attendance log (AT-1…AT-5), roster, cash drawer sessions, leave, payslips
// (Owner/Accountant) and activity (Owner/Manager). Sections the viewer may not see are absent, not empty.
import Link from "next/link";
import { useApi } from "@/components/api";
import { PageHeader } from "@/components/page";
import { DataState, Empty } from "@/components/states";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/badges";
import { RelTime } from "@/components/rel-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { hmm } from "@/lib/duration";
import { fmtDate, fmtDateTime, fmtDay, fmtRange, istDate, istTime } from "@/lib/time";
import { AttendanceFlags, CorrectAttendance, EditedNote, type AttRow } from "../../_components/attendance-bits";
import { ROLE_LABEL } from "../employees-list";

type Detail = {
  profile: { id: string; name: string; role: string; phone: string; email: string | null; joinDate: string; active: boolean; lastLoginAt: string | null };
  today: string;
  canCorrect: boolean;
  rules: { lateGraceMinutes: number; overtimeThresholdMinutes: number; missingClockoutHours: number };
  shifts: Array<{ id: string; date: string; startAt: string; endAt: string; area: string; status: string }>;
  attendance: AttRow[];
  drawers: Array<{ id: string; area: string; openedAt: string; closedAt: string | null; openingFloat: number; cashExpected: number | null; cashCounted: number | null; variance: number | null }>;
  leave: Array<{ id: string; type: string; startDate: string; endDate: string; days: number; status: string; reason: string; decisionNote: string | null }>;
  allowance: { CASUAL: { total: number; used: number }; SICK: { total: number; used: number } };
  payslips: Array<{ id: string; month: string; runStatus: string; gross: number; unpaidDays: number; deductions: number; net: number; paidAt: string | null }> | null;
  activity: Array<{ id: string; at: string; action: string; entity: string; entityId: string; reason: string | null }> | null;
};

export function EmployeeDetail({ id }: { id: string }) {
  const state = useApi<Detail>(`/api/staff/employees/${id}`);
  return (
    <DataState state={state}>
      {(d) => {
        const p = d.profile;
        const totals = d.attendance.reduce((a, r) => ({ worked: a.worked + (r.worked_min ?? 0), late: a.late + (r.late_min > 0 ? 1 : 0), missing: a.missing + (r.missing ? 1 : 0) }), { worked: 0, late: 0, missing: 0 });
        return (
          <div className="flex flex-col gap-4">
            <PageHeader
              title={p.name}
              meta={<>{ROLE_LABEL[p.role] ?? p.role} · {p.phone}{p.email ? ` · ${p.email}` : ""} · joined {fmtDate(p.joinDate)}{p.lastLoginAt ? <> · last login <RelTime when={p.lastLoginAt} /></> : null}</>}
              actions={<Link className="text-sm font-semibold text-primary underline" href="/app/staff/employees">All staff</Link>}
            />
            {!p.active ? <Badge tone="neutral" className="self-start">Inactive</Badge> : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="employee-summary">
              <Stat label="Worked (60 days)" value={hmm(totals.worked)} />
              <Stat label="Late arrivals (60 days)" value={String(totals.late)} />
              <Stat label="Missing clock-outs" value={String(totals.missing)} />
              <Stat label="Leave left" value={`${d.allowance.CASUAL.total - d.allowance.CASUAL.used} casual · ${d.allowance.SICK.total - d.allowance.SICK.used} sick`} />
            </div>
            <Tabs defaultValue="attendance">
              <TabsList>
                <TabsTrigger value="attendance">Attendance</TabsTrigger>
                <TabsTrigger value="roster">Roster</TabsTrigger>
                <TabsTrigger value="drawers">Cash drawers</TabsTrigger>
                <TabsTrigger value="leave">Leave</TabsTrigger>
                {d.payslips ? <TabsTrigger value="payslips">Payslips</TabsTrigger> : null}
                {d.activity ? <TabsTrigger value="activity">Activity</TabsTrigger> : null}
              </TabsList>
              <TabsContent value="attendance" className="mt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  Late after {d.rules.lateGraceMinutes} min · overtime beyond {d.rules.overtimeThresholdMinutes} min · missing clock-out {d.rules.missingClockoutHours} h after the shift. Breaks are not recorded.
                </p>
                {d.attendance.length === 0 ? <Empty title="No clock-ins in the last 60 days" /> : (
                  <Table>
                    <THead><TR><TH>Date</TH><TH>Scheduled</TH><TH>Clock-in</TH><TH>Clock-out</TH><TH className="text-right">Worked</TH><TH>Late · early · overtime</TH><TH /></TR></THead>
                    <TBody>
                      {d.attendance.map((r) => (
                        <TR key={r.id}>
                          <TD>{fmtDay(istDate(new Date(r.clock_in)))}</TD>
                          <TD>{r.sched_start && r.sched_end ? fmtRange(r.sched_start, r.sched_end) : <span className="text-muted-foreground">No shift</span>}</TD>
                          <TD className="tabular">{istTime(new Date(r.clock_in))}</TD>
                          <TD className="tabular">{r.clock_out ? istTime(new Date(r.clock_out)) : <span className="font-semibold text-warning-text">still in</span>}</TD>
                          <TD className="text-right tabular">{r.worked_min === null ? "—" : hmm(r.worked_min)}</TD>
                          <TD><AttendanceFlags r={r} /><EditedNote r={r} /></TD>
                          <TD>{d.canCorrect ? <CorrectAttendance r={r} onDone={state.reload} /> : null}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="roster" className="mt-3">
                {d.shifts.length === 0 ? <Empty title="No shifts 30 days either side of today" /> : (
                  <Table>
                    <THead><TR><TH>Date</TH><TH>Time</TH><TH>Area</TH><TH>Status</TH></TR></THead>
                    <TBody>
                      {d.shifts.map((s) => (
                        <TR key={s.id} className={s.date === d.today ? "bg-accent/20" : undefined}>
                          <TD>{fmtDay(s.date)}{s.date === d.today ? " · today" : ""}</TD>
                          <TD className="tabular">{fmtRange(s.startAt, s.endAt)}</TD>
                          <TD>{s.area.replace("_", " ").toLowerCase()}</TD>
                          <TD>{s.status === "REASSIGNED" ? <Badge tone="neutral">Given to cover (leave)</Badge> : <StatusBadge status={s.status} />}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="drawers" className="mt-3">
                {d.drawers.length === 0 ? <Empty title="No cash drawer sessions" /> : (
                  <Table>
                    <THead><TR><TH>Opened</TH><TH>Area</TH><TH>Closed</TH><TH className="text-right">Expected</TH><TH className="text-right">Counted</TH><TH className="text-right">Variance</TH></TR></THead>
                    <TBody>
                      {d.drawers.map((x) => (
                        <TR key={x.id}>
                          <TD>{fmtDateTime(x.openedAt)}</TD>
                          <TD>{x.area.toLowerCase()}</TD>
                          <TD>{x.closedAt ? fmtDateTime(x.closedAt) : <Badge tone="amber">Open</Badge>}</TD>
                          <TD className="text-right">{x.cashExpected === null ? "—" : <Money paise={x.cashExpected} />}</TD>
                          <TD className="text-right">{x.cashCounted === null ? "—" : <Money paise={x.cashCounted} />}</TD>
                          <TD className="text-right">{x.variance === null ? "—" : x.variance === 0 ? <span className="text-success-text">0</span> : <Money paise={x.variance} className="font-semibold text-destructive" />}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="leave" className="mt-3">
                {d.leave.length === 0 ? <Empty title="No leave requests" /> : (
                  <Table>
                    <THead><TR><TH>Dates</TH><TH>Type</TH><TH className="text-right">Days</TH><TH>Status</TH><TH>Reason</TH></TR></THead>
                    <TBody>
                      {d.leave.map((l) => (
                        <TR key={l.id}>
                          <TD>{fmtDate(l.startDate)} – {fmtDate(l.endDate)}</TD>
                          <TD>{l.type.toLowerCase()}</TD>
                          <TD className="text-right">{l.days}</TD>
                          <TD><StatusBadge status={l.status} /></TD>
                          <TD>{l.reason}{l.decisionNote ? <p className="text-xs text-muted-foreground">{l.decisionNote}</p> : null}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </TabsContent>
              {d.payslips ? (
                <TabsContent value="payslips" className="mt-3">
                  {d.payslips.length === 0 ? <Empty title="No payslips yet" /> : (
                    <Table>
                      <THead><TR><TH>Month</TH><TH className="text-right">Gross</TH><TH className="text-right">Unpaid days</TH><TH className="text-right">Deductions</TH><TH className="text-right">Net</TH><TH>Paid</TH></TR></THead>
                      <TBody>
                        {d.payslips.map((s) => (
                          <TR key={s.id}>
                            <TD>{s.month}</TD>
                            <TD className="text-right"><Money paise={s.gross} /></TD>
                            <TD className="text-right">{s.unpaidDays}</TD>
                            <TD className="text-right"><Money paise={s.deductions} /></TD>
                            <TD className="text-right font-semibold"><Money paise={s.net} /></TD>
                            <TD>{s.paidAt ? fmtDate(istDate(new Date(s.paidAt))) : <StatusBadge status={s.runStatus} />}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </TabsContent>
              ) : null}
              {d.activity ? (
                <TabsContent value="activity" className="mt-3">
                  {d.activity.length === 0 ? <Empty title="No recorded activity" /> : (
                    <Card>
                      <CardHeader><CardTitle>Latest 50 actions</CardTitle></CardHeader>
                      <CardContent className="divide-y p-0">
                        {d.activity.map((a) => (
                          <div key={a.id} className="flex flex-wrap justify-between gap-2 px-5 py-2 text-sm">
                            <span><span className="font-semibold">{a.action.replace(/[._]/g, " ")}</span> · {a.entity.replace(/_/g, " ")}{a.reason ? ` · ${a.reason}` : ""}</span>
                            <RelTime when={a.at} className="text-muted-foreground" />
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              ) : null}
            </Tabs>
          </div>
        );
      }}
    </DataState>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-2xl border bg-card p-3 shadow-soft">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="font-display text-2xl font-bold tabular">{value}</span>
    </div>
  );
}
