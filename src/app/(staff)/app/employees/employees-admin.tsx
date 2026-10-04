"use client";
// v4 §1.2 Employees (Owner): every staff account with role, salary, join date and last login; edit, reset link,
// force logout, deactivate / reactivate; add a new employee. All actions go through users.ts (audited).
import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { EmailInput, PhoneInput } from "@/components/contact-inputs";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm";
import { Money } from "@/components/money";
import { ResetLinkButton } from "@/components/reset-link-button";
import { parseRupees } from "@/lib/money";
import { fmtDate } from "@/lib/time";

type Row = {
  id: string; name: string; phone: string; email: string | null; role: string; active: boolean; locked: boolean; last_login_at: string | null;
  monthly_salary: number | null; join_day: string | null; employee_id: string | null;
};

const ROLES = ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT", "KITCHEN"] as const;
const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", MANAGER: "Manager", FRONT_DESK: "Front desk", SHOP_STAFF: "Shop", BAR_STAFF: "Bar", ACCOUNTANT: "Accountant", KITCHEN: "Kitchen",
};
type Err = { code?: string; message: string } | null;
const toErr = (e: unknown): Err => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

function EditEmployee({ r, self }: { r: Row; self: boolean }) {
  const reload = useListReload();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ role: r.role, salary: r.monthly_salary === null ? "" : String(r.monthly_salary / 100), joinDate: r.join_day ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Edit</Button></DialogTrigger>
      <DialogContent title={`Edit ${r.name}`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const salary = f.salary === "" ? undefined : parseRupees(f.salary);
              if (salary === null) throw new ApiError("VALIDATION_FAILED", "Enter the salary in rupees, e.g. 25000.", 422, null);
              await api(`/api/users/${r.id}/employment`, {
                method: "PATCH",
                body: { ...(f.role !== r.role ? { role: f.role } : {}), ...(salary !== undefined ? { monthlySalary: salary } : {}), ...(f.joinDate ? { joinDate: f.joinDate } : {}) },
              });
              setOpen(false);
              reload();
            } catch (err) {
              setError(toErr(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Role">
            <Select aria-label="Role" value={f.role} disabled={self} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Monthly salary ₹"><Input inputMode="decimal" value={f.salary} onChange={(e) => setF({ ...f, salary: e.target.value })} /></Field>
            <Field label="Join date"><Input type="date" value={f.joinDate} onChange={(e) => setF({ ...f, joinDate: e.target.value })} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>Save</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Actions({ r, selfUserId }: { r: Row; selfUserId: string }) {
  const reload = useListReload();
  const self = r.id === selfUserId;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      <EditEmployee r={r} self={self} />
      {self ? <span className="self-center text-xs text-muted-foreground">you</span> : r.active ? (
        <>
          <ResetLinkButton url={`/api/users/${r.id}/reset-link`} label="Reset link" />
          <ConfirmButton
            trigger="Force logout"
            title={`Log ${r.name} out everywhere?`}
            description="Every device they are signed in on is logged out now. They can log in again with their password."
            confirmLabel="Log out everywhere"
            onConfirm={async () => { await api(`/api/users/${r.id}/logout`, { body: {} }); reload(); }}
          />
          <ConfirmButton
            trigger="Deactivate"
            title={`Deactivate ${r.name}?`}
            description="They can no longer log in. Their history, shifts and payments stay; their open leads are reassigned."
            confirmLabel="Deactivate"
            onConfirm={async () => { await api(`/api/users/${r.id}`, { method: "PATCH", body: { active: false } }); reload(); }}
          />
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={async () => { await api(`/api/users/${r.id}`, { method: "PATCH", body: { active: true } }); reload(); }}>
          Reactivate
        </Button>
      )}
    </span>
  );
}

function AddEmployee({ onAdded }: { onAdded: () => void }) {
  const blank = { name: "", phone: "", email: "", role: "FRONT_DESK", password: "", salary: "", joinDate: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <CardHeader><CardTitle>Add an employee</CardTitle></CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const salary = parseRupees(f.salary || "0");
              if (salary === null) throw new ApiError("VALIDATION_FAILED", "Enter the salary in rupees, e.g. 25000.", 422, null);
              await api("/api/users", { body: { name: f.name, phone: f.phone, email: f.email || undefined, role: f.role, password: f.password, monthlySalary: salary, joinDate: f.joinDate } });
              setF(blank);
              onAdded();
            } catch (err) {
              setError(toErr(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Name"><Input value={f.name} onChange={set("name")} /></Field>
          <Field label="Mobile" hint="10-digit Indian mobile (their login)"><PhoneInput name="phone" value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Email (optional)"><EmailInput name="email" value={f.email} onChange={set("email")} /></Field>
          <Field label="Role">
            <Select aria-label="New employee role" value={f.role} onChange={set("role")}>{ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</Select>
          </Field>
          <Field label="Initial password" hint="At least 8 characters; they can change it in My account"><Input type="password" autoComplete="new-password" value={f.password} onChange={set("password")} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Monthly salary ₹"><Input inputMode="decimal" value={f.salary} onChange={set("salary")} /></Field>
            <Field label="Join date"><Input type="date" value={f.joinDate} onChange={set("joinDate")} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button type="submit" disabled={busy}>Add employee</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function EmployeesAdmin({ selfUserId }: { selfUserId: string }) {
  // Bumped after adding someone so the list loads again with them in it.
  const [version, setVersion] = useState(0);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0" data-testid="employees-admin">
        <FilteredList<Row>
          key={version}
          list="users"
          searchPlaceholder="Name, phone or email"
          columns={[
            {
              key: "name", header: "Name", cell: (r) => (
                <span className="flex flex-col">
                  {r.employee_id ? <Link className="font-medium text-primary hover:underline" href={`/app/staff/employees/${r.employee_id}`}>{r.name}</Link> : <span className="font-medium">{r.name}</span>}
                  <span className="text-xs text-muted-foreground">{r.phone}{r.email ? ` · ${r.email}` : ""}</span>
                </span>
              ),
            },
            { key: "role", header: "Role", cell: (r) => <Badge tone="dark">{ROLE_LABEL[r.role] ?? r.role}</Badge> },
            { key: "salary", header: "Salary / month", className: "text-right", cell: (r) => (r.monthly_salary !== null ? <Money paise={r.monthly_salary} /> : "—") },
            { key: "joined", header: "Joined", cell: (r) => (r.join_day ? fmtDate(r.join_day) : "—") },
            {
              key: "status", header: "Status", cell: (r) => (
                <span className="inline-flex flex-wrap gap-1">
                  {r.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}
                  {r.locked ? <Badge tone="amber">Locked</Badge> : null}
                </span>
              ),
            },
            { key: "login", header: "Last login", cell: (r) => (r.last_login_at ? <RelTime when={r.last_login_at} className="text-xs" /> : <span className="text-xs">never</span>) },
            { key: "actions", header: "", className: "text-right", cell: (r) => <Actions r={r} selfUserId={selfUserId} /> },
          ]}
          empty={{ title: "No staff for these filters" }}
        />
      </div>
      <AddEmployee onAdded={() => setVersion((v) => v + 1)} />
    </div>
  );
}
