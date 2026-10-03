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

type Court = { id: string; name: string; sport: string; maxPlayers: number; active: boolean };

export function CourtsTab() {
  const courts = useApi<Court[]>("/api/courts");
  const [name, setName] = useState("");
  const [sport, setSport] = useState("TENNIS");
  const [max, setMax] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Courts</CardTitle></CardHeader>
        <CardContent>
          <DataState state={courts} isEmpty={(d) => d.length === 0} empty={{ title: "No courts yet" }}>
            {(rows) => (
              <Table>
                <THead><TR><TH>Court</TH><TH>Sport</TH><TH>Max players</TH><TH>Status</TH><TH /></TR></THead>
                <TBody>
                  {rows.map((c) => (
                    <TR key={c.id}>
                      <TD className="font-medium">{c.name}</TD>
                      <TD>{c.sport}</TD>
                      <TD>{c.maxPlayers}</TD>
                      <TD>{c.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}</TD>
                      <TD className="text-right">
                        {c.active ? (
                          <ConfirmButton
                            trigger="Deactivate"
                            title={`Deactivate ${c.name}?`}
                            description="New bookings will be rejected with COURT_INACTIVE. Existing bookings stay."
                            confirmLabel="Deactivate"
                            onConfirm={async () => {
                              await api(`/api/courts/${c.id}`, { method: "PATCH", body: { active: false } });
                              await courts.reload();
                            }}
                          />
                        ) : (
                          <Button size="sm" variant="outline" onClick={async () => { await api(`/api/courts/${c.id}`, { method: "PATCH", body: { active: true } }); await courts.reload(); }}>
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
        <CardHeader><CardTitle>Add a court</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Court 5" /></Field>
          <Field label="Sport">
            <Select value={sport} onChange={(e) => setSport(e.target.value)}>
              <option value="TENNIS">Tennis</option><option value="CRICKET">Cricket</option><option value="PADEL">Padel</option><option value="BADMINTON">Badminton</option>
            </Select>
          </Field>
          <Field label="Max players" hint="Default: 4 (tennis, padel, badminton) or 6 (cricket)"><Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
          <RejectionBanner error={error} />
          <Button
            disabled={busy || name.trim().length < 1}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api("/api/courts", { body: { name, sport, maxPlayers: max ? Number(max) : undefined } });
                setName("");
                setMax("");
                await courts.reload();
              } catch (e) {
                setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Add court
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
