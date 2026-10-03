import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "The Champions Club", template: "%s · The Champions Club" },
  description: "Tennis and cricket courts, gear shop, bar & cafeteria — one club, one system.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-screen">
        {children}
        <Toaster richColors position="top-right" closeButton />
      </body>
    </html>
  );
}
