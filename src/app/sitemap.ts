import type { MetadataRoute } from "next";
import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

/** Completion pass §7 (public): the public pages and every active shop product. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const pages = ["", "/facilities", "/plans", "/availability", "/shop", "/trial", "/enquire"].map((p) => ({ url: `${base}${p || "/"}`, changeFrequency: "weekly" as const, priority: p ? 0.7 : 1 }));
  const products = await prisma.product.findMany({ where: { archivedAt: null }, select: { id: true, updatedAt: true } }).catch(() => []);
  return [...pages, ...products.map((p) => ({ url: `${base}/shop/${p.id}`, lastModified: p.updatedAt, changeFrequency: "weekly" as const, priority: 0.5 }))];
}
