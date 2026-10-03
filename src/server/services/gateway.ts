// Online payment gateways behind one interface (plan §1, PY-3; completion pass §2).
// Production: Razorpay with LIVE keys only (capability payments.online). The built-in Test Gateway exists only
// under NODE_ENV=test so the test suite can exercise the same server-side verification path.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError } from "../errors";

export type GatewayOrder = { gatewayOrderId: string; redirectUrl: string };
export type GatewayOutcome = { ok: true; gatewayPaymentId: string; outcome: "SUCCESS" | "FAIL" } | { ok: false };

export interface PaymentGateway {
  readonly name: "TEST" | "RAZORPAY";
  createOrder(p: { paymentId: string; amount: number; description: string; returnUrl: string }): Promise<GatewayOrder>;
  /** Verify a browser callback's signature. */
  verifyCallback(payload: Record<string, string>, ctx: { gatewayOrderId: string | null; paymentId: string }): GatewayOutcome;
  refund(p: { gatewayPaymentId: string; amount: number }): Promise<{ gatewayRefundId: string }>;
}

export const isTestEnv = () => process.env.NODE_ENV === "test" || !!process.env.VITEST;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s) throw new Error("APP_SECRET is not set");
  return s;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Tests only: signs the outcome like a real gateway would. Never selectable outside NODE_ENV=test. */
export const testGateway: PaymentGateway & {
  sign(paymentId: string, gatewayPaymentId: string, outcome: "SUCCESS" | "FAIL"): string;
  newGatewayPaymentId(): string;
} = {
  name: "TEST",
  async createOrder({ paymentId, returnUrl }) {
    return { gatewayOrderId: `test_order_${paymentId}`, redirectUrl: `/pay/test/${paymentId}?return=${encodeURIComponent(returnUrl)}` };
  },
  sign(paymentId, gatewayPaymentId, outcome) {
    return createHmac("sha256", secret()).update(`TEST|${paymentId}|${gatewayPaymentId}|${outcome}`).digest("hex");
  },
  newGatewayPaymentId() {
    return `test_pay_${randomBytes(9).toString("base64url")}`;
  },
  verifyCallback(payload, ctx) {
    const { gatewayPaymentId, outcome, signature } = payload;
    if (!gatewayPaymentId || !signature || (outcome !== "SUCCESS" && outcome !== "FAIL")) return { ok: false };
    if (!safeEqual(this.sign(ctx.paymentId, gatewayPaymentId, outcome), signature)) return { ok: false };
    return { ok: true, gatewayPaymentId, outcome };
  },
  async refund() {
    return { gatewayRefundId: `test_refund_${randomBytes(9).toString("base64url")}` };
  },
};

// ───────── Razorpay (live) ─────────

const RZP = "https://api.razorpay.com/v1";
const rzpAuth = () => "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");

async function rzp<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${RZP}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: rzpAuth(), "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Razorpay ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export type RazorpayPayment = { id: string; order_id: string; status: "created" | "authorized" | "captured" | "refunded" | "failed"; amount: number };

export const razorpayGateway: PaymentGateway & {
  fetchPayment(id: string): Promise<RazorpayPayment>;
  fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]>;
  verifyWebhook(rawBody: string, signature: string | null): boolean;
} = {
  name: "RAZORPAY",
  async createOrder({ paymentId, amount, description, returnUrl }) {
    const order = await rzp<{ id: string }>("/orders", { method: "POST", body: { amount, currency: "INR", receipt: paymentId, notes: { description } } });
    return { gatewayOrderId: order.id, redirectUrl: `/pay/razorpay/${paymentId}?return=${encodeURIComponent(returnUrl)}` };
  },
  verifyCallback(payload, ctx) {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = payload;
    if (payload.outcome === "FAIL") {
      // Checkout's failure event is unsigned: only the order id is checked here; the payment's real status is
      // confirmed with Razorpay before anything is marked FAILED (see verifyOnlinePayment).
      if (!razorpay_payment_id || !razorpay_order_id || razorpay_order_id !== ctx.gatewayOrderId) return { ok: false };
      return { ok: true, gatewayPaymentId: razorpay_payment_id, outcome: "FAIL" };
    }
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) return { ok: false };
    if (ctx.gatewayOrderId && razorpay_order_id !== ctx.gatewayOrderId) return { ok: false };
    const expected = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "").update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
    if (!safeEqual(expected, razorpay_signature)) return { ok: false };
    return { ok: true, gatewayPaymentId: razorpay_payment_id, outcome: "SUCCESS" };
  },
  async refund({ gatewayPaymentId, amount }) {
    const r = await rzp<{ id: string }>(`/payments/${gatewayPaymentId}/refund`, { method: "POST", body: { amount } });
    return { gatewayRefundId: r.id };
  },
  fetchPayment(id) {
    return rzp<RazorpayPayment>(`/payments/${id}`);
  },
  async fetchOrderPayments(orderId) {
    return (await rzp<{ items: RazorpayPayment[] }>(`/orders/${orderId}/payments`)).items;
  },
  /** X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret). */
  verifyWebhook(rawBody, signature) {
    const s = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!s || !signature) return false;
    return safeEqual(createHmac("sha256", s).update(rawBody).digest("hex"), signature);
  },
};

/** The gateway for new online payments: Razorpay (live) in production, the Test Gateway only in tests. */
export function activeGateway(): PaymentGateway {
  if (isTestEnv() && !(process.env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_live_")) return testGateway;
  return razorpayGateway;
}

export function gatewayByName(name: string | null): PaymentGateway {
  if (name === "RAZORPAY") return razorpayGateway;
  if (name === "TEST") {
    if (!isTestEnv()) throw new DomainError("NOT_FOUND", "This payment method is not available.");
    return testGateway;
  }
  throw new DomainError("NOT_FOUND", "Unknown payment gateway.");
}
