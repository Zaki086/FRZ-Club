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
