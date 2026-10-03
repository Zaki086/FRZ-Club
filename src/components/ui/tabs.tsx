"use client";
import * as T from "@radix-ui/react-tabs";
import { cn } from "./cn";

export const Tabs = T.Root;
export function TabsList({ className, ...props }: T.TabsListProps) {
  return <T.List className={cn("inline-flex flex-wrap gap-1 rounded-full bg-secondary p-1", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: T.TabsTriggerProps) {
  return (
    <T.Trigger
      className={cn(
        "rounded-full px-3.5 py-1.5 text-sm font-semibold text-secondary-foreground/80 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground cursor-pointer",
        className,
      )}
      {...props}
    />
  );
}
export const TabsContent = T.Content;
