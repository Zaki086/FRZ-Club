import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { exportMyData } from "@/server/services/privacy";

/** DPDP: download everything the club holds about me (JSON). */
export const GET = route(async ({ actor }) => {
  const data = await exportMyData(actor);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="my-data-${data.profile.memberCode}.json"` },
  });
});
