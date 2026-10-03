// Shop catalogue (§11.2: 40+ variants, some near reorder level, one racket with exactly 1 unit, restring service)
// and the bar menu (25 items incl. alcoholic) with 10 tables. Stock arrives through goods receipts (SH-9).
import { prisma } from "@/server/db";
import type { UserActor } from "@/server/rbac/actor";
import { receiveStock } from "@/server/services/inventory";
import { createProduct } from "@/server/services/shop";
import { createMenuItem, createTable } from "@/server/services/bar";

const R = (r: number) => r * 100;

type P = { name: string; brand: string; category: "RACKETS" | "BALLS" | "SHOES" | "ACCESSORIES" | "APPAREL" | "SERVICES"; desc: string; hsn: string; variants: Array<{ sku: string; label: string; price: number; stock: number; reorder?: number }>; restring?: boolean };

export const PRODUCTS: P[] = [
  { name: "Pro Staff 97 v14", brand: "Wilson", category: "RACKETS", hsn: "9506", desc: "Control racket, 315 g, 16×19.", variants: [{ sku: "RKT-PS97", label: "Grip 3", price: R(18999), stock: 1, reorder: 0 }] },
  { name: "Pure Drive 2025", brand: "Babolat", category: "RACKETS", hsn: "9506", desc: "Power and spin, 300 g.", variants: [{ sku: "RKT-PD-G2", label: "Grip 2", price: R(16499), stock: 4 }, { sku: "RKT-PD-G3", label: "Grip 3", price: R(16499), stock: 3 }] },
  { name: "Speed MP", brand: "Head", category: "RACKETS", hsn: "9506", desc: "All-court speed, 300 g.", variants: [{ sku: "RKT-SPD-G3", label: "Grip 3", price: R(15999), stock: 5 }] },
  { name: "Ezone 100", brand: "Yonex", category: "RACKETS", hsn: "9506", desc: "Comfortable power, 300 g.", variants: [{ sku: "RKT-EZ100", label: "Grip 2", price: R(17499), stock: 2 }] },
  { name: "Junior Ace 25", brand: "Wilson", category: "RACKETS", hsn: "9506", desc: "25-inch junior racket.", variants: [{ sku: "RKT-JR25", label: "Standard", price: R(3499), stock: 8 }] },
  { name: "English Willow Cricket Bat", brand: "SG", category: "RACKETS", hsn: "9506", desc: "Grade 2 English willow, short handle.", variants: [{ sku: "BAT-EW-SH", label: "Short handle", price: R(12999), stock: 3 }] },
  { name: "Championship Tennis Balls", brand: "Wilson", category: "BALLS", hsn: "9506", desc: "Can of 3, extra duty felt.", variants: [{ sku: "BAL-CH3", label: "Can of 3", price: R(499), stock: 60, reorder: 12 }, { sku: "BAL-CH12", label: "Box of 12", price: R(1899), stock: 10 }] },
  { name: "Gold Tennis Balls", brand: "Babolat", category: "BALLS", hsn: "9506", desc: "Can of 4, all court.", variants: [{ sku: "BAL-GLD4", label: "Can of 4", price: R(649), stock: 4, reorder: 6 }] },
  { name: "Leather Cricket Ball", brand: "SG", category: "BALLS", hsn: "9506", desc: "Test grade red leather ball.", variants: [{ sku: "BAL-CRK-RED", label: "Red", price: R(1299), stock: 12 }, { sku: "BAL-CRK-WHT", label: "White", price: R(1399), stock: 3 }] },
  { name: "Gel-Resolution 9", brand: "Asics", category: "SHOES", hsn: "6404", desc: "Stable all-court tennis shoe.", variants: [{ sku: "SHO-GR9-8", label: "UK 8", price: R(11999), stock: 3 }, { sku: "SHO-GR9-9", label: "UK 9", price: R(11999), stock: 2 }, { sku: "SHO-GR9-10", label: "UK 10", price: R(11999), stock: 4 }] },
  { name: "CourtJam Bounce", brand: "Adidas", category: "SHOES", hsn: "6404", desc: "Lightweight hard-court shoe.", variants: [{ sku: "SHO-CJB-7", label: "UK 7", price: R(6999), stock: 5 }, { sku: "SHO-CJB-8", label: "UK 8", price: R(6999), stock: 6 }, { sku: "SHO-CJB-9", label: "UK 9", price: R(6999), stock: 1 }] },
  { name: "Cricket Spikes Pro", brand: "Puma", category: "SHOES", hsn: "6404", desc: "Metal spikes for turf.", variants: [{ sku: "SHO-SPK-8", label: "UK 8", price: R(5499), stock: 4 }, { sku: "SHO-SPK-9", label: "UK 9", price: R(5499), stock: 3 }] },
  { name: "Overgrip (3 pack)", brand: "Yonex", category: "ACCESSORIES", hsn: "9506", desc: "Super Grap overgrip, white.", variants: [{ sku: "ACC-OG3", label: "White", price: R(399), stock: 40, reorder: 10 }, { sku: "ACC-OG3-BLK", label: "Black", price: R(399), stock: 8, reorder: 10 }] },
  { name: "Vibration Dampener", brand: "Babolat", category: "ACCESSORIES", hsn: "9506", desc: "Custom damp, pack of 2.", variants: [{ sku: "ACC-DAMP", label: "Standard", price: R(299), stock: 25 }] },
  { name: "Polyester String Set", brand: "Luxilon", category: "ACCESSORIES", hsn: "9506", desc: "ALU Power 1.25 set.", variants: [{ sku: "ACC-STR-ALU", label: "1.25 mm", price: R(1899), stock: 15, reorder: 5 }] },
  { name: "Racket Bag 6R", brand: "Head", category: "ACCESSORIES", hsn: "4202", desc: "Holds six rackets, thermal lining.", variants: [{ sku: "ACC-BAG6", label: "Black", price: R(5999), stock: 3 }] },
  { name: "Wristbands (pair)", brand: "Nike", category: "ACCESSORIES", hsn: "6117", desc: "Terry cotton wristbands.", variants: [{ sku: "ACC-WB-WHT", label: "White", price: R(499), stock: 20 }, { sku: "ACC-WB-BLK", label: "Black", price: R(499), stock: 2, reorder: 4 }] },
  { name: "Batting Gloves", brand: "SG", category: "ACCESSORIES", hsn: "6116", desc: "Test grade gloves.", variants: [{ sku: "ACC-BGL-M", label: "Men's", price: R(2299), stock: 6 }, { sku: "ACC-BGL-Y", label: "Youth", price: R(1899), stock: 4 }] },
  { name: "Club Polo", brand: "Champions Club", category: "APPAREL", hsn: "6105", desc: "Moisture-wicking club polo.", variants: [{ sku: "APP-POLO-S", label: "S", price: R(1499), stock: 8 }, { sku: "APP-POLO-M", label: "M", price: R(1499), stock: 12 }, { sku: "APP-POLO-L", label: "L", price: R(1499), stock: 10 }, { sku: "APP-POLO-XL", label: "XL", price: R(1499), stock: 3 }] },
  { name: "Training Shorts", brand: "Adidas", category: "APPAREL", hsn: "6203", desc: "Lightweight 7-inch shorts.", variants: [{ sku: "APP-SHT-M", label: "M", price: R(1999), stock: 7 }, { sku: "APP-SHT-L", label: "L", price: R(1999), stock: 5 }] },
  { name: "Club Cap", brand: "Champions Club", category: "APPAREL", hsn: "6505", desc: "Embroidered cap, one size.", variants: [{ sku: "APP-CAP", label: "Navy", price: R(799), stock: 15 }] },
  { name: "Cricket Whites Trousers", brand: "Kookaburra", category: "APPAREL", hsn: "6203", desc: "Stretch whites.", variants: [{ sku: "APP-WHT-32", label: "32", price: R(1799), stock: 4 }, { sku: "APP-WHT-34", label: "34", price: R(1799), stock: 4 }] },
  { name: "Racket restring", brand: "Champions Club", category: "SERVICES", hsn: "998719", desc: "Restringing with your choice of string, ready in 24 h.", restring: true, variants: [{ sku: "SRV-RESTRING", label: "Standard", price: R(800), stock: 0 }, { sku: "SRV-RESTRING-EXP", label: "Express (2 h)", price: R(1200), stock: 0 }] },
];

