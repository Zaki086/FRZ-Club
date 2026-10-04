"use client";
// v6 URL-2: the public address every link is built from (APP_URL), on the Settings status card.
import { useApi } from "@/components/api";
import { Badge } from "@/components/ui/badge";

type PublicUrl = { url: string; ok: boolean; reason: string };

export function PublicUrlStatus() {
  const s = useApi<PublicUrl>("/api/capabilities/public-url");
  if (!s.data) return null;
  const d = s.data;
  return (
    <div className="flex items-start justify-between gap-3 border-b pb-2 text-sm" data-testid="public-url-status">
      <div className="min-w-0">
        <p className="font-medium">Public address</p>
        <p className="break-all font-mono text-xs" data-testid="public-url">{d.url || "Not set"}</p>
        <p className="text-xs text-muted-foreground">{d.reason}</p>
      </div>
      <Badge tone={d.ok ? "green" : "red"}>{d.ok ? "OK" : "Fix"}</Badge>
    </div>
  );
}
