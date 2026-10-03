// Money is integer paise everywhere (plan §2). Never floats.

/** Integer division n/d rounded half-up (away from zero for negatives). d must be > 0. */
export function roundDiv(n: number, d: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(d) || d <= 0) {
    throw new Error(`roundDiv expects integers with d > 0 (got ${n}/${d})`);
  }
  const sign = n < 0 ? -1 : 1;
  return sign * Math.floor((2 * Math.abs(n) + d) / (2 * d));
}

/** Amount × pct / 100, half-up. */
export function percentOf(amount: number, pct: number): number {
  return roundDiv(amount * pct, 100);
}

/** GST is included in the price: tax = round(net × rate / (100 + rate)) — plan §2. */
export function inclusiveTax(net: number, ratePct: number): number {
  if (ratePct <= 0) return 0;
  return roundDiv(net * ratePct, 100 + ratePct);
}

export function rupees(r: number): number {
  return Math.round(r * 100);
}

/** ₹ with Indian digit grouping: ₹1,23,456 or ₹1,23,456.50 */
export function formatINR(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = new Intl.NumberFormat("en-IN").format(whole);
  return `${negative ? "−" : ""}₹${grouped}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
}

/** Parse a rupee string from a form ("1,250.50") into paise. Returns null when invalid. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
}
