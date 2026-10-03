"use client";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { api } from "./api";
import { Button } from "./ui/button";

export function LogoutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await api("/api/auth/logout", { body: {} });
        router.push("/login");
        router.refresh();
      }}
    >
      <LogOut className="h-4 w-4" /> Log out
    </Button>
  );
}
