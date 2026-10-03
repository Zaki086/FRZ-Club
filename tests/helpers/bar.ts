import { createMenuItem, createTable } from "@/server/services/bar";
import type { World } from "./world";

export async function makeBar(w: World) {
  const m = w.actors.MANAGER;
  const beer = await createMenuItem(m, { name: "Kingfisher pint", category: "ALCOHOL", price: 35000 });
  const lime = await createMenuItem(m, { name: "Fresh lime soda", category: "BEVERAGE", price: 12000 });
  const fries = await createMenuItem(m, { name: "Masala fries", category: "FOOD", price: 18000 });
  const sandwich = await createMenuItem(m, { name: "Club sandwich", category: "FOOD", price: 32000 });
  const tables = [];
  for (let n = 1; n <= 6; n++) tables.push(await createTable(m, { number: n, capacity: 4, area: n <= 3 ? "Indoor" : "Terrace" }));
  return { beer, lime, fries, sandwich, table4: tables[3], tables };
}
