import type { Metadata } from "next";
import { Suspense } from "react";
import { getSettings } from "@/server/services/settings";
import { formatINR } from "@/lib/money";
import { TrialForm } from "./trial-form";

export const metadata: Metadata = { title: "Book a trial" };
export const dynamic = "force-dynamic";

export default async function TrialPage() {
  const s = await getSettings();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold">Book a trial session</h1>
        <p className="text-muted-foreground">
          One hour on court, {s.trial_fee === 0 ? "free of charge" : `${formatINR(s.trial_fee)}, paid at the desk`}. One trial per phone number; trials can be booked for today or tomorrow.
        </p>
      </div>
      <Suspense>
        <TrialForm />
      </Suspense>
    </div>
  );
}
