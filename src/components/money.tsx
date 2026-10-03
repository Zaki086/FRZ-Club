import { formatINR } from "@/lib/money";
import { cn } from "./ui/cn";

export function Money({ paise, className }: { paise: number; className?: string }) {
  return <span className={cn("tabular", paise < 0 && "text-destructive", className)}>{formatINR(paise)}</span>;
}
