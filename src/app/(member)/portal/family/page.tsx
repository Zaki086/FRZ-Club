import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current";
import { FamilyView } from "./family-view";

export const metadata: Metadata = { title: "Family" };

export default async function FamilyPage() {
  await requireUser(["MEMBER"], "/portal/family");
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Family</h1>
      <p className="text-sm text-muted-foreground">Members you are the guardian of: their membership, upcoming bookings and member card. You also get their membership reminders.</p>
      <FamilyView />
    </div>
  );
}
