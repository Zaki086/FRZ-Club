import { ImageResponse } from "next/og";
import { getSettings } from "@/server/services/settings";
import { clubInitials } from "@/lib/codes";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

export default async function AppleIcon() {
  let name = "";
  try {
    name = (await getSettings()).club.name;
  } catch {
    // database unreachable at build time
  }
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#065f46", color: "white", fontSize: 84, fontWeight: 800 }}>
      {clubInitials(name)}
    </div>,
    size,
  );
}
