import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { isSetupComplete } from "@/server/services/setup";
import { SetupWizard } from "./setup-wizard";

export const metadata: Metadata = { title: "Set up the club" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  await requireUser(["OWNER"], "/setup");
  if (await isSetupComplete()) redirect("/app");
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <h1 className="text-2xl font-bold">Set up your club</h1>
      <p className="mb-4 text-sm text-muted-foreground">A few details before the staff app opens. Everything can be changed later in Settings.</p>
      <SetupWizard />
    </div>
  );
}
