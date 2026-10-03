"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, RejectionBanner } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/confirm";
import { Money } from "@/components/money";
import { parseRupees } from "@/lib/money";
import { ResetLinkButton } from "@/components/reset-link-button";
import { fmtDateTime } from "@/lib/time";

type User = { id: string; name: string; phone: string; email: string | null; role: string; active: boolean; lastLoginAt: string | null; lockedUntil: string | null; employee: { monthlySalary: number; joinDate: string } | null };
const ROLES = ["OWNER", "MANAGER", "FRONT_DESK", "SHOP_STAFF", "BAR_STAFF", "ACCOUNTANT"];

export function UsersTab({ selfUserId }: { selfUserId: string }) {
  const users = useApi<User[]>("/api/users");
  const [f, setF] = useState({ name: "", phone: "", email: "", role: "FRONT_DESK", password: "", salary: "", joinDate: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader><CardTitle>Staff users</CardTitle></CardHeader>
        <CardContent>
          <DataState state={users} isEmpty={(d) => d.length === 0} empty={{ title: "No staff users" }}>
            {(rows) => (
              <Table>
                <THead><TR><TH>Name</TH><TH>Role</TH><TH>Phone / email</TH><TH>Salary</TH><TH>Status</TH><TH>Last login</TH><TH /></TR></THead>
                <TBody>
                  {rows.map((u) => (
                    <TR key={u.id}>
                      <TD className="font-medium">{u.name}</TD>
                      <TD><Badge tone="dark">{u.role.replace("_", " ")}</Badge></TD>
                      <TD className="text-xs">{u.phone}<br />{u.email ?? ""}</TD>
                      <TD>{u.employee ? <Money paise={u.employee.monthlySalary} /> : "—"}</TD>
                      <TD>{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}{u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now() ? <Badge tone="amber">Locked</Badge> : null}</TD>
                      <TD className="text-xs">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "never"}</TD>
                      <TD className="text-right">
                        {u.id === selfUserId ? (
                          <span className="text-xs text-muted-foreground">you</span>
                        ) : u.active ? (
                          <span className="inline-flex flex-wrap justify-end gap-1">
                          <ResetLinkButton url={`/api/users/${u.id}/reset-link`} label="Reset link" />
                          <ConfirmButton
                            trigger="Deactivate"
                            title={`Deactivate ${u.name}?`}
                            description="They can no longer log in. Their history, shifts and payments stay."
                            confirmLabel="Deactivate"
                            onConfirm={async () => {
                              await api(`/api/users/${u.id}`, { method: "PATCH", body: { active: false } });
                              await users.reload();
                            }}
                          />
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={async () => { await api(`/api/users/${u.id}`, { method: "PATCH", body: { active: true } }); await users.reload(); }}>
                            Activate
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </DataState>
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
                await users.reload();
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
