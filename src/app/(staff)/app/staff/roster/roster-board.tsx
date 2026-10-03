"use client";
// The week board and "Attendance & cash" are unchanged; the List tab is the roster as a v3 §3.2 filtered list.
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm";
import { Money } from "@/components/money";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { hmm } from "@/lib/duration";
import { addDays, fmtDateTime, fmtDay, fmtRange } from "@/lib/time";
import { cn } from "@/components/ui/cn";

type Shift = { id: string; employeeId: string | null; previousEmployeeId: string | null; date: string; start: string; end: string; area: string; status: "ASSIGNED" | "OPEN"; name: string | null };
type Roster = { from: string; to: string; days: string[]; employees: Array<{ id: string; name: string; role: string }>; shifts: Shift[]; leave: Array<{ employeeId: string; startDate: string; endDate: string; type: string }> };
type Employee = { id: string; name: string; role: string };
type Att = { id: string; name: string; role: string | null; clockIn: string; clockOut: string | null; openingFloat: number; cashExpected: number | null; cashCounted: number | null; variance: number | null };
type Rejection = { code?: string; message: string } | null;
const rej = (e: unknown) => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
const AREAS = ["FRONT_DESK", "BAR", "KITCHEN", "SHOP", "COURTS"] as const;
const AREA_TONE: Record<string, "blue" | "purple" | "amber" | "green" | "neutral"> = { FRONT_DESK: "blue", BAR: "purple", KITCHEN: "amber", SHOP: "green", COURTS: "neutral" };

function AssignDialog({ employees, defaults, onDone }: { employees: Employee[]; defaults?: { employeeId?: string; date?: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ employeeId: defaults?.employeeId ?? "", date: defaults?.date ?? "", startTime: "09:00", endTime: "17:00", area: "FRONT_DESK" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild>
        {defaults?.date ? (
          <button type="button" className="w-full rounded border border-dashed px-1 py-0.5 text-xs text-muted-foreground opacity-0 hover:opacity-100 focus:opacity-100 group-hover:opacity-100" aria-label="Add shift">+</button>
        ) : (
          <Button><Plus className="h-4 w-4" /> Assign shift</Button>
        )}
      </DialogTrigger>
      <DialogContent title="Assign a shift">
        <div className="flex flex-col gap-3">
          <Field label="Employee">
            <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
              <option value="">Choose…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.role.replace("_", " ").toLowerCase()}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="Start"><Input type="time" step={1800} value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
            <Field label="End"><Input type="time" step={1800} value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
          </div>
          <Field label="Area">
            <Select value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })}>
              {AREAS.map((a) => <option key={a} value={a}>{a.replace("_", " ")}</option>)}
            </Select>
          </Field>
          <RejectionBanner error={error} />
          <Button disabled={busy || !f.employeeId || !f.date} onClick={async () => {
            setBusy(true); setError(null);
            try { await api("/api/staff/roster", { body: f }); setOpen(false); onDone(); }
            catch (e) { setError(rej(e)); }
            finally { setBusy(false); }
          }}>Assign</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FillShift({ shift, employees, onDone }: { shift: Pick<Shift, "id">; employees: Employee[]; onDone: () => void }) {
  const [emp, setEmp] = useState("");
  const [error, setError] = useState<Rejection>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Select className="h-8 text-xs" value={emp} onChange={(e) => setEmp(e.target.value)} aria-label="Employee to fill">
          <option value="">Choose staff…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </Select>
        <Button size="sm" disabled={!emp} onClick={async () => {
          setError(null);
          try { await api(`/api/staff/shifts/${shift.id}/fill`, { body: { employeeId: emp } }); onDone(); }
          catch (e) { setError(rej(e)); }
        }}>Fill</Button>
      </div>
      <RejectionBanner error={error} />
    </div>
  );
}

