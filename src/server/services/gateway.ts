// Online payment gateways behind one interface (plan §1, PY-3, PY-7).
// Razorpay test mode is used when keys exist; otherwise the built-in Test Gateway. Both are verified server-side
// through the same verifyOnlinePayment() code path in payments.ts.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type GatewayOrder = { gatewayOrderId: string; redirectUrl: string };

export interface PaymentGateway {
  readonly name: "TEST" | "RAZORPAY";
  createOrder(p: { paymentId: string; amount: number; description: string; returnUrl: string }): Promise<GatewayOrder>;
  /** Verify a callback's signature. Returns the gateway payment id and outcome when authentic. */
  verifyCallback(payload: Record<string, string>, ctx: { gatewayOrderId: string | null; paymentId: string }):
    | { ok: true; gatewayPaymentId: string; outcome: "SUCCESS" | "FAIL" }
    | { ok: false };
  refund(p: { gatewayPaymentId: string; amount: number }): Promise<{ gatewayRefundId: string }>;
}

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

/** PY-7: clearly labelled test gateway. Its page signs the outcome like a real gateway would. */
export const testGateway: PaymentGateway & {
  sign(paymentId: string, gatewayPaymentId: string, outcome: "SUCCESS" | "FAIL"): string;
  newGatewayPaymentId(): string;
} = {
  name: "TEST",
  async createOrder({ paymentId, returnUrl }) {
    return {
      gatewayOrderId: `test_order_${paymentId}`,
      redirectUrl: `/pay/test/${paymentId}?return=${encodeURIComponent(returnUrl)}`,
    };
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
    const expected = this.sign(ctx.paymentId, gatewayPaymentId, outcome);
    if (!safeEqual(expected, signature)) return { ok: false };
    return { ok: true, gatewayPaymentId, outcome };
  },
  async refund() {
    return { gatewayRefundId: `test_refund_${randomBytes(9).toString("base64url")}` };
  },
};

/** Razorpay test mode (used only when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set). */
export const razorpayGateway: PaymentGateway = {
  name: "RAZORPAY",
  async createOrder({ paymentId, amount, description, returnUrl }) {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64"),
      },
      body: JSON.stringify({ amount, currency: "INR", receipt: paymentId, notes: { description } }),
    });
    if (!res.ok) throw new Error(`Razorpay order failed: ${res.status} ${await res.text()}`);
    const order = (await res.json()) as { id: string };
    return {
      gatewayOrderId: order.id,
      redirectUrl: `/pay/razorpay/${paymentId}?return=${encodeURIComponent(returnUrl)}`,
    };
  },
  verifyCallback(payload, ctx) {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = payload;
    if (payload.outcome === "FAIL" && razorpay_payment_id) {
      // Failure callbacks from checkout.js carry no signature; we only ever mark FAILED from them.
      return { ok: true, gatewayPaymentId: razorpay_payment_id, outcome: "FAIL" };
    }
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) return { ok: false };
    if (ctx.gatewayOrderId && razorpay_order_id !== ctx.gatewayOrderId) return { ok: false };
    const expected = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "")
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (!safeEqual(expected, razorpay_signature)) return { ok: false };
    return { ok: true, gatewayPaymentId: razorpay_payment_id, outcome: "SUCCESS" };
  },
  async refund({ gatewayPaymentId, amount }) {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${gatewayPaymentId}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64"),
      },
      body: JSON.stringify({ amount }),
    });
    if (!res.ok) throw new Error(`Razorpay refund failed: ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { id: string };
    return { gatewayRefundId: r.id };
  },
};

export function razorpayConfigured(): boolean {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function activeGateway(): PaymentGateway {
  return razorpayConfigured() ? razorpayGateway : testGateway;
}

export function gatewayByName(name: string | null): PaymentGateway {
  return name === "RAZORPAY" ? razorpayGateway : testGateway;
}
