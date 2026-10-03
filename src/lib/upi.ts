// UPI deep link for counter QR payments (E-14). Pure — safe in the browser.
export function upiLink(opts: { vpa: string; payee: string; amountPaise: number; note: string }): string {
  const am = (opts.amountPaise / 100).toFixed(2);
  const q = new URLSearchParams({ pa: opts.vpa, pn: opts.payee, am, cu: "INR", tn: opts.note });
  return `upi://pay?${q.toString()}`;
}
