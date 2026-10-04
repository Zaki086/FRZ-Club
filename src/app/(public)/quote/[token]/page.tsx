import type { Metadata } from "next";
import { QuoteView } from "./quote-view";
import { clubOpenGraph } from "@/server/services/og";

/** URL-6: link preview with the club's name, logo and what this page is. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: "Your quote", robots: { index: false }, ...(await clubOpenGraph({ description: "Your membership quote — view and respond online." })) };
}

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <QuoteView token={token} />
    </div>
  );
}
