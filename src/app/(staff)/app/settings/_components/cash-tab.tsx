"use client";
// v4 §2 (Owner): the club's tills (name, location, default float, in use), the cash denominations counted at open and
// close, the blind close (CD-5) and the variance tolerance (CD-6).
import { useState } from "react";
import { api, useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { InfoField } from "@/components/info-tip";
import { formatINR } from "@/lib/money";
import { assertNumbers, fromRupeeText, putSetting, SaveBar, toRupeeText, type SettingRow } from "./shared";

type Till = { id: string; name: string; location: string; defaultFloat: number; active: boolean; openSession: { userName: string } | null };
const LOCATIONS: Array<[string, string]> = [["FRONT_DESK", "Front desk"], ["SHOP", "Shop"], ["BAR", "Bar"], ["OFFICE", "Office"]];

function TillRow({ t, onSaved }: { t: Till; onSaved: () => void }) {
  const [name, setName] = useState(t.name);
  const [location, setLocation] = useState(t.location);
  const [float, setFloat] = useState(toRupeeText(t.defaultFloat));
  const [active, setActive] = useState(t.active);
  return (
    <TR>
      <TD><Input className="h-8" value={name} onChange={(e) => setName(e.target.value)} aria-label={`Name of ${t.name}`} /></TD>
      <TD>
        <Select className="h-8" value={location} onChange={(e) => setLocation(e.target.value)} aria-label={`Location of ${t.name}`}>
          {LOCATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </TD>
      <TD><Input className="h-8 w-28" inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} aria-label={`Default float of ${t.name}`} /></TD>
      <TD>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use</label>
        {t.openSession ? <Badge tone="green">open by {t.openSession.userName}</Badge> : null}
      </TD>
      <TD>
        <SaveBar onSave={async () => {
          const defaultFloat = fromRupeeText(float);
          assertNumbers({ "default float": defaultFloat });
          await api(`/api/drawer/tills/${t.id}`, { method: "PATCH", body: { name, location, defaultFloat, active } });
          onSaved();
        }} />
      </TD>
    </TR>
  );
}

export function CashTab({ rows, onSaved }: { rows: SettingRow[]; onSaved: () => void }) {
  const tills = useApi<Till[]>("/api/drawer/tills?all=1");
  const den = (rows.find((r) => r.key === "cash_denominations")?.value ?? { notes: [50000, 20000, 10000, 5000, 2000, 1000], coins: [2000, 1000, 500, 200, 100] }) as { notes: number[]; coins: number[] };
  const blind = (rows.find((r) => r.key === "blind_close")?.value ?? true) as boolean;
  const tol = (rows.find((r) => r.key === "drawer_variance_tolerance")?.value ?? 5000) as number;
  const [notes, setNotes] = useState(den.notes.map((v) => v / 100).join(", "));
  const [coins, setCoins] = useState(den.coins.map((v) => v / 100).join(", "));
  const [blindClose, setBlindClose] = useState(blind);
  const [tolerance, setTolerance] = useState(toRupeeText(tol));
  const [name, setName] = useState("");
  const [location, setLocation] = useState("FRONT_DESK");
  const [float, setFloat] = useState("");
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => fromRupeeText(x));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Tills</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <DataState state={tills}>
            {(ts) => (
              <Table>
                <THead><TR><TH>Name</TH><TH>Location</TH><TH>Default float ₹</TH><TH>Status</TH><TH /></TR></THead>
                <TBody>{ts.map((t) => <TillRow key={t.id} t={t} onSaved={() => void tills.reload()} />)}</TBody>
              </Table>
            )}
          </DataState>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="New till name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Front Desk Till 2" /></Field>
            <Field label="Location">
              <Select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="New till location">
                {LOCATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Default float ₹"><Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
          </div>
          <SaveBar label="Add till" onSave={async () => {
            const defaultFloat = float ? fromRupeeText(float) : 0;
            assertNumbers({ "default float": defaultFloat });
            await api("/api/drawer/tills", { body: { name, location, defaultFloat } });
            setName(""); setFloat("");
            await tills.reload();
          }} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Counting and closing</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <Field label="Notes counted (₹, comma-separated)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <Field label="Coins counted (₹, comma-separated)"><Input value={coins} onChange={(e) => setCoins(e.target.value)} /></Field>
          <label className="flex items-center gap-2"><input type="checkbox" checked={blindClose} onChange={(e) => setBlindClose(e.target.checked)} /> Blind close: staff count without seeing the expected amount</label>
          <InfoField label="Variance tolerance ₹" place="variance-tolerance" infoLabel="About the variance tolerance"
            info={`A closing count that differs from the expected cash by more than this (now ${formatINR(tol)}) needs a reason and a Manager's or the Owner's approval before the drawer is settled.`}>
            <Input inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
          </InfoField>
          <SaveBar onSave={async () => {
            const n = list(notes);
            const c = list(coins);
            const t = fromRupeeText(tolerance);
            assertNumbers({ ...Object.fromEntries(n.map((v, i) => [`note ${i + 1}`, v])), ...Object.fromEntries(c.map((v, i) => [`coin ${i + 1}`, v])), tolerance: t });
            await putSetting("cash_denominations", { notes: n, coins: c });
            await putSetting("blind_close", blindClose);
            await putSetting("drawer_variance_tolerance", t);
            onSaved();
          }} />
        </CardContent>
      </Card>
    </div>
  );
}
