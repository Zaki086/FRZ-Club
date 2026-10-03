import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current";
import { AccountPanel } from "@/components/account-panel";
import { PrivacyPanel } from "@/components/privacy-panel";

export const metadata: Metadata = { title: "My account" };

export default async function MemberAccountPage() {
  await requireUser(["MEMBER"], "/portal/account");
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">My account</h1>
      <AccountPanel />
      <PrivacyPanel />
    </div>
  );
}
