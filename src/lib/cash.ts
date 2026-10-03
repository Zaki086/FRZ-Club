// v4 §2.3: cash counted by denomination (pure helpers shared by the count screens, the seed and tests).

export type Denominations = { notes: number[]; coins: number[] };
export type DenominationCount = { kind: "NOTE" | "COIN"; value: number; count: number };

export const DEFAULT_DENOMINATIONS: Denominations = { notes: [50000, 20000, 10000, 5000, 2000, 1000], coins: [2000, 1000, 500, 200, 100] };

/** The fewest notes and coins that make `paise` (whole rupees; any paise are left out). Notes before coins of equal value. */
export function breakdownCounts(paise: number, d: Denominations = DEFAULT_DENOMINATIONS): DenominationCount[] {
  let left = Math.floor(Math.max(0, paise) / 100) * 100;
  const all = [...d.notes.map((v) => ({ kind: "NOTE" as const, value: v })), ...d.coins.map((v) => ({ kind: "COIN" as const, value: v }))]
    .sort((a, b) => b.value - a.value || (a.kind === "NOTE" ? -1 : 1));
  const out: DenominationCount[] = [];
  for (const x of all) {
    const n = Math.floor(left / x.value);
    if (n > 0) {
      out.push({ ...x, count: n });
      left -= n * x.value;
    }
  }
  return out;
}

export const countTotal = (counts: DenominationCount[]) => counts.reduce((a, c) => a + c.value * c.count, 0);
