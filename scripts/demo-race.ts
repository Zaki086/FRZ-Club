// `npm run demo:race` — fires 20 simultaneous booking requests for the same court and time at the RUNNING app
// over HTTP (§10.2, demo step 5). Exactly one must succeed; the other 19 must be rejected with SLOT_TAKEN.
const BASE = process.env.APP_URL ?? "http://localhost:3200";
const LOGIN = process.env.RACE_LOGIN ?? "desk@championsclub.example";
const PASSWORD = process.env.RACE_PASSWORD ?? process.env.SEED_STAFF_PASSWORD ?? "";
const N = Number(process.env.RACE_N ?? 20);

type Json = { data?: unknown; error?: { code: string; message: string } };

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: LOGIN, password: PASSWORD }) });
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No session cookie returned");
  return cookie;
}

type Slot = { time: string; bookable: boolean };
type Avail = { today: string; dates: Array<{ date: string; courts: Array<{ courtId: string; name: string; slots: Slot[] }> }> };

async function findFreeSlot(cookie: string) {
  for (let i = 0; i < 2; i++) {
    const date = new Date(Date.now() + 330 * 60_000 + i * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(`${BASE}/api/availability?date=${date}`, { headers: { cookie } });
    const body = (await res.json()) as { data: Avail };
    for (const c of body.data.dates[0].courts) {
      const s = c.slots.find((x) => x.bookable);
      if (s) return { courtId: c.courtId, court: c.name, date, time: s.time };
    }
  }
  throw new Error("No free slot today or tomorrow to race for.");
}

async function main() {
  const cookie = await login();
  const slot = await findFreeSlot(cookie);
  console.log(`Racing ${N} simultaneous bookings for ${slot.court} on ${slot.date} at ${slot.time} against ${BASE} …`);
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const res = await fetch(`${BASE}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": `race-${started}-${i}` },
        body: JSON.stringify({ courtId: slot.courtId, date: slot.date, startTime: slot.time, players: [{ guest: { name: `Racer ${i + 1}` } }], channel: "WALK_IN", payment: { kind: "LATER" } }),
      });
      const json = (await res.json()) as Json;
      return { i: i + 1, status: res.status, code: json.error?.code ?? "OK", message: json.error?.message ?? (json.data as { bookingCode: string }).bookingCode };
    }),
  );
  const ok = results.filter((r) => r.code === "OK");
  const taken = results.filter((r) => r.code === "SLOT_TAKEN");
  const other = results.filter((r) => r.code !== "OK" && r.code !== "SLOT_TAKEN");
  for (const r of results) console.log(`  request ${String(r.i).padStart(2)} → ${r.status} ${r.code.padEnd(10)} ${r.message}`);
  console.log(`\nResult: ${ok.length} success, ${taken.length} SLOT_TAKEN${other.length ? `, ${other.length} other` : ""} (${Date.now() - started} ms)`);
  console.log(ok.length === 1 && taken.length === N - 1 ? "PASS — the database let exactly one booking through." : "FAIL — expected exactly 1 success.");
  process.exit(ok.length === 1 && taken.length === N - 1 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
