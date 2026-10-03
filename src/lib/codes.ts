// Human-readable codes (plan §2). The numbers come from Postgres sequences; these only format them.

export const CODE_PREFIX = {
  member: "CC",
  booking: "BK",
  shopOrder: "SO",
  counterSale: "CS",
  tab: "TB",
  lead: "LD",
  serviceTicket: "ST",
} as const;

export type CodeKind = keyof typeof CODE_PREFIX;

export const CODE_SEQUENCE: Record<CodeKind, string> = {
  member: "member_code_seq",
  booking: "booking_code_seq",
  shopOrder: "shop_order_code_seq",
  counterSale: "counter_sale_code_seq",
  tab: "tab_code_seq",
  lead: "lead_code_seq",
  serviceTicket: "service_ticket_code_seq",
};

export function formatCode(kind: CodeKind, n: number): string {
  return `${CODE_PREFIX[kind]}-${String(n).padStart(6, "0")}`;
}

/** Invoice number per financial-year sequence: CC/2026-27/00042 */
export function formatInvoiceNumber(fy: string, seq: number): string {
  return `CC/${fy}/${String(seq).padStart(5, "0")}`;
}

/** Indian 10-digit mobile number (MB-1). */
export function isIndianMobile(phone: string): boolean {
  return /^[6-9]\d{9}$/.test(phone);
}

/** Normalise "+91 98765 43210" / "098765-43210" to "9876543210". */
export function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** GSTIN: 15 chars — 2-digit state code, 10-char PAN, entity digit, 'Z', checksum (IN-1). */
export function isValidGstin(gstin: string): boolean {
  return /^(0[1-9]|[1-3]\d)[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
}
