import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { requireUser, STAFF_ROLES } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { printableMenu } from "@/server/services/menu";
import { FoodTypeSymbol, MenuIcon } from "@/components/menu-view";
import { LogoMark } from "@/components/logo";
import { PrintButton } from "@/components/print-button";
import { ALLERGEN_LABEL, FOOD_TYPE_LABEL, FOOD_TYPES } from "@/lib/menu";
import { formatINR } from "@/lib/money";

export const metadata: Metadata = { title: "Menu (print)" };
export const dynamic = "force-dynamic";

/** v5 MN-5: the A4 printable menu — categories, items, food-type symbols, prices, the club's name and logo. */
export default async function PrintMenuPage() {
  const actor = await requireUser(STAFF_ROLES);
  if (!can(actor, "menu.manage")) forbidden();
  const m = await printableMenu(actor);
  const name = m.club.name || "Bar & café";
  return (
    <div className="a4-menu mx-auto bg-white text-black">
      <style>{`@page { size: A4; margin: 12mm } .a4-menu { width: 186mm; padding: 6mm 0; font-size: 11pt } .a4-menu .cats { columns: 2; column-gap: 10mm } .a4-menu section { break-inside: avoid; margin-bottom: 6mm } @media screen { .a4-menu { margin-top: 1rem; padding: 10mm; border: 1px dashed #999; width: 210mm } }`}</style>
      <div className="no-print mb-4 flex justify-end"><PrintButton /></div>
      <header className="mb-6 flex items-center gap-4 border-b-2 border-black pb-4">
        {m.club.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the club's own logo (settings)
          <img src={m.club.logoUrl} alt={`${name} logo`} className="h-16 w-16 object-contain" />
        ) : (
          <LogoMark name={name} className="h-16 w-16 text-2xl" />
        )}
        <div>
          <h1 className="font-display text-3xl font-bold uppercase tracking-wide">{name}</h1>
          <p className="text-sm">Bar &amp; café menu</p>
        </div>
      </header>
      {m.categories.length ? (
        <div className="cats">
          {m.categories.map((c) => (
            <section key={c.id}>
              <h2 className="mb-1 flex items-center gap-2 border-b border-black/40 pb-1 text-lg font-bold uppercase tracking-wide">
                <MenuIcon name={c.icon} className="h-5 w-5" />
                {c.name}
              </h2>
              {c.description ? <p className="mb-1 text-[9pt] italic">{c.description}</p> : null}
              <ul>
                {c.items.map((i) => (
                  <li key={i.id} className="py-1">
                    <div className="flex items-baseline gap-2">
                      <FoodTypeSymbol type={i.foodType} size={12} />
                      <span className="font-semibold">{i.name}{i.isAlcoholic ? " *" : ""}</span>
                      <span className="flex-1 border-b border-dotted border-black/40" aria-hidden />
                      <span className="font-semibold tabular-nums">{formatINR(i.price)}</span>
                    </div>
                    {i.description ? <p className="pl-5 text-[9pt]">{i.description}</p> : null}
                    {i.allergens.length ? <p className="pl-5 text-[8pt] italic">Contains: {i.allergens.map((a) => ALLERGEN_LABEL[a]).join(", ")}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center">The menu has no active items yet.</p>
      )}
      <footer className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-black/40 pt-3 text-[9pt]">
        {FOOD_TYPES.map((t) => <span key={t} className="inline-flex items-center gap-1"><FoodTypeSymbol type={t} size={11} /> {FOOD_TYPE_LABEL[t]}</span>)}
        {m.hasAlcohol ? <span>* Contains alcohol — served to adults (18+) only.</span> : null}
        <span>Prices in ₹, inclusive of applicable taxes. Members&apos; discounts are applied on the bill.</span>
        {m.club.address || m.club.phone ? <span className="w-full">{[m.club.address, m.club.phone].filter(Boolean).join(" · ")}</span> : null}
      </footer>
    </div>
  );
}
