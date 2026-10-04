// Error model (plan §2, §5.18). Services throw DomainError; the API maps it to
// { error: { code, message, details } } with 409 (rule), 403 (forbidden), 422 (validation).

export const REJECTION_CODES = [
  "INVALID_SLOT",
  "IN_PAST",
  "COURT_INACTIVE",
  "PLAYERS_INVALID",
  "OUTSIDE_BOOKING_WINDOW",
  "DAILY_LIMIT_REACHED",
  "PLAYER_TIME_CONFLICT",
  "SLOT_TAKEN",
  "SESSION_FULL",
  "PAYMENT_DUE",
  "CANCEL_NOT_ALLOWED",
  "JUNIOR_AGE_INELIGIBLE",
  "MEMBERSHIP_CONFLICT",
  "INVALID_MEMBER_CARD",
  "INSUFFICIENT_STOCK",
  "ORDER_STATE_INVALID",
  "ALCOHOL_NOT_ALLOWED",
  "TAB_HAS_BALANCE",
  "TAB_ALREADY_OPEN",
  "OVERPAYMENT",
  "REFUND_EXCEEDS_PAID",
  // v3 §5.2 refund workflow.
  "REFUND_NOT_ELIGIBLE",
  "GATEWAY_REFUND_FAILED",
  // v3 §9.2/§9.3 price book and products.
  "PRICE_BAND_OVERLAP",
  "PRODUCT_HAS_RESERVATIONS",
  "TRIAL_ALREADY_USED",
  "LEAVE_CONFLICT",
  "LEAVE_DATE_IN_PAST",
  "LEAVE_OVERLAP",
  "LEAVE_BALANCE_EXCEEDED",
  "SHIFT_OVERLAP",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "IDEMPOTENCY_CONFLICT",
  // Completion pass (DECISIONS D-26…): a feature that is not configured, too many attempts, no open drawer.
  "CAPABILITY_DISABLED",
  "RATE_LIMITED",
  "DRAWER_NOT_OPEN",
  // v4 §2 Cash Drawer v2 (CD-4, RF-9).
  "INSUFFICIENT_CHANGE",
  "INSUFFICIENT_CASH_IN_DRAWER",
  "DRAWER_IN_USE",
  // v4 §3 Refunds v2 (RF-8, RF-9): pay-out needs the identity check; a refund QR must be authentic.
  "IDENTITY_NOT_CHECKED",
  "INVALID_REFUND_QR",
  // v4 §5.3 signed action links (/r/<token>): forged, past the deadline, or already used.
  "LINK_INVALID",
  "LINK_EXPIRED",
  "LINK_USED",
  // v5 §1.3 (ORDER) member bar orders: MO-1 not at the club (no table scan / check-in), MO-5 tab limit.
  "NOT_AT_CLUB",
  "TAB_LIMIT_REACHED",
  // v5 §2.2 (VALID) contact validation: a phone / email already on another member or account (CV-6).
  "PHONE_ALREADY_REGISTERED",
  "EMAIL_ALREADY_REGISTERED",
  // v5 §3 (MSGCORE) message templates: MT-1 a variable the context doesn't have; the same template to the same person
  // within 24 h (confirm to send again); a channel that isn't available or the recipient can't receive.
  "UNKNOWN_TEMPLATE_VARIABLE",
  "DUPLICATE_RECENT_SEND",
  "CHANNEL_NOT_AVAILABLE",
  // v6 §3 (LEADS) leads board: a column move the transition rules don't allow (out of Won, backwards, …).
  "LEAD_MOVE_NOT_ALLOWED",
  // v6 §4.3 (SHOP) TL-1: staff open only their own area's tills.
  "DRAWER_AREA_MISMATCH",
  // v6 JR-1 (SHOP): no split / multi-part payment on a Junior's or under-18's bill.
  "JUNIOR_NO_SPLIT",
  // v6 §2 (SENDALL) SA-3: a manual WhatsApp task older than the age limit — sending it by hand needs a confirmation;
  // SA-1: a manual task that is no longer relevant (the bill is paid, the refund collected, …).
  "MESSAGE_EXPIRED",
  "MESSAGE_NOT_RELEVANT",
  // Transport-level codes (not business rules) — see DECISIONS.md D-03.
  "NOT_FOUND",
  "UNAUTHENTICATED",
] as const;

export type ErrorCode = (typeof REJECTION_CODES)[number];

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "FORBIDDEN":
      return 403;
    case "VALIDATION_FAILED":
      return 422;
    case "NOT_FOUND":
      return 404;
    case "UNAUTHENTICATED":
      return 401;
    case "RATE_LIMITED":
      return 429;
    default:
      return 409;
  }
}

export function isDomainError(e: unknown, code?: ErrorCode): e is DomainError {
  return e instanceof DomainError && (code === undefined || e.code === code);
}

export const notFound = (what: string) => new DomainError("NOT_FOUND", `${what} was not found.`);
export const validation = (message: string, details?: Record<string, unknown>) =>
  new DomainError("VALIDATION_FAILED", message, details);
