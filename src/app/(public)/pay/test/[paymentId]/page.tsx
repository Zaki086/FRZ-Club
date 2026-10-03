import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPaymentForGateway } from "@/server/services/payments";
import { testGateway } from "@/server/services/gateway";
import { isDomainError } from "@/server/errors";
import { formatINR } from "@/lib/money";
import { TestGatewayButtons } from "./buttons";

export const metadata: Metadata = { title: "Test payment gateway", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function TestGatewayPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  // Completion pass §2.1: the Test Gateway only exists in the test environment.
  if (process.env.NODE_ENV !== "test") notFound();
  const { paymentId } = await params;
  const { return: ret } = await searchParams;
  let payment;
  try {
    payment = await getPaymentForGateway(paymentId);
  } catch (e) {
    if (isDomainError(e, "NOT_FOUND")) notFound();
    throw e;
  }
  if (payment.gateway !== "TEST") notFound();
  const gatewayPaymentId = testGateway.newGatewayPaymentId();
  const returnUrl = ret && ret.startsWith("/") && !ret.startsWith("//") ? ret : (payment.returnUrl ?? "/");
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-8">
      <div className="rounded-lg border-4 border-dashed border-amber-500 bg-warning/15 p-4 text-center" role="alert">
        <p className="text-2xl font-black tracking-widest text-warning-text">TEST MODE</p>
        <p className="text-sm text-warning-foreground">
          This is the built-in Test Gateway. <strong>No real money moves.</strong> It uses the same server-side
          verification path as the real gateway.
        </p>
      </div>
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">Paying</p>
        <p className="text-3xl font-bold">{formatINR(payment.amount)}</p>
        <p className="mt-1 text-sm">For: {payment.bill.customerName}</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
          {payment.bill.lines
            .filter((l) => !l.voidedAt)
            .map((l) => (
              <li key={l.id}>
                {l.description} — {formatINR(l.netAmount)}
              </li>
            ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Payment reference: {payment.id}</p>
      </div>
      {payment.status === "PENDING" ? (
        <TestGatewayButtons
          paymentId={payment.id}
          gatewayPaymentId={gatewayPaymentId}
          successSignature={testGateway.sign(payment.id, gatewayPaymentId, "SUCCESS")}
          failSignature={testGateway.sign(payment.id, gatewayPaymentId, "FAIL")}
          returnUrl={returnUrl}
        />
      ) : (
        <div className="rounded-md border p-3 text-sm">
          This payment is already <strong>{payment.status}</strong>.{" "}
          <a className="text-primary underline" href={returnUrl}>
            Continue
          </a>
        </div>
      )}
    </div>
  );
}