export const MENU: Array<{ name: string; category: "FOOD" | "BEVERAGE" | "ALCOHOL"; price: number }> = [
  { name: "Masala fries", category: "FOOD", price: R(180) },
  { name: "Club sandwich", category: "FOOD", price: R(320) },
  { name: "Paneer tikka", category: "FOOD", price: R(360) },
  { name: "Chicken wrap", category: "FOOD", price: R(340) },
  { name: "Veg burger", category: "FOOD", price: R(280) },
  { name: "Caesar salad", category: "FOOD", price: R(300) },
  { name: "Margherita pizza", category: "FOOD", price: R(420) },
  { name: "Chilli cheese toast", category: "FOOD", price: R(220) },
  { name: "Protein bowl", category: "FOOD", price: R(390) },
  { name: "Fresh lime soda", category: "BEVERAGE", price: R(120) },
  { name: "Cold coffee", category: "BEVERAGE", price: R(180) },
  { name: "Masala chai", category: "BEVERAGE", price: R(60) },
  { name: "Mineral water", category: "BEVERAGE", price: R(40) },
  { name: "Sports drink", category: "BEVERAGE", price: R(110) },
  { name: "Banana smoothie", category: "BEVERAGE", price: R(200) },
  { name: "Coconut water", category: "BEVERAGE", price: R(90) },
  { name: "Iced tea", category: "BEVERAGE", price: R(150) },
  { name: "Kingfisher pint", category: "ALCOHOL", price: R(350) },
  { name: "Bira white pint", category: "ALCOHOL", price: R(380) },
  { name: "House red wine (glass)", category: "ALCOHOL", price: R(450) },
  { name: "Gin & tonic", category: "ALCOHOL", price: R(420) },
  { name: "Old Monk & cola", category: "ALCOHOL", price: R(320) },
  { name: "Whisky (30 ml)", category: "ALCOHOL", price: R(380) },
  { name: "Mojito", category: "ALCOHOL", price: R(450) },
  { name: "Beer tower (3 L)", category: "ALCOHOL", price: R(1800) },
];

