import { ImageResponse } from "next/og";
import { getSettings } from "@/server/services/settings";
import { clubInitials } from "@/lib/codes";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

/** The club's initials as its app icon (no stock artwork). */
export default async function Icon() {
  let name = "";
  try {
    name = (await getSettings()).club.name;
  } catch {
    // database unreachable at build time
  }
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#065f46", color: "white", fontSize: 240, fontWeight: 800, borderRadius: 96 }}>
      {clubInitials(name)}
    </div>,
    size,
  );
}
