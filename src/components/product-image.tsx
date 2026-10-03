// Completion pass §9: the product's uploaded photo, or a clear icon for its category — never a stock photo.
import { Backpack, CircleDot, Footprints, Package, Shirt, Trophy, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "./ui/cn";

const ICON: Record<string, LucideIcon> = { RACKETS: Trophy, BALLS: CircleDot, SHOES: Footprints, ACCESSORIES: Backpack, APPAREL: Shirt, SERVICES: Wrench };

export function ProductImage({ url, category, name, className }: { url: string | null | undefined; category: string; name: string; className?: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name} loading="lazy" className={cn("rounded-md bg-muted object-cover", className)} />;
  }
  const Icon = ICON[category] ?? Package;
  return (
    <div role="img" aria-label={`${name} (no photo yet)`} className={cn("flex items-center justify-center rounded-md bg-muted text-muted-foreground", className)}>
      <Icon className="h-1/2 w-1/2" strokeWidth={1.5} />
    </div>
  );
}