export async function seedCatalogue(shop: UserActor, manager: UserActor) {
  const variantIds: Record<string, string> = {};
  for (const p of PRODUCTS) {
    const existing = await prisma.productVariant.findUnique({ where: { sku: p.variants[0].sku } });
    if (existing) continue;
    const created = await createProduct(shop, {
      name: p.name, brand: p.brand, category: p.category, description: p.desc, isRestring: p.restring ?? false,
      variants: p.variants.map((v) => ({ sku: v.sku, label: v.label, price: v.price, reorderLevel: v.reorder, hsnSac: p.hsn })),
    });
    for (const v of created.variants) {
      variantIds[v.sku] = v.id;
      const spec = p.variants.find((x) => x.sku === v.sku)!;
      if (spec.stock > 0) {
        await receiveStock(shop, { variantId: v.id, qty: spec.stock, unitCost: Math.round(v.price * 0.58), supplier: p.brand === "Champions Club" ? "Local Print House" : `${p.brand} India Distributors` });
      }
    }
  }
  if (!(await prisma.menuItem.count())) {
    for (const [i, m] of MENU.entries()) await createMenuItem(manager, { ...m, sortOrder: i });
    for (let n = 1; n <= 10; n++) await createTable(manager, { number: n, capacity: n <= 6 ? 4 : 6, area: n <= 4 ? "Indoor" : n <= 8 ? "Terrace" : "Court-side" });
  }
  return variantIds;
}
