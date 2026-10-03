export type OrderView = {
  id: string;
  code: string;
  status: string;
  fulfilment: "PICKUP" | "DELIVERY";
  paymentOption: "ONLINE" | "PAY_AT_PICKUP" | "PAY_ON_DELIVERY";
  address: string | null;
  holdExpiresAt: string | null;
  createdAt: string;
  customer: string;
  phone: string | null;
  memberId: string | null;
  trackToken: string;
  billId: string;
  total: number;
  due: number;
  billStatus: string;
  cancelReason: string | null;
  lines: Array<{ id: string; variantId: string; name: string; qty: number; unitPrice: number; netAmount: number }>;
  events: Array<{ status: string; at: string; note: string | null }>;
  nextStatuses: string[];
};

export const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  CONFIRMED: "Confirmed",
  READY_FOR_PICKUP: "Ready for pickup",
  COLLECTED: "Collected",
  PACKED: "Packed",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};
