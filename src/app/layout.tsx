import type { Metadata, Viewport } from "next";
import { getSettings } from "@/server/services/settings";
import { Toaster } from "sonner";
import { SampleDataBanner } from "@/components/sample-data-banner";
import { SwRegister } from "@/components/sw-register";
import "./globals.css";

/** Titles carry the club's own name (empty until the setup wizard; "Club" meanwhile). */
export async function generateMetadata(): Promise<Metadata> {
  let name = "";
  try {
    name = (await getSettings()).club.name;
  } catch {
    // database not reachable (e.g. at build time): fall back to a neutral title
  }
  const club = name || "Club";
  return { title: { default: club, template: `%s · ${club}` }, description: `${club}: courts, memberships, shop and café.` };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#065f46" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-screen">
        <SampleDataBanner />
        <SwRegister />
        {children}
        <Toaster richColors position="top-right" closeButton />
      </body>
    </html>
  );
}
