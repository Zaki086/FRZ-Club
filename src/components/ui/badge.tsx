import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

const badgeVariants = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-muted text-foreground",
      green: "bg-green-100 text-green-800",
      amber: "bg-amber-100 text-amber-800",
      red: "bg-red-100 text-red-800",
      blue: "bg-blue-100 text-blue-800",
      purple: "bg-purple-100 text-purple-800",
      gold: "bg-yellow-100 text-yellow-900 ring-1 ring-yellow-400",
      silver: "bg-slate-200 text-slate-800 ring-1 ring-slate-400",
      junior: "bg-sky-100 text-sky-800 ring-1 ring-sky-400",
      dark: "bg-slate-800 text-white",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
