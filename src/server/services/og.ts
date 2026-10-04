// URL-6: link previews. WhatsApp (and other link-preview bots) read Open Graph tags from the unauthenticated response,
// so every page — including the login page a /portal link redirects to — carries the club's name, a description and
// the club's logo (or its generated initials icon) as absolute URLs on APP_URL (`metadataBase`).
import type { Metadata } from "next";
import { absoluteUrl, publicOrigin } from "@/lib/url";
import { getSettings } from "./settings";

export type OgInput = {
  /** Shown under the club name in the preview (e.g. "Your quote"). */
  description?: string;
  /** The page's own path, used as og:url (on APP_URL). */
  path?: string;
};

async function clubBrand(): Promise<{ name: string; logo: string }> {
  try {
    const c = (await getSettings()).club;
    return { name: c.name, logo: c.logo_url };
  } catch {
    return { name: "", logo: "" }; // database unreachable (e.g. at build time)
  }
}

/** URL-6: `metadataBase`, `openGraph` and `twitter` for a page: title = the club's name, image = its logo. */
export async function clubOpenGraph(input: OgInput = {}): Promise<Pick<Metadata, "metadataBase" | "openGraph" | "twitter">> {
  const { name, logo } = await clubBrand();
  const club = name || "Club";
  const description = input.description || `${club}: courts, memberships, shop and café.`;
  const origin = publicOrigin();
  const image = logo
    ? { url: absoluteUrl(logo), alt: club }
    : { url: absoluteUrl("/icon"), width: 512, height: 512, alt: club, type: "image/png" };
  let metadataBase: URL | null = null;
  try {
    metadataBase = origin ? new URL(origin) : null;
  } catch {
    metadataBase = null;
  }
  return {
    metadataBase,
    openGraph: {
      type: "website",
      siteName: club,
      title: club,
      description,
      locale: "en_IN",
      ...(input.path ? { url: absoluteUrl(input.path) } : {}),
      images: [image],
    },
    twitter: { card: "summary", title: club, description, images: [image.url] },
  };
}
