import type { Metadata } from "next";
import { getSettings } from "@/server/services/settings";

export const metadata: Metadata = { title: "Privacy" };
export const dynamic = "force-dynamic";

/** Completion pass P1 (DPDP): what the club stores, why, for how long, and how to use your rights. */
export default async function PrivacyNotice() {
  const club = (await getSettings()).club;
  const name = club.name || "The club";
  return (
    <div className="prose prose-sm mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold">Privacy notice</h1>
      <p>{name} uses this system to run memberships, court bookings, the shop and the bar. This page explains what we keep about you.</p>
      <h2 className="mt-6 text-xl font-semibold">What we store and why</h2>
      <ul className="list-disc pl-5">
        <li><strong>Members:</strong> name, mobile, email (optional), date of birth (age rules for Juniors and alcohol), a photo for your member card (optional), emergency contact, and for under-18s a guardian. Used to run your membership and bookings.</li>
        <li><strong>Bookings, visits, orders and bar tabs:</strong> what you booked, bought or ordered, and when — to provide the service and keep the court schedule fair.</li>
        <li><strong>Payments and invoices:</strong> amounts, method and the payment reference (e.g. the UPI transaction reference or the last 4 digits of a card — never a full card number).</li>
        <li><strong>Enquiries and trials:</strong> the details you send us, used only to answer you; we ask for your consent on the form.</li>
      </ul>
      <h2 className="mt-6 text-xl font-semibold">Who sees it</h2>
      <p>Only club staff, each limited to what their job needs (for example, bar staff can look a member up to attach a tab but cannot open the member&apos;s profile). We do not sell or share your data.</p>
      <h2 className="mt-6 text-xl font-semibold">How long we keep it</h2>
      <p>Your profile is kept while you are a member and until you ask us to erase it. Bills, payments and invoices are kept for the period tax law requires, even after erasure.</p>
      <h2 className="mt-6 text-xl font-semibold">Your rights</h2>
      <p>In the member portal (My account → Your data) you can download everything we hold about you, and ask for your personal details to be erased. You can also ask at the front desk{club.email ? <> or write to <a href={`mailto:${club.email}`}>{club.email}</a></> : null}.</p>
    </div>
  );
}
