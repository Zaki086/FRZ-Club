import type { MetadataRoute } from "next";
import { getSettings } from "@/server/services/settings";

export const dynamic = "force-dynamic";

/** Completion pass P1 (PWA): installable on phones and the desk tablet, under the club's own name. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let name = "Club";
  try {
    name = (await getSettings()).club.name || "Club";
  } catch {
    // database unreachable: neutral name
  }
  return {
    name,
    short_name: name.length > 12 ? name.split(/\s+/).filter((w) => !/^the$/i.test(w))[0] ?? name.slice(0, 12) : name,
    description: `${name}: bookings, membership, shop and café`,
    start_url: "/login",
    display: "standalone",
    background_color: "#f7f6ef",
    theme_color: "#1f3a2e",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
