/** v3 AT-1: a number of minutes shown as h:mm (e.g. 485 → "8:05"). Empty for no value. */
export function hmm(min: number | null | undefined): string {
  if (min === null || min === undefined) return "";
  const sign = min < 0 ? "-" : "";
  const m = Math.abs(Math.round(min));
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
