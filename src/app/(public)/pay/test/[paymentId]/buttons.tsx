"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/components/api";
import { Button } from "@/components/ui/button";
import { RejectionBanner } from "@/components/states";

export function TestGatewayButtons(props: {
  paymentId: string;
  gatewayPaymentId: string;
  successSignature: string;
  failSignature: string;
  returnUrl: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const send = async (outcome: "SUCCESS" | "FAIL") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string }>("/api/payments/test-gateway/callback", {
        body: {
          paymentId: props.paymentId,
          gatewayPaymentId: props.gatewayPaymentId,
          outcome,
          signature: outcome === "SUCCESS" ? props.successSignature : props.failSignature,
        },
      });
      const sep = props.returnUrl.includes("?") ? "&" : "?";
      router.push(`${props.returnUrl}${sep}payment=${r.status === "SUCCEEDED" ? "success" : "failed"}`);
    } catch (e) {
      setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <RejectionBanner error={error} />
      <div className="grid grid-cols-2 gap-3">
        <Button size="xl" disabled={busy} onClick={() => send("SUCCESS")} data-testid="gateway-succeed">
          Succeed payment
        </Button>
        <Button size="xl" variant="destructive" disabled={busy} onClick={() => send("FAIL")} data-testid="gateway-fail">
          Fail payment
        </Button>
      </div>
    </div>
  );
}
