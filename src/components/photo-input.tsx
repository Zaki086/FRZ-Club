"use client";
import { useRef } from "react";
import { Camera, X } from "lucide-react";
import { Button } from "./ui/button";

/** Optional member photo (R-01): resized in the browser to a small JPEG data URL. */
export function PhotoInput({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-3">
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="Member photo" className="h-20 w-20 rounded-full object-cover ring-2 ring-border" />
      ) : (
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Camera className="h-6 w-6" />
        </div>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            const size = 256;
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            const s = Math.min(img.width, img.height);
            ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
            onChange(canvas.toDataURL("image/jpeg", 0.82));
            URL.revokeObjectURL(url);
          };
          img.src = url;
        }}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => ref.current?.click()}>
        <Camera className="h-4 w-4" /> {value ? "Retake" : "Add photo"}
      </Button>
      {value ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          <X className="h-4 w-4" /> Remove
        </Button>
      ) : null}
    </div>
  );
}
