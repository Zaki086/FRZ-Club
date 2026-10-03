import { redirect } from "next/navigation";

// v4 §5.2: the WhatsApp "View booking" button opens portal/bookings/<booking code>; the bookings list shows it.
export default async function PortalBookingLink({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  redirect(`/portal/bookings?booking=${encodeURIComponent(ref.slice(0, 40))}`);
}
