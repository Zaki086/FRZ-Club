import type { Metadata } from "next";
import { OrderTracking } from "./order-tracking";

export const metadata: Metadata = { title: "Track your order", robots: { index: false } };

export default async function OrderTrackingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <OrderTracking token={token} />
    </div>
  );
}
