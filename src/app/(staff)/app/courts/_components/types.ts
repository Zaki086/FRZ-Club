// Shapes returned by the courts & booking API (rendered as-is; the UI never computes prices or availability).

export type PlayerInput =
  | { memberId: string }
  | { memberCode: string }
  | { guestId: string }
  | { guest: { name: string; phone?: string } };

export type PickedPlayer = { key: string; name: string; detail?: string; input: PlayerInput };

export type Slot = {
  time: string;
  state: "FREE" | "BOOKED" | "SOCIAL" | "MAINTENANCE";
  label: string;
  bookable: boolean;
  past: boolean;
  reservationId?: string;
  bookingId?: string | null;
  bookingCode?: string | null;
  socialId?: string | null;
  isStart?: boolean;
  unpaid?: boolean;
  checkedIn?: boolean;
  range?: string;
};

export type CourtRow = { courtId: string; name: string; sport: string; maxPlayers: number; active: boolean; slots: Slot[] };

export type Availability = {
  from: string;
  days: number;
  open: string;
  close: string;
  now: string;
  today: string;
  viewer: "STAFF" | "MEMBER" | "PUBLIC";
  dates: Array<{ date: string; courts: CourtRow[] }>;
};

export type Quote = { total: number; taxTotal: number; players: Array<{ name: string; tier: string; fee: number; explanation: string }> };

export type BookingResult = {
  bookingId: string;
  bookingCode: string;
  court: string;
  startAt: string;
  endAt: string;
  status: string;
  billId: string;
  total: number;
  billStatus: string;
  due: number;
  players: Array<{ name: string; tier: string; fee: number; explanation: string }>;
  payment: { redirectUrl: string; paymentId: string } | null;
};

export type BookingView = {
  id: string;
  code: string;
  court: string;
  courtId: string;
  startAt: string;
  endAt: string;
  status: string;
  channel: string;
  primaryMemberId: string | null;
  players: Array<{ id: string; memberId: string | null; guestId: string | null; name: string; fee: number; tier: string; checkedInAt: string | null }>;
  billId: string | null;
  total: number;
  due: number;
  billStatus: string;
  cancelledAt: string | null;
};

export type MemberHit = { id: string; memberCode: string; name: string; phone: string; status: { tier: string; status: string } };

export function errorOf(e: unknown): { code?: string; message: string } {
  if (e && typeof e === "object" && "message" in e) {
    const x = e as { code?: string; message: string };
    return { code: x.code, message: x.message };
  }
  return { message: String(e) };
}
