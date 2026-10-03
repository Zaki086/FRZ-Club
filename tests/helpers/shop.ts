import { createProduct } from "@/server/services/shop";
import { receiveStock } from "@/server/services/inventory";
import type { World } from "./world";

let skuSeq = 0;

export async function makeProduct(
  w: World,
  opts: { name: string; category?: "RACKETS" | "BALLS" | "SHOES" | "ACCESSORIES" | "APPAREL" | "SERVICES"; price: number; onHand?: number; reorderLevel?: number; isRestring?: boolean },
) {
  skuSeq += 1;
  const p = await createProduct(w.actors.SHOP_STAFF, {
    name: opts.name,
    category: opts.category ?? "RACKETS",
    isRestring: opts.isRestring ?? false,
    variants: [{ sku: `SKU-${skuSeq}`, label: "Standard", price: opts.price, reorderLevel: opts.reorderLevel ?? 3, hsnSac: opts.category === "SERVICES" ? "998719" : "9506" }],
  });
  const v = p.variants[0];
  if (opts.onHand) await receiveStock(w.actors.SHOP_STAFF, { variantId: v.id, qty: opts.onHand, unitCost: Math.round(opts.price * 0.6), supplier: "Test Supplier" });
  return { productId: p.id, variantId: v.id };
}
