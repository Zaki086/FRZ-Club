import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPaymentForGateway } from "@/server/services/payments";
import { isDomainError } from "@/server/errors";
import { formatINR } from "@/lib/money";
import { RazorpayCheckout } from "./checkout";

export const metadata: Metadata = { title: "Pay online", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function RazorpayPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const { paymentId } = await params;
  const { return: ret } = await searchParams;
  let payment;
  try {
    payment = await getPaymentForGateway(paymentId);
  } catch (e) {
    if (isDomainError(e, "NOT_FOUND")) notFound();
    throw e;
  }
  if (payment.gateway !== "RAZORPAY" || !payment.gatewayOrderId) notFound();
  const returnUrl = ret && ret.startsWith("/") && !ret.startsWith("//") ? ret : (payment.returnUrl ?? "/");
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-8">
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">Paying</p>
        <p className="text-3xl font-bold">{formatINR(payment.amount)}</p>
        <p className="text-sm">For: {payment.bill.customerName}</p>
      </div>
      {payment.status === "PENDING" ? (
        <RazorpayCheckout
          keyId={process.env.RAZORPAY_KEY_ID ?? ""}
          orderId={payment.gatewayOrderId}
          amount={payment.amount}
          paymentId={payment.id}
          returnUrl={returnUrl}
        />
      ) : (
        <p className="text-sm">This payment is already {payment.status}.</p>
      )}
    </div>
  );
}
