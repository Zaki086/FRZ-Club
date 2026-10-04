import type { MetadataRoute } from "next";
import { getSettings } from "@/server/services/settings";
import { absoluteUrl, publicOrigin } from "@/lib/url";

export const dynamic = "force-dynamic";

/** Completion pass §7 (public): only the public site is indexable; a sample-data instance asks not to be indexed. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = publicOrigin(); // URL-1
  let sample = false;
  try {
    sample = (await getSettings()).instance_mode === "SAMPLE_DATA";
  } catch {
    // database unreachable: be conservative
    sample = true;
  }
  if (sample) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/app", "/portal", "/api", "/pay", "/set-password", "/share", "/rq", "/quote", "/orders", "/setup", "/login", "/forgot-password"] }],
    sitemap: base ? absoluteUrl("/sitemap.xml") : undefined,
  };
}
