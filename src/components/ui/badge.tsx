import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

// v3 design port: status chips are a dot + text on a tinted background (colour is never the only signal).
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        green: "bg-success/12 text-success-text",
        amber: "bg-warning/25 text-warning-foreground",
        red: "bg-destructive/12 text-destructive",
        blue: "bg-junior/10 text-junior",
        purple: "bg-purple-100 text-purple-800",
        gold: "bg-gold/12 text-gold ring-1 ring-gold/40",
        silver: "bg-silver/10 text-silver ring-1 ring-silver/40",
        junior: "bg-junior/10 text-junior ring-1 ring-junior/40",
        dark: "bg-ink text-ink-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
