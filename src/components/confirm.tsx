"use client";
import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTrigger } from "./ui/dialog";
import { Button, type ButtonProps } from "./ui/button";
import { Textarea } from "./ui/input";
import { RejectionBanner } from "./states";
import { ApiError } from "./api";

/** Every destructive action asks for confirmation; a reason box is shown when the rule needs one. */
export function ConfirmButton({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  variant = "destructive",
  requireReason,
  reasonLabel = "Reason",
  onConfirm,
  size,
  disabled,
  children,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: ButtonProps["variant"];
  requireReason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<unknown>;
  size?: ButtonProps["size"];
  disabled?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setError(null);
          setReason("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant === "destructive" ? "outline" : variant} size={size ?? "sm"} disabled={disabled}>
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent title={title} description={description}>
        <div className="flex flex-col gap-3">
          {children}
          {requireReason ? (
            <label className="flex flex-col gap-1 text-sm">
              {reasonLabel}
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
          ) : null}
          <RejectionBanner error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Back
            </Button>
            <Button
              variant={variant}
              disabled={busy || (requireReason && reason.trim().length < 3)}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onConfirm(reason.trim());
                  setOpen(false);
                  setReason("");
                } catch (e) {
                  setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Working…" : confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
