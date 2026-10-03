"use client";
// Completion pass §6: staff issue a one-hour password reset link and hand it over (copy, or open WhatsApp).
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { api, ApiError } from "./api";
import { Button } from "./ui/button";

export function ResetLinkButton({ url, label = "Password reset link" }: { url: string; label?: string }) {
  const [link, setLink] = useState<{ full: string; phone: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={async () => {
          setError(null);
          try {
            const r = await api<{ link: string; phone: string; name: string }>(url, { body: {} });
            setLink({ full: `${window.location.origin}${r.link}`, phone: r.phone, name: r.name });
          } catch (e) {
            setError(e instanceof ApiError ? e.message : String(e));
          }
        }}
      >
        <KeyRound className="h-4 w-4" /> {label}
      </Button>
      {link ? (
        <span className="max-w-xs rounded border bg-muted/50 p-2 text-xs" data-testid="reset-link">
          Valid for 1 hour, single use: <code className="break-all">{link.full}</code>
          <a
            className="mt-1 block text-primary underline"
            target="_blank"
            rel="noreferrer"
            href={`https://wa.me/91${link.phone.slice(-10)}?text=${encodeURIComponent(`Hi ${link.name}, set a new password here (valid for 1 hour): ${link.full}`)}`}
          >
            Send on WhatsApp
          </a>
        </span>
      ) : null}
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
