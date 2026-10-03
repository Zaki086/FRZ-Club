import type { Metadata, Viewport } from "next";
import { getSettings } from "@/server/services/settings";
import { Toaster } from "sonner";
import { SampleDataBanner } from "@/components/sample-data-banner";
import { SwRegister } from "@/components/sw-register";
import { Barlow_Condensed, Manrope } from "next/font/google";
import "./globals.css";

// v3 design port: display + body faces from the reference, self-hosted by next/font (no browser request to Google).
const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-barlow", display: "swap" });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });

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

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f3a2e" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${barlow.variable} ${manrope.variable}`}>
      <body className="min-h-screen">
        <SampleDataBanner />
        <SwRegister />
        {children}
        <Toaster richColors position="top-right" closeButton />
      </body>
    </html>
  );
}
