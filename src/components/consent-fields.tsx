"use client";
// Public forms (completion pass §7): an explicit, unticked consent box (DPDP) and a honeypot field that people
// never see (bots fill it in and are turned away).
export function ConsentFields({ consent, onConsent, website, onWebsite, clubName }: { consent: boolean; onConsent: (v: boolean) => void; website: string; onWebsite: (v: string) => void; clubName?: string }) {
  return (
    <>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => onConsent(e.target.checked)} required data-testid="consent" />
        <span>
          I agree that {clubName || "the club"} may store these details and contact me about this request. They are not shared or used for anything
          else, and I can ask for them to be deleted (<a className="underline" href="/privacy" target="_blank" rel="noreferrer">privacy notice</a>).
        </span>
      </label>
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Leave this field empty
          <input tabIndex={-1} autoComplete="off" name="website" value={website} onChange={(e) => onWebsite(e.target.value)} />
        </label>
      </div>
    </>
  );
}
