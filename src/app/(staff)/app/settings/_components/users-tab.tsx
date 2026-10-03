"use client";
// v3 §3.2: staff users as a filtered list (role, active, has logged in, locked); add / activate / reset link as before.
import { useState } from "react";
import { api, ApiError } from "@/components/api";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { RelTime } from "@/components/rel-time";
import { RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm";
import { Money } from "@/components/money";
import { parseRupees } from "@/lib/money";
import { ResetLinkButton } from "@/components/reset-link-button";

type UserRow = {
  id: string; name: string; phone: string; email: string | null; role: string; active: boolean; locked: boolean; last_login_at: string | null;
  monthly_salary: number | null; join_day: string | null;
};
const ROLES = ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT"];

function UserActions({ u, selfUserId }: { u: UserRow; selfUserId: string }) {
  const reload = useListReload();
  if (u.id === selfUserId) return <span className="text-xs text-muted-foreground">you</span>;
  if (!u.active) {
    return (
      <Button size="sm" variant="outline" onClick={async () => { await api(`/api/users/${u.id}`, { method: "PATCH", body: { active: true } }); reload(); }}>
        Activate
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      <ResetLinkButton url={`/api/users/${u.id}/reset-link`} label="Reset link" />
      <ConfirmButton
        trigger="Deactivate"
        title={`Deactivate ${u.name}?`}
        description="They can no longer log in. Their history, shifts and payments stay."
        confirmLabel="Deactivate"
        onConfirm={async () => {
          await api(`/api/users/${u.id}`, { method: "PATCH", body: { active: false } });
          reload();
        }}
      />
    </span>
  );
}

export function UsersTab({ selfUserId }: { selfUserId: string }) {
  // Bumped after adding a user so the list loads again with the new person in it.
  const [version, setVersion] = useState(0);
  const [f, setF] = useState({ name: "", phone: "", email: "", role: "FRONT_DESK", password: "", salary: "", joinDate: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader><CardTitle>Staff users</CardTitle></CardHeader>
        <CardContent>
          <FilteredList<UserRow>
            key={version}
            list="users"
            searchPlaceholder="Name, phone or email"
            columns={[
              { key: "name", header: "Name", cell: (u) => <span className="font-medium">{u.name}</span> },
              { key: "role", header: "Role", cell: (u) => <Badge tone="dark">{u.role.replace("_", " ")}</Badge> },
              { key: "contact", header: "Phone / email", cell: (u) => <span className="text-xs">{u.phone}<br />{u.email ?? ""}</span> },
              { key: "salary", header: "Salary", className: "text-right", cell: (u) => (u.monthly_salary !== null ? <Money paise={u.monthly_salary} /> : "—") },
              {
                key: "status", header: "Status", cell: (u) => (
                  <span className="inline-flex flex-wrap gap-1">
                    {u.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}
                    {u.locked ? <Badge tone="amber">Locked</Badge> : null}
                  </span>
                ),
              },
              { key: "login", header: "Last login", cell: (u) => (u.last_login_at ? <RelTime when={u.last_login_at} className="text-xs" /> : <span className="text-xs">never</span>) },
              { key: "actions", header: "", className: "text-right", cell: (u) => <span onClick={(e) => e.stopPropagation()}><UserActions u={u} selfUserId={selfUserId} /></span> },
            ]}
            empty={{ title: "No staff users for these filters", hint: "Remove a filter to see everyone." }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Add a staff user</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field label="Name"><Input value={f.name} onChange={set("name")} /></Field>
          <Field label="Mobile" hint="10-digit Indian mobile (login)"><Input inputMode="tel" value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Email (optional)"><Input type="email" value={f.email} onChange={set("email")} /></Field>
          <Field label="Role">
            <Select value={f.role} onChange={set("role")}>{ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}</Select>
          </Field>
          <Field label="Initial password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" value={f.password} onChange={set("password")} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Monthly salary ₹"><Input inputMode="decimal" value={f.salary} onChange={set("salary")} /></Field>
            <Field label="Join date"><Input type="date" value={f.joinDate} onChange={set("joinDate")} /></Field>
          </div>
          <RejectionBanner error={error} />
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const salary = parseRupees(f.salary || "0");
                if (salary === null) throw new ApiError("VALIDATION_FAILED", "Enter the salary in rupees, e.g. 25000.", 422, null);
                await api("/api/users", { body: { name: f.name, phone: f.phone, email: f.email || undefined, role: f.role, password: f.password, monthlySalary: salary, joinDate: f.joinDate } });
                setF({ name: "", phone: "", email: "", role: "FRONT_DESK", password: "", salary: "", joinDate: "" });
                setVersion((v) => v + 1);
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Add user
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
