import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { exportMemberData } from "@/server/services/privacy";

export const GET = route<{ id: string }>(async ({ actor, params }) => {
  const data = await exportMemberData(actor, params.id);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="member-data-${data.profile.memberCode}.json"` },
  });
});
