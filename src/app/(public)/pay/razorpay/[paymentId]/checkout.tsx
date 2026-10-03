"use client";
import Script from "next/script";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/components/api";
import { Button } from "@/components/ui/button";
import { RejectionBanner } from "@/components/states";
import { useCapabilities } from "@/components/capabilities";

type RazorpayResponse = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type RazorpayCtor = new (opts: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r: { error: { metadata?: { payment_id?: string } } }) => void): void };

export function RazorpayCheckout(props: { keyId: string; orderId: string; amount: number; paymentId: string; returnUrl: string }) {
  const clubName = useCapabilities()?.clubName ?? "";
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const finish = async (payload: Record<string, string>) => {
    try {
      const r = await api<{ status: string }>("/api/payments/razorpay/callback", { body: { paymentId: props.paymentId, ...payload } });
      const sep = props.returnUrl.includes("?") ? "&" : "?";
      router.push(`${props.returnUrl}${sep}payment=${r.status === "SUCCEEDED" ? "success" : "failed"}`);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Script src="https://checkout.razorpay.com/v1/checkout.js" onLoad={() => setReady(true)} />
      <RejectionBanner error={error} />
      <Button
        size="xl"
        disabled={!ready}
        onClick={() => {
          const Rzp = (window as unknown as { Razorpay: RazorpayCtor }).Razorpay;
          const rzp = new Rzp({
            key: props.keyId,
            order_id: props.orderId,
            amount: props.amount,
            currency: "INR",
            name: clubName || "Club",
            handler: (r: RazorpayResponse) => void finish({ ...r, outcome: "SUCCESS" }),
          });
          rzp.on("payment.failed", (r) => void finish({ outcome: "FAIL", razorpay_payment_id: r.error.metadata?.payment_id ?? "unknown" }));
          rzp.open();
        }}
      >
        {ready ? "Pay with Razorpay" : "Loading Razorpay…"}
      </Button>
    </div>
  );
}