function Attendance() {
  const state = useApi<Att[]>("/api/staff/attendance");
  return (
    <DataState state={state} isEmpty={(d) => d.length === 0} empty={{ title: "No attendance in the last 7 days" }}>
      {(rows) => (
        <Table>
          <THead><TR><TH>Staff</TH><TH>In</TH><TH>Out</TH><TH>Float</TH><TH>Expected</TH><TH>Counted</TH><TH>Variance</TH></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id}>
                <TD>{a.name} <span className="text-xs text-muted-foreground">{a.role?.replace("_", " ").toLowerCase()}</span></TD>
                <TD>{fmtDateTime(a.clockIn)}</TD>
                <TD>{a.clockOut ? fmtDateTime(a.clockOut) : <Badge tone="green">on shift</Badge>}</TD>
                <TD><Money paise={a.openingFloat} /></TD>
                <TD>{a.cashExpected !== null ? <Money paise={a.cashExpected} /> : "—"}</TD>
                <TD>{a.cashCounted !== null ? <Money paise={a.cashCounted} /> : "—"}</TD>
                <TD>{a.variance !== null ? <Money paise={a.variance} className={a.variance !== 0 ? "font-semibold" : ""} /> : "—"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </DataState>
  );
}

type ShiftRow = {
  id: string; day: string; start_at: string; end_at: string; area: string; status: "ASSIGNED" | "OPEN"; employee_id: string | null;
  name: string | null; role: string | null; previous_name: string | null; minutes: number; leave_type: string | null;
};

function ShiftNext({ r, employees }: { r: ShiftRow; employees: Employee[] }) {
  const reload = useListReload();
  if (r.status === "OPEN") return <FillShift shift={r} employees={employees} onDone={reload} />;
  return (
    <ConfirmButton
      trigger="Unassign"
      size="sm"
      title="Unassign this shift?"
      description={`${r.name ?? ""} · ${fmtDay(r.day)} ${fmtRange(r.start_at, r.end_at)}. It stays on the roster as an OPEN shift.`}
      confirmLabel="Unassign"
      onConfirm={async () => { await api(`/api/staff/shifts/${r.id}/unassign`, { body: {} }); reload(); }}
    />
  );
}

function ShiftsList({ employees }: { employees: Employee[] }) {
  return (
    <FilteredList<ShiftRow>
      list="shifts"
      searchPlaceholder="Employee name"
      columns={[
        {
          key: "day", header: "Day", cell: (r) => (
            <span className="flex flex-col">
              <span className="whitespace-nowrap font-medium">{fmtDay(r.day)}</span>
              <RelTime when={r.day} className="text-xs text-muted-foreground" />
            </span>
          ),
        },
        { key: "time", header: "Time", cell: (r) => <span className="tabular whitespace-nowrap">{fmtRange(r.start_at, r.end_at)}</span> },
        { key: "hours", header: "Hours", className: "text-right", cell: (r) => <span className="tabular">{hmm(r.minutes)}</span> },
        { key: "area", header: "Area", cell: (r) => <Badge tone={AREA_TONE[r.area]}>{r.area.replace("_", " ")}</Badge> },
        {
          key: "who", header: "Staff", cell: (r) =>
            r.status === "OPEN" ? (
              <span className="flex flex-col items-start gap-0.5">
                <Badge tone="amber">Open</Badge>
                {r.previous_name ? <span className="text-xs text-muted-foreground">was {r.previous_name}{r.leave_type ? ` (${r.leave_type.toLowerCase()} leave)` : ""}</span> : null}
              </span>
            ) : (
              <span className="flex flex-col">
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-muted-foreground">{r.role?.replace(/_/g, " ").toLowerCase()}</span>
              </span>
            ),
        },
        { key: "next", header: "", cell: (r) => <span onClick={(e) => e.stopPropagation()}><ShiftNext r={r} employees={employees} /></span> },
      ]}
      empty={{ title: "No shifts for these filters", hint: "Widen the dates or remove a filter. Assign shifts from the Roster tab." }}
    />
  );
}

type Tab = "roster" | "attendance" | "list";

export function RosterBoard({ initialFrom, initialTab }: { initialFrom: string; initialTab: Tab }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // The List tab keeps its filters in the address bar; the other tabs keep only `?tab=attendance` (linked from
  // notifications). Switching tabs swaps one for the other so the list never sees a parameter it doesn't know.
  const [from, setFrom] = useState(initialFrom);
  const state = useApi<Roster>(`/api/staff/roster?from=${from}&days=7`);
  const changeTab = (t: string) => {
    router.replace(t === "attendance" ? `${pathname}?tab=attendance` : pathname, { scroll: false });
    if (t === "roster") void state.reload(); // shifts filled or unassigned from the list show on the board
  };
  const emps = useApi<Employee[]>("/api/staff/employees");
  const reload = () => void state.reload();
  const employees = emps.data ?? [];
  return (
    <Tabs defaultValue={initialTab} onValueChange={changeTab}>
      <TabsList>
        <TabsTrigger value="roster">Roster</TabsTrigger>
        <TabsTrigger value="attendance">Attendance & cash</TabsTrigger>
        <TabsTrigger value="list">List</TabsTrigger>
      </TabsList>
      <TabsContent value="roster" className="mt-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setFrom(addDays(from, -7))}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium">{fmtDay(from)} – {fmtDay(addDays(from, 6))}</span>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setFrom(addDays(from, 7))}><ChevronRight className="h-4 w-4" /></Button>
          <div className="ml-auto"><AssignDialog employees={employees} onDone={reload} /></div>
        </div>
        <DataState state={state}>
          {(r) => {
            const open = r.shifts.filter((s) => s.status === "OPEN");
            const onLeave = (empId: string, day: string) => r.leave.find((l) => l.employeeId === empId && l.startDate <= day && l.endDate >= day);
            return (
              <>
                {open.length ? (
                  <Card className="border-amber-300">
                    <CardHeader><CardTitle>Open shifts needing cover ({open.length})</CardTitle></CardHeader>
                    <CardContent className="divide-y">
                      {open.map((s) => (
                        <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                          <span>{fmtDay(s.date)} {s.start}–{s.end} · <Badge tone={AREA_TONE[s.area]}>{s.area.replace("_", " ")}</Badge>{s.name ? <span className="text-muted-foreground"> (was {s.name})</span> : null}</span>
                          <FillShift shift={s} employees={employees} onDone={reload} />
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}
                <Card className="overflow-x-auto">
                  {r.employees.length === 0 ? <Empty title="No active employees" /> : (
                    <table className="w-full min-w-[900px] text-sm">
                      <thead className="border-b bg-muted/60 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-2 py-2 text-left">Staff</th>
                          {r.days.map((d) => <th key={d} className="px-2 py-2 text-left">{fmtDay(d)}</th>)}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {r.employees.map((e) => (
                          <tr key={e.id}>
                            <td className="px-2 py-2 align-top">
                              <p className="font-medium">{e.name}</p>
                              <p className="text-xs text-muted-foreground">{e.role.replace("_", " ").toLowerCase()}</p>
                            </td>
                            {r.days.map((d) => {
                              const lv = onLeave(e.id, d);
                              const shifts = r.shifts.filter((s) => s.employeeId === e.id && s.date === d && s.status === "ASSIGNED");
                              return (
                                <td key={d} className={cn("group px-1 py-1 align-top", lv && "bg-[repeating-linear-gradient(45deg,#fef3c7,#fef3c7_6px,#fff_6px,#fff_12px)]")}>
                                  {lv ? <p className="text-[11px] font-semibold text-amber-800">{lv.type.toLowerCase()} leave</p> : null}
                                  <div className="flex flex-col gap-1">
                                    {shifts.map((s) => (
                                      <div key={s.id} className="rounded border bg-card p-1 text-xs">
                                        <p className="font-medium">{s.start}–{s.end}</p>
                                        <div className="flex items-center justify-between gap-1">
                                          <Badge tone={AREA_TONE[s.area]}>{s.area.replace("_", " ")}</Badge>
                                          <ConfirmButton
                                            trigger="×"
                                            title="Unassign this shift?"
                                            description={`${e.name} · ${fmtDay(d)} ${s.start}–${s.end}. It stays on the roster as an OPEN shift.`}
                                            confirmLabel="Unassign"
                                            onConfirm={async () => { await api(`/api/staff/shifts/${s.id}/unassign`, { body: {} }); reload(); }}
                                          />
                                        </div>
                                      </div>
                                    ))}
                                    {!lv ? <AssignDialog employees={employees} defaults={{ employeeId: e.id, date: d }} onDone={reload} /> : null}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </>
            );
          }}
        </DataState>
      </TabsContent>
      <TabsContent value="attendance" className="mt-3">
        <Card><CardContent className="pt-4"><Attendance /></CardContent></Card>
      </TabsContent>
      <TabsContent value="list" className="mt-3">
        {search.has("tab") ? null : <ShiftsList employees={employees} />}
      </TabsContent>
    </Tabs>
  );
}
