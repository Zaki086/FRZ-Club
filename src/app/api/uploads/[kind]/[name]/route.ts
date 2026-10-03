import { NextResponse } from "next/server";
import { route } from "@/server/http";
import { readUpload } from "@/server/services/uploads";

export const GET = route<{ kind: string; name: string }>(
  async ({ actor, params }) => {
    const f = await readUpload(actor, params.kind, params.name);
    return new NextResponse(new Uint8Array(f.data), {
      headers: { "Content-Type": f.type, "Cache-Control": params.kind === "product" ? "public, max-age=86400, immutable" : "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  },
  { auth: "optional" },
);
