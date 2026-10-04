import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";
import { clubOpenGraph } from "@/server/services/og";

/** URL-6: a /portal/* link opened while logged out lands here (?returnTo=/portal/…); its preview still shows the club. */
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }): Promise<Metadata> {
  const { returnTo } = await searchParams;
  const portal = typeof returnTo === "string" && returnTo.startsWith("/portal");
  return { title: "Log in", ...(await clubOpenGraph(portal ? { description: "Member portal — your bookings, bills, refunds and membership." } : {})) };
}

export default function LoginPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-12">
      <div>
        <h1 className="text-2xl font-bold">Log in</h1>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
