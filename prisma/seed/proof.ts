// Sample payment proof for the demo history: every UPI payment carries a 12-character UTR and every card payment
// an approval code + last 4 digits, exactly as staff enter them at the counter (completion pass §2).
let utrSeq = 0;
let authSeq = 0;
let last4 = 1000;

export const sampleUtr = () => String(512_000_000_000 + ++utrSeq);
export const sampleCardProof = () => ({ cardLast4: String((last4 = ((last4 * 7 + 13) % 9000) + 1000)), approvalCode: `S${String(++authSeq).padStart(5, "0")}` });

export type CounterMethod = "CASH" | "UPI" | "CARD";

/** A counter tender for `method` with the proof that method needs. */
export function tender<M extends CounterMethod>(method: M) {
  if (method === "UPI") return { method, reference: sampleUtr() } as const;
  if (method === "CARD") return { method, ...sampleCardProof() } as const;
  return { method } as const;
}
