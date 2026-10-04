import type { MetadataRoute } from "next";
import { prisma } from "@/server/db";
import { absoluteUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

/** Completion pass §7 (public): the public pages and every active shop product. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // URL-1: every URL from APP_URL via absoluteUrl.
  const pages = ["", "/facilities", "/plans", "/availability", "/shop", "/trial", "/enquire"].map((p) => ({ url: absoluteUrl(p || "/"), changeFrequency: "weekly" as const, priority: p ? 0.7 : 1 }));
  const products = await prisma.product.findMany({ where: { archivedAt: null }, select: { id: true, updatedAt: true } }).catch(() => []);
  return [...pages, ...products.map((p) => ({ url: absoluteUrl(`/shop/${p.id}`), lastModified: p.updatedAt, changeFrequency: "weekly" as const, priority: 0.5 }))];
}
