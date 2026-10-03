import type { Metadata } from "next";
import { QuoteView } from "./quote-view";

export const metadata: Metadata = { title: "Your quote", robots: { index: false } };

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <QuoteView token={token} />
    </div>
  );
}
