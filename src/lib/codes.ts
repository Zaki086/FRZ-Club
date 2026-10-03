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

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GSTIN check character (mod-36 algorithm used by the GST network) for the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** GSTIN format only: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum (IN-1). */
export function isValidGstinFormat(gstin: string): boolean {
  return /^(0[1-9]|[1-3]\d)[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
}

/** GSTIN format **and** check digit. */
export function isValidGstin(gstin: string): boolean {
  return isValidGstinFormat(gstin) && gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
}

/** UPI virtual payment address, e.g. club.name@okhdfcbank. */
export function isValidUpiVpa(vpa: string): boolean {
  return /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/.test(vpa);
}

/** UPI transaction reference (UTR / RRN): 12 characters. */
export function isValidUtr(ref: string): boolean {
  return /^[A-Za-z0-9]{12}$/.test(ref);
}

/** Card terminal approval code (4–12 letters/digits). */
export function isValidApprovalCode(code: string): boolean {
  return /^[A-Za-z0-9]{4,12}$/.test(code);
}

/** Indian PIN code (6 digits, not starting with 0). */
export function isValidPincode(pin: string): boolean {
  return /^[1-9][0-9]{5}$/.test(pin);
}

/** Two-letter badge for the club's name ("The Champions Club" → "CC"). */
export function clubInitials(name: string): string {
  return name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(the|of|and)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "C";
}
