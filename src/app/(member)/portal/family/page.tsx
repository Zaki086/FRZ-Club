import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current";
import { FamilyView } from "./family-view";

export const metadata: Metadata = { title: "Family" };

export default async function FamilyPage() {
  await requireUser(["MEMBER"], "/portal/family");
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Family</h1>
      <FamilyView />
    </div>
  );
}
