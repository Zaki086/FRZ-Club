"use client";
// v6 UI-2 — the ⓘ popover. Help text lives only here, and only at the six places where it prevents a mistake
// (INFO_TIP_PLACES); `place` is required so a new use has to name one of them. A button with an aria-label opens a
// small note next to it (disclosure pattern: aria-expanded + aria-controls); Escape, a click outside or moving focus
// away closes it, and Escape returns focus to the button. Inside a dialog, Escape closes only the note, not the dialog.
import { Info } from "lucide-react";
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "./ui/cn";

export const INFO_TIP_PLACES = [
  "blind-count",
  "variance-tolerance",
  "refund-identity",
  "price-book-precedence",
  "whatsapp-opt-in",
  "send-all-preflight",
] as const;
export type InfoTipPlace = (typeof INFO_TIP_PLACES)[number];

export type InfoTipEvent = "toggle" | "escape" | "outside" | "blur-out" | "open";
/** The open/closed decision, kept pure so it is unit-tested without a DOM. */
export function infoTipNext(open: boolean, event: InfoTipEvent): boolean {
  if (event === "toggle") return !open;
  if (event === "open") return true;
  return false;
}

/**
 * A form field whose label carries an ⓘ (UI-2). The ⓘ sits outside the <label>, so the input's accessible name stays
 * exactly the label text; the single child control gets the label's `htmlFor` id.
 */
export function InfoField({
  label,
  place,
  infoLabel,
  info,
  children,
  className,
}: {
  label: string;
  place: InfoTipPlace;
  infoLabel: string;
  info: ReactNode;
  children: ReactElement<{ id?: string }>;
  className?: string;
}) {
  const auto = useId();
  const id = children.props.id ?? auto;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="flex items-center gap-1">
        <label htmlFor={id} className="text-sm font-semibold text-foreground">{label}</label>
        <InfoTip place={place} label={infoLabel}>{info}</InfoTip>
      </span>
      {isValidElement(children) ? cloneElement(children, { id }) : children}
    </div>
  );
}

export function InfoTip({
  label,
  place,
  children,
  align = "start",
  defaultOpen = false,
  className,
}: {
  /** The button's accessible name, e.g. "About the blind count". */
  label: string;
  place: InfoTipPlace;
  children: ReactNode;
  align?: "start" | "end";
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Window capture runs before a surrounding Radix dialog's document listener, so Escape closes only this note.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen((o) => infoTipNext(o, "escape"));
      btn.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen((o) => infoTipNext(o, "outside"));
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span
      ref={wrap}
      className={cn("relative inline-flex align-middle", className)}
      data-info-tip={place}
      onBlur={(e) => {
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen((o) => infoTipNext(o, "blur-out"));
      }}
    >
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => infoTipNext(o, "toggle"))}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-4 w-4" aria-hidden />
      </button>
      <span
        id={id}
        role="note"
        hidden={!open}
        className={cn(
          "absolute top-full z-[60] mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-3 text-left text-xs font-normal leading-relaxed text-foreground shadow-lift",
          align === "end" ? "right-0" : "left-0",
        )}
      >
        {children}
      </span>
    </span>
  );
}
