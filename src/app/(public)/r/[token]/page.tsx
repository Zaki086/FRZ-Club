import type { Metadata } from "next";
import { headers } from "next/headers";
import { ShieldX } from "lucide-react";
import { isDomainError } from "@/server/errors";
import { clientIp } from "@/server/rate-limit";
import { viewResolution, type ResolutionView } from "@/server/services/whatsapp/resolution";
import { ResolutionChoice } from "./choice";
import { clubOpenGraph } from "@/server/services/og";

// v4 §5.3: the club-cancellation choice from the WhatsApp button (no login). The token is the only key.
/** URL-6: link preview with the club's name, logo and what this page is. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: "Cancelled session", robots: { index: false, follow: false }, ...(await clubOpenGraph({ description: "A club session was cancelled — choose your refund or credit." })) };
}
export const dynamic = "force-dynamic";

function Unavailable({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center" data-testid="resolution-unavailable">
      <ShieldX className="h-10 w-10 text-destructive" />
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted-foreground">{text}</p>
    </div>
  );
}

export default async function ResolutionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let view: ResolutionView;
  try {
    view = await viewResolution(token, { ip: clientIp({ headers: await headers() }) });
  } catch (e) {
    if (isDomainError(e, "RATE_LIMITED")) return <Unavailable title="Please wait a moment" text={e.message} />;
    throw e;
  }
  if (view.state === "INVALID") return <Unavailable title="Link not valid" text="This link is not valid. Please use the link from your message, or ask the front desk." />;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-8">
      <ResolutionChoice token={token} initial={view} />
    </div>
  );
}
