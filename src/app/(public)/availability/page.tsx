import type { Metadata } from "next";
import { WeekAvailability } from "./week-availability";

export const metadata: Metadata = { title: "This week's availability" };

export default function AvailabilityPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold">This week&apos;s availability</h1>
        <p className="text-muted-foreground">Live court availability for the next 7 days. Each session lasts an hour; a new one starts every half hour.</p>
      </div>
      <WeekAvailability />
    </div>
  );
}
