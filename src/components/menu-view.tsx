"use client";
// v5 §1.1 MN-4 / §1.2: the bar & café menu exactly as members see it — one presentational component shared by the
// member portal "Bar & Café" (ORDER) and the Menu screen's "Preview as member" (MENU). Data comes from the server
// (services/menu.ts memberMenuView: ACTIVE + available items of active categories, priced by the pricing engine for
// the viewer, alcohol already removed for Juniors / under-18). This component only renders and searches.
import { useMemo, useState, type ReactNode } from "react";
import {
  Beer, CakeSlice, Clock, Coffee, Cookie, Croissant, CupSoda, Drumstick, Egg, Fish, GlassWater, IceCreamCone, Martini, Milk,
  Citrus, Pizza, Popcorn, Salad, Sandwich, Search, Soup, UtensilsCrossed, Wine, type LucideIcon,
} from "lucide-react";
import { Input } from "./ui/input";
import { cn } from "./ui/cn";
import { formatINR } from "@/lib/money";
import {
  ALLERGEN_LABEL, FOOD_TYPE_COLOUR, FOOD_TYPE_LABEL, type FoodTypeValue, type MenuIconName, type MenuViewCategory, type MenuViewItem,
} from "@/lib/menu";

export type { MenuViewCategory, MenuViewItem } from "@/lib/menu";

const ICONS: Record<MenuIconName, LucideIcon> = {
  UtensilsCrossed, Sandwich, Pizza, Salad, Soup, Drumstick, Fish, Egg, Croissant, CakeSlice, IceCreamCone, Cookie, Popcorn,
  Coffee, CupSoda, GlassWater, Milk, Citrus, Beer, Wine, Martini,
};

/** A category's icon by name (falls back to the knife and fork). */
export function MenuIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name as MenuIconName] ?? UtensilsCrossed;
  return <Icon className={className} aria-hidden strokeWidth={1.5} />;
}

/** The standard food symbol: a square outline with a filled dot — green veg, red non-veg, brown egg. */
export function FoodTypeSymbol({ type, size = 14, className }: { type: FoodTypeValue | null | undefined; size?: number; className?: string }) {
  if (!type) return null;
  const c = FOOD_TYPE_COLOUR[type];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={FOOD_TYPE_LABEL[type]} className={cn("inline-block shrink-0", className)} data-food-type={type}>
      <title>{FOOD_TYPE_LABEL[type]}</title>
      <rect x="1" y="1" width="14" height="14" rx="2" fill="#fff" stroke={c} strokeWidth="1.6" />
      <circle cx="8" cy="8" r="3.6" fill={c} />
    </svg>
  );
}

/** The item's photo (400 px thumbnail), or its category's icon when it has none — never a stock photo. */
export function MenuItemImage({ url, icon, name, className }: { url: string | null; icon: string; name: string; className?: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- the club's own uploaded photo
    return <img src={url} alt={name} loading="lazy" className={cn("rounded-lg bg-muted object-cover", className)} />;
  }
  return (
    <div role="img" aria-label={`${name} (no photo)`} className={cn("flex items-center justify-center rounded-lg bg-muted text-muted-foreground", className)}>
      <MenuIcon name={icon} className="h-1/2 w-1/2" />
    </div>
  );
}

function ItemRow({ item, icon, action }: { item: MenuViewItem; icon: string; action?: ReactNode }) {
  return (
    <li className="flex gap-3 py-3" data-testid="menu-view-item" data-item-id={item.id}>
      <MenuItemImage url={item.thumbUrl} icon={icon} name={item.name} className="h-20 w-20 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 font-semibold leading-tight">
            <FoodTypeSymbol type={item.foodType} />
            <span className="break-words">{item.name}</span>
            {item.isAlcoholic ? <Wine className="h-3.5 w-3.5 shrink-0 text-purple-700" aria-label="Contains alcohol" /> : null}
          </p>
          <p className="shrink-0 text-right">
            {item.basePrice !== null && item.basePrice !== item.price ? (
              <span className="mr-1 text-xs text-muted-foreground line-through">{formatINR(item.basePrice)}</span>
            ) : null}
            <span className="font-semibold tabular" data-testid="menu-view-price">{formatINR(item.price)}</span>
          </p>
        </div>
        {item.description ? <p className="text-sm text-muted-foreground">{item.description}</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {item.prepMinutes ? <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden /> about {item.prepMinutes} min</span> : null}
          {item.allergens.length ? <span>Contains: {item.allergens.map((a) => ALLERGEN_LABEL[a]).join(", ")}</span> : null}
          {item.priceNote ? <span>{item.priceNote}</span> : null}
        </div>
        {action ? <div className="mt-1 flex justify-end">{action}</div> : null}
      </div>
    </li>
  );
}

/**
 * The menu grouped by category, with search. `renderAction` adds a per-item control (the portal's "Add"); without it
 * the menu is read-only (the preview and anywhere else that only shows it).
 */
export function MenuView({
  categories,
  renderAction,
  searchable = true,
  header,
  emptyText = "Nothing on the menu right now.",
}: {
  categories: MenuViewCategory[];
  renderAction?: (item: MenuViewItem) => ReactNode;
  searchable?: boolean;
  header?: ReactNode;
  emptyText?: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return categories
      .map((c) => ({
        ...c,
        items: t ? c.items.filter((i) => i.name.toLowerCase().includes(t) || (i.description ?? "").toLowerCase().includes(t) || c.name.toLowerCase().includes(t)) : c.items,
      }))
      .filter((c) => c.items.length);
  }, [categories, q]);
  const total = categories.reduce((a, c) => a + c.items.length, 0);
  return (
    <div className="flex flex-col gap-3" data-testid="menu-view">
      {header}
      {searchable && total ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the menu" aria-label="Search the menu" data-testid="menu-search" />
        </div>
      ) : null}
      {shown.length > 1 ? (
        <nav aria-label="Menu categories" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {shown.map((c) => (
            <a key={c.id} href={`#menu-cat-${c.id}`} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-sm hover:bg-secondary">
              <MenuIcon name={c.icon} className="h-4 w-4" />
              {c.name}
            </a>
          ))}
        </nav>
      ) : null}
      {!total ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : !shown.length ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing matches “{q.trim()}”.</p>
      ) : (
        shown.map((c) => (
          <section key={c.id} id={`menu-cat-${c.id}`} aria-labelledby={`menu-cat-h-${c.id}`} className="scroll-mt-20 rounded-xl border bg-card px-4 py-3" data-testid="menu-view-category">
            <h2 id={`menu-cat-h-${c.id}`} className="flex items-center gap-2 font-display text-lg font-bold">
              <MenuIcon name={c.icon} className="h-5 w-5 text-muted-foreground" />
              {c.name}
            </h2>
            {c.description ? <p className="text-sm text-muted-foreground">{c.description}</p> : null}
            <ul className="divide-y">
              {c.items.map((i) => <ItemRow key={i.id} item={i} icon={c.icon} action={renderAction?.(i)} />)}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
