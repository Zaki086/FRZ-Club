// Shared (server + client) shop category helpers.
export const SHOP_CATEGORIES = ["RACKETS", "BALLS", "SHOES", "ACCESSORIES", "APPAREL", "SERVICES"] as const;
export const categoryLabel = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
