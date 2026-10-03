import Link from "next/link";
import { ShieldX } from "lucide-react";

export default function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <ShieldX className="h-12 w-12 text-destructive" />
      <h1 className="text-3xl font-bold">403 — Forbidden</h1>
      <p className="max-w-md text-muted-foreground">
        Your role does not have access to this screen. The server enforces this for every action, not just this page.
      </p>
      <Link href="/app" className="text-primary underline">
        Back to your dashboard
      </Link>
    </div>
  );
}
