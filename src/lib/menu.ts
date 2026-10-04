// v5 §1.1 (MENU): the bar & café menu's shared vocabulary — used by the server (services/menu.ts) and the screens
// (the Menu screen, the shared MenuView the member portal also renders, the A4 print). No server imports here.

export const FOOD_TYPES = ["VEG", "NON_VEG", "EGG"] as const;
export type FoodTypeValue = (typeof FOOD_TYPES)[number];
export const FOOD_TYPE_LABEL: Record<FoodTypeValue, string> = { VEG: "Veg", NON_VEG: "Non-veg", EGG: "Contains egg" };
/** The standard Indian food symbol colours: green (veg), red (non-veg), brown (egg). */
export const FOOD_TYPE_COLOUR: Record<FoodTypeValue, string> = { VEG: "#15803d", NON_VEG: "#b91c1c", EGG: "#92400e" };

export const ALLERGENS = ["GLUTEN", "DAIRY", "NUTS", "EGG", "SOY", "SHELLFISH"] as const;
export type AllergenValue = (typeof ALLERGENS)[number];
export const ALLERGEN_LABEL: Record<AllergenValue, string> = { GLUTEN: "Gluten", DAIRY: "Dairy", NUTS: "Nuts", EGG: "Egg", SOY: "Soy", SHELLFISH: "Shellfish" };

export const MENU_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type MenuStatusValue = (typeof MENU_STATUSES)[number];
export const MENU_STATUS_LABEL: Record<MenuStatusValue, string> = { DRAFT: "Draft", ACTIVE: "Active", ARCHIVED: "Archived" };

/** Food (needs a food type) or a drink (no food type). */
export const MENU_KINDS = ["FOOD", "DRINK"] as const;
export type MenuKind = (typeof MENU_KINDS)[number];

/** Icons a category may show for items without a photo (lucide-react names). */
export const MENU_ICONS = [
  "UtensilsCrossed", "Sandwich", "Pizza", "Salad", "Soup", "Drumstick", "Fish", "Egg", "Croissant", "CakeSlice", "IceCreamCone",
  "Cookie", "Popcorn", "Coffee", "CupSoda", "GlassWater", "Milk", "Citrus", "Beer", "Wine", "Martini",
] as const;
export type MenuIconName = (typeof MENU_ICONS)[number];

/** v5 §1.1: ₹1 – ₹50,000 (paise). */
export const MENU_PRICE_MIN = 100;
export const MENU_PRICE_MAX = 5_000_000;
export const MENU_NAME_MIN = 2;
export const MENU_NAME_MAX = 60;
export const MENU_DESCRIPTION_MAX = 300;
export const MENU_PREP_MAX = 240;

/** One item as members see it (the shared MenuView; the portal "Bar & Café" and "Preview as member"). */
export type MenuViewItem = {
  id: string;
  name: string;
  description: string | null;
  /** 1200 px photo and its 400 px thumbnail; both null → the category icon. */
  photoUrl: string | null;
  thumbUrl: string | null;
  /** Null for drinks (and for food whose type has not been set yet): no symbol. */
  foodType: FoodTypeValue | null;
  isAlcoholic: boolean;
  allergens: AllergenValue[];
  prepMinutes: number | null;
  /** What this viewer pays for one (paise) — the pricing engine's price with the viewer's discount. */
  price: number;
  /** The base price when it differs from `price` (shown struck through); otherwise null. */
  basePrice: number | null;
  /** The engine's explanation, e.g. "Silver member · 10% bar discount". */
  priceNote: string | null;
};

export type MenuViewCategory = {
  id: string;
  name: string;
  description: string | null;
  icon: MenuIconName | string;
  items: MenuViewItem[];
};
