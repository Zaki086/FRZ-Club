import type { Metadata } from "next";
import { getSettings } from "@/server/services/settings";
import { EnquiryForm } from "./enquiry-form";
import { formatPhone } from "@/lib/validation/contact";

export const metadata: Metadata = { title: "Enquire" };
export const dynamic = "force-dynamic";

export default async function EnquirePage() {
  const s = await getSettings();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold">Get in touch</h1>
        <p className="text-muted-foreground">Ask us about memberships, coaching, corporate packages or anything else. You can also call {formatPhone(s.club.phone)}.</p>
      </div>
      <EnquiryForm />
    </div>
  );
}
