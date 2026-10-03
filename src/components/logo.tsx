// v3 design port: the reference's logo — an optic-yellow disc and a display-face wordmark — built from the
// club's own name (settings), never a fixed brand.
import { clubInitials } from "@/lib/codes";
import { cn } from "./ui/cn";

export function LogoMark({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent font-display text-base font-bold text-accent-foreground", className)}>
      {clubInitials(name)}
    </span>
  );
}

export function Logo({ name, suffix, light }: { name: string; suffix?: string; light?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <LogoMark name={name} />
      <span className={cn("truncate font-display text-xl font-bold uppercase leading-none tracking-wide", light ? "text-ink-foreground" : "text-foreground")}>
        {name}
        {suffix ? <span className={cn("ml-1.5 font-sans text-[0.65rem] tracking-[0.25em]", light ? "text-ink-foreground/70" : "text-muted-foreground")}>{suffix}</span> : null}
      </span>
    </span>
  );
}
